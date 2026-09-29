'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useChat } from '@ai-sdk/react';
import { APICallError, isToolUIPart, type ToolUIPart } from 'ai';
import { ASK_MODELS, type AskModelId } from '@/lib/ask/models';
import type { AskUIMessage } from '@/lib/ask/conversations';
import { EXAMPLE_QUESTIONS } from '@/lib/ask/examples';
import {
  BUSY_MESSAGE, CHAT_CAP_MESSAGE, CUT_OFF_MESSAGE, FAILED_MESSAGE, NO_ANSWER_MESSAGE, RAN_OUT_MESSAGE, STOPPED_LINE, TOO_LONG_TURN_MESSAGE,
} from '@/lib/ask/messages';
import { describeChatError } from '@/lib/ask/clientErrors';
import { createAskTransport } from '@/lib/ask/transport';
import { AnswerMarkdown } from './AnswerMarkdown';
import { Composer } from './Composer';
import { ModelPicker } from './ModelPicker';
import { ToolActivity } from './ToolActivity';

export interface OpenConversation {
  id: string; model: AskModelId; messageCount: number; messages: AskUIMessage[];
  /**
   * Server-computed per request (Task 9 fix round 2, item 1 / N1) — never a client-side clock.
   * A client-side "is this recent" comparison, frozen at Thread's own mount time, could read a
   * lock that had already gone stale server-side as still "busy" forever; page.tsx recomputes this
   * fresh on every request instead (it is force-dynamic), so a plain `router.refresh()` is always
   * enough to pick up the true current state.
   */
  inFlight: boolean;
}

/** How long the server may still be settling/saving a stopped turn under the lock (Task 8 review's "Notes for later tasks"): an immediate resend inside this window can get a 409 busy. Task 9 D6. */
const STOP_COOLDOWN_MS = 2000;
/** On an aborted first send, delay the URL move so the server's save of the partial answer lands before the page reloads the chat (Task 9 D7). */
const ABORT_NAV_DELAY_MS = 1500;
/** While `open.inFlight`, how often to ask the server for fresh data (item 1 / N1) — bounded by the lock's own server-side expiry, so this can never poll forever. */
const BUSY_REFRESH_MS = 4000;

function hasVisibleText(m: AskUIMessage): boolean {
  return m.parts.some((p) => p.type === 'text' && p.text.trim().length > 0);
}

/**
 * One status line per assistant message (Task 9 fix round, item 1; `isLast` added in fix round 2,
 * item 5). `stopReason`/`finishReason` are live-only, set as the turn streams and never persisted
 * (lib/ask/conversations.ts's `storedToUiMessage` reconstructs only `{ status }`), so a Stop the
 * member's own browser triggered is also tracked locally in `stoppedIds` (set in onFinish) — the
 * browser disconnects on Stop and never receives the server's own abort part. Order matters: a
 * deadline stop, then any stop, then a failure, then the two live-only finish reasons, then the
 * "no text produced" heuristic (kept for a reload, where finishReason/stopReason are gone) — but
 * never that last one for the message currently streaming (no text yet just means mid-answer), and
 * the chat-status-is-'error' suppression applies only to the LAST message, not every no-text
 * message in the chat — an older, genuinely ran-out message earlier on must keep its own line even
 * while a later turn is the one showing the alert (fix round 2, item 5 minor).
 */
function statusLineFor(m: AskUIMessage, isLive: boolean, isLast: boolean, chatStatus: string, stoppedIds: ReadonlySet<string>): string | null {
  const meta = m.metadata;
  if (meta?.stopReason === 'deadline') return TOO_LONG_TURN_MESSAGE;
  if (meta?.stopReason === 'user' || meta?.status === 'stopped' || stoppedIds.has(m.id)) return STOPPED_LINE;
  if (meta?.status === 'failed') return FAILED_MESSAGE;
  if (meta?.finishReason === 'length') return CUT_OFF_MESSAGE;
  if (meta?.finishReason === 'tool-calls') return RAN_OUT_MESSAGE;
  if (!hasVisibleText(m) && !isLive && !(isLast && chatStatus === 'error')) return RAN_OUT_MESSAGE;
  return null;
}

/**
 * Spec §11.3. One hook instance per chat (AskAi keys this component by the open chat's id, plus an
 * epoch that advances only on a busy→idle transition — fix round 2 item 1 / round-3 B1). The
 * transport (lib/ask/transport.ts) sends only the new message text plus the chat id (and the model
 * on a first send) — the server loads history itself (spec §13). A first send learns the new
 * chat's id from the assistant message metadata and moves the URL there.
 *
 * `draft` is owned by AskAi, not this component (Task 9 fix round, item 8 / M1): a first send
 * changes the URL to `?c=<id>`, and since Thread is keyed by the open chat's id, that remounts it
 * — anything the member had queued mid-answer would otherwise vanish.
 */
export function Thread({ open, defaultModel, cantSendReason, atCap, appOrigin, draft, onDraftChange }: {
  open: OpenConversation | null; defaultModel: AskModelId;
  /** The server-computed reason (no balance / chat full), or null — the cap case is decided below, since only this component knows about a chat id already learned from the stream (item 6). */
  cantSendReason: string | null;
  atCap: boolean; appOrigin: string;
  draft: string; onDraftChange: (v: string) => void;
}) {
  const router = useRouter();
  const [model, setModel] = useState<AskModelId>(open?.model ?? defaultModel);
  const [cooldown, setCooldown] = useState(false);
  const [stoppedIds, setStoppedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [stoppedBeforeAnswer, setStoppedBeforeAnswer] = useState(false);
  // item 2 / N2: once onFinish has learned a first send's new chat id, Send stays disabled until
  // this component unmounts (which happens when the URL replace lands and AskAi re-renders with
  // `open` set) — otherwise a quick second send in that window is racing the page change itself.
  const [leaving, setLeaving] = useState(false);
  const [transport] = useState(() => createAskTransport());
  // Delayed navigation after unmount (item 2): the member can leave the page within the 1.5s
  // ABORT_NAV_DELAY_MS window (useChat's own unmount cleanup calls stop(), which fires onFinish
  // with isAbort), and without this guard the pending router.replace would pull them back to the
  // chat they just left. The effect body only assigns a ref and its cleanup only clears a ref and
  // a timer — no state, so this is not the setState-in-effect the lint rule forbids.
  const alive = useRef(true);
  const navTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // M2 (round-3): a first-send setup failure that carries a conversationId (item 4) fires BOTH
  // onError (which navigates there directly) and onFinish (with isError: true, which would
  // otherwise also router.refresh() — a second, redundant navigation on the very same failure).
  // Set by onError just before it navigates, read and cleared by onFinish's isError branch.
  const navigatedByErrorRef = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (navTimer.current !== null) clearTimeout(navTimer.current);
    };
  }, []);
  const { messages, sendMessage, status, stop, error, setMessages } = useChat<AskUIMessage>({
    id: open?.id ?? 'new',
    messages: open?.messages ?? [],
    transport,
    // item 10 M7: coalesces rapid text-delta re-renders during streaming. `@ai-sdk/react`
    // 4.0.121 exposes this as `throttle` — `experimental_throttle` still works but is its
    // deprecated alias (see node_modules/@ai-sdk/react/dist/index.d.ts), so `throttle` is used.
    throttle: 50,
    onFinish: ({ message, messages: finishedMessages, isAbort, isError }) => {
      // item 3 (N3): `message` is always a fresh assistant-shaped shell, even when Stop landed
      // before anything was ever shown — whether its id made it into the visible `messages` list
      // (the second onFinish argument) is what actually distinguishes "stopped with something
      // shown" from "stopped before any answer", not `message.role` (always 'assistant').
      if (isError) {
        // M2: onError already navigated for this exact failure — one navigation, not two.
        if (navigatedByErrorRef.current) navigatedByErrorRef.current = false;
        else router.refresh();
        return;
      }
      if (isAbort) {
        if (finishedMessages.some((m) => m.id === message.id)) setStoppedIds((prev) => new Set(prev).add(message.id));
        else setStoppedBeforeAnswer(true);
      }
      // M1 (round-3): a recovery resend after a first-send error carries the chat id in the
      // REQUEST (it is already known — see `knownChatId` below), not in `startMetadata`: the
      // server only attaches that to a message it is CREATING the conversation for, and this
      // resend's conversationId is already non-null, so the server treats it as an ordinary
      // follow-up and this message's own metadata carries no conversationId. Falling back to the
      // id an earlier (errored) attempt already put in `finishedMessages` still moves the URL once
      // this one succeeds. Read from `finishedMessages` (this callback's own argument) rather than
      // the outer `streamedCid` below so this does not depend on forward-referencing it.
      const priorCid = finishedMessages.find((m) => m.metadata?.conversationId)?.metadata?.conversationId;
      const cid = message.metadata?.conversationId ?? (open ? undefined : priorCid);
      if (!open && cid) setLeaving(true); // item 2 (N2)
      const moveOn = () => {
        if (!alive.current) return;
        // item 10 M4: replace OR refresh, never both — a force-dynamic route already fetches
        // fresh data for the new URL a replace navigates to.
        if (!open && cid) router.replace(`/ask?c=${encodeURIComponent(cid)}`);
        else router.refresh();
      };
      if (isAbort) navTimer.current = setTimeout(moveOn, ABORT_NAV_DELAY_MS);
      else moveOn();
    },
    onError: (err) => {
      if (!APICallError.isInstance(err) || typeof err.statusCode !== 'number') return;
      let refusedConversationId: string | null = null;
      try {
        const body = JSON.parse(err.message) as { conversationId?: unknown };
        if (typeof body.conversationId === 'string') refusedConversationId = body.conversationId;
      } catch {}
      // item 4: a first-send setup failure after the chat and its question were already stored
      // carries the new chat's id — move there (the question is already saved in it) instead of
      // stripping the optimistic bubble below, which would let a resend create a second, orphaned
      // chat (conversationId: null again, since `open` is still null here).
      if (!open && refusedConversationId) {
        setLeaving(true); // M2: hold Send here too — the same page change is about to happen
        navigatedByErrorRef.current = true; // M2: tell onFinish's isError branch to skip its refresh
        router.replace(`/ask?c=${encodeURIComponent(refusedConversationId)}`);
        return;
      }
      // item 10 M6, refined by item 5 minors: an HTTP refusal (busy/full/no-balance/...) after the
      // optimistic user message was added. The trailing message is read inside the updater (not
      // the render closure, which can be stale by the time this fires) so the decision always sees
      // the current messages. The refused text is restored into the draft — and the bubble removed
      // — only when the draft is empty; if the member already typed something else meanwhile, the
      // bubble stays and nothing is overwritten or lost.
      // M5 (round-3 nit): calling onDraftChange (a different component's state setter) from
      // inside this updater relies on `@ai-sdk/react` invoking it once, synchronously, when
      // setMessages is called — not on React's own setState queue, which may defer or re-invoke an
      // updater and would make this an impure side effect inside it.
      setMessages((msgs) => {
        const trailing = msgs[msgs.length - 1];
        if (trailing?.role !== 'user' || draft !== '') return msgs;
        onDraftChange(trailing.parts.map((p) => (p.type === 'text' ? p.text : '')).join(''));
        return msgs.slice(0, -1);
      });
    },
  });
  const streaming = status === 'submitted' || status === 'streaming';
  // Busy-to-idle (item 1 / N1): while the server says this chat is genuinely locked elsewhere,
  // poll for the saved answer instead of leaving the member looking at a static line forever —
  // bounded by the lock's own server-side expiry. router.refresh() is not a state update, so this
  // effect body (start/clear an interval) is exactly the exception the hard rules note allows.
  // Skips while `streaming` (nits round): after a mid-turn refresh reports this tab's OWN lock as
  // busy, polling would otherwise re-render the whole page every 4s for the rest of the member's
  // own turn; worse, a poll landing in the gap between another turn releasing the lock and this
  // tab's own send acquiring it could flip busy->idle and remount mid-send, aborting it. The
  // post-turn refresh (onFinish's moveOn) still performs the real busy->idle remount once this
  // turn ends, so nothing is lost by not polling while it's this tab doing the streaming.
  useEffect(() => {
    if (!open?.inFlight || streaming) return;
    const id = setInterval(() => {
      // M4 (round-3): skip the network round trip while the tab is in the background — nothing is
      // shown to refresh for, and the interval resumes refreshing as soon as the tab is visible
      // again (no separate visibilitychange listener needed — the next tick just checks afresh).
      if (typeof document !== 'undefined' && document.hidden) return;
      router.refresh();
    }, BUSY_REFRESH_MS);
    return () => clearInterval(id);
  }, [open?.inFlight, streaming, router]);
  // The chat id learned from a stream chunk before `open` (the server-rendered prop) catches up —
  // used both to send a follow-up under the right id (item 3 / N3's neighbouring fix) and, below,
  // to decide the chat-cap reason and the "Open this chat" recovery link (item 6).
  const streamedCid = messages.find((m) => m.metadata?.conversationId)?.metadata?.conversationId ?? null;
  const knownChatId = open?.id ?? streamedCid;
  /**
   * item 6 (spec re-review): the cap message only makes sense when no chat id is known at all —
   * once one is (`open`, or a first send whose stream already assigned one), the member is
   * effectively already in a chat, so showing "you have 5 chats" while they are looking at their
   * (about to be) sixth would be wrong, most visibly right after a first-send error (no navigation
   * on isError leaves `open` null even though the chat now exists).
   */
  const cantSendReasonEffective = cantSendReason ?? (knownChatId === null && atCap ? CHAT_CAP_MESSAGE : null);
  const canSend = cantSendReasonEffective === null;
  const send = (text: string) => {
    onDraftChange('');
    setStoppedBeforeAnswer(false);
    void sendMessage({ text }, { body: { conversationId: knownChatId, ...(knownChatId ? {} : { model }) } });
  };
  const onStop = () => {
    stop();
    setCooldown(true);
    setTimeout(() => setCooldown(false), STOP_COOLDOWN_MS);
  };
  const last = messages[messages.length - 1];
  /**
   * Bottom-of-thread line (item 1): only when the last message is the member's own and the chat
   * is settled — an assistant message always exists once anything at all streamed back (the
   * server's first chunk carries its id), so this only fires when NOTHING did: a Stop before the
   * first chunk, a turn still genuinely running elsewhere (`open.inFlight`), or something that
   * leaves neither (a crashed function, a failed save, a reload mid-answer). Never RAN_OUT_MESSAGE
   * here — none of those are "ran out of steps". While busy, the box and Send stay enabled (an
   * early send just gets the server's 409, handled the same as any other busy refusal above).
   */
  const showBottomLine = status === 'ready' && last?.role === 'user';
  const bottomLine = !showBottomLine ? null : stoppedBeforeAnswer ? STOPPED_LINE : open?.inFlight ? BUSY_MESSAGE : NO_ANSWER_MESSAGE;
  const empty = messages.length === 0;

  return (
    <section aria-label="Conversation" className="flex min-h-[60vh] flex-col gap-4">
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <span>Model:</span>
        {open ? <span className="rounded bg-slate-100 px-1.5 py-0.5">{ASK_MODELS.find((m) => m.id === open.model)?.label ?? open.model}</span> : <span>{ASK_MODELS.find((m) => m.id === model)?.label}</span>}
      </div>
      {empty && !open && (
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <ModelPicker value={model} onChange={setModel} disabled={streaming} />
          <h2 className="mt-4 font-semibold">Try asking</h2>
          <ul className="mt-2 space-y-1.5 text-sm">
            {EXAMPLE_QUESTIONS.map((q) => (
              <li key={q}>
                <button type="button" onClick={() => onDraftChange(q)} className="w-full rounded bg-slate-100 px-2 py-1.5 text-left hover:bg-slate-200">&ldquo;{q}&rdquo;</button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <ol className="flex flex-1 flex-col gap-3">
        {messages.map((m) => {
          const toolParts = m.parts.filter(isToolUIPart) as ToolUIPart[];
          const isLive = streaming && m === last;
          const line = m.role === 'assistant' ? statusLineFor(m, isLive, m === last, status, stoppedIds) : null;
          return (
            <li key={m.id} className={m.role === 'user' ? 'self-end' : 'self-start'}>
              <article aria-label={m.role === 'user' ? 'You' : 'Ask AI'} className={`max-w-[48rem] rounded-lg px-4 py-3 text-sm ${m.role === 'user' ? 'bg-[#0B1E3A] text-white' : 'border border-slate-200 bg-white'}`}>
                {m.role === 'assistant' && <ToolActivity parts={toolParts} streaming={isLive} />}
                {m.parts.map((p, i) => (p.type === 'text' ? (m.role === 'user' ? <p key={i} className="whitespace-pre-wrap">{p.text}</p> : <AnswerMarkdown key={i} appOrigin={appOrigin}>{p.text}</AnswerMarkdown>) : null))}
                {line && <p className={`mt-1 text-xs ${m.metadata?.status === 'failed' ? 'text-red-700' : 'text-slate-500'}`}>{line}</p>}
              </article>
            </li>
          );
        })}
        {bottomLine && <li className="text-sm text-slate-600">{bottomLine}</li>}
        {error && (
          <li role="alert" className="text-sm text-red-700">
            {describeChatError(error)}
            {/* item 6: a first send that then errored still created the chat — a manual way back
                to it, since a first-send error deliberately never auto-navigates (item 3). */}
            {!open && streamedCid && <> <Link href={`/ask?c=${encodeURIComponent(streamedCid)}`} className="underline">Open this chat</Link></>}
          </li>
        )}
      </ol>
      <Composer
        value={draft}
        onChange={onDraftChange}
        onSend={send}
        onStop={onStop}
        streaming={streaming}
        disabled={!canSend}
        sendDisabled={cooldown || leaving}
        disabledReason={cantSendReasonEffective}
      />
    </section>
  );
}
