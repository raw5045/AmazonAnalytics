'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useChat } from '@ai-sdk/react';
import { APICallError, isToolUIPart, type ToolUIPart } from 'ai';
import { ASK_LIMITS, ASK_MODELS, type AskModelId } from '@/lib/ask/models';
import type { AskUIMessage } from '@/lib/ask/conversations';
import { EXAMPLE_QUESTIONS } from '@/lib/ask/examples';
import {
  BUSY_MESSAGE, CUT_OFF_MESSAGE, FAILED_MESSAGE, NO_ANSWER_MESSAGE, RAN_OUT_MESSAGE, STOPPED_LINE, TOO_LONG_TURN_MESSAGE,
} from '@/lib/ask/messages';
import { describeChatError } from '@/lib/ask/clientErrors';
import { createAskTransport } from '@/lib/ask/transport';
import { AnswerMarkdown } from './AnswerMarkdown';
import { Composer } from './Composer';
import { ModelPicker } from './ModelPicker';
import { ToolActivity } from './ToolActivity';

export interface OpenConversation {
  id: string; model: AskModelId; messageCount: number; messages: AskUIMessage[];
  /** ISO string or null (Task 9 fix round, item 1) — page.tsx reads it off the conversation row. */
  inFlightSince: string | null;
}

/** How long the server may still be settling/saving a stopped turn under the lock (Task 8 review's "Notes for later tasks"): an immediate resend inside this window can get a 409 busy. Task 9 D6. */
const STOP_COOLDOWN_MS = 2000;
/** On an aborted first send, delay the URL move so the server's save of the partial answer lands before the page reloads the chat (Task 9 D7). */
const ABORT_NAV_DELAY_MS = 1500;

function hasVisibleText(m: AskUIMessage): boolean {
  return m.parts.some((p) => p.type === 'text' && p.text.trim().length > 0);
}

/**
 * One status line per assistant message (Task 9 fix round, item 1 — supersedes the D4 version).
 * `stopReason`/`finishReason` are live-only, set as the turn streams and never persisted
 * (lib/ask/conversations.ts's `storedToUiMessage` reconstructs only `{ status }`), so a Stop the
 * member's own browser triggered is also tracked locally in `stoppedIds` (set in onFinish) — the
 * browser disconnects on Stop and never receives the server's own abort part. Order matters: a
 * deadline stop, then any stop, then a failure, then the two live-only finish reasons, then the
 * "no text produced" heuristic (kept for a reload, where finishReason/stopReason are gone) — but
 * never that last one for the message currently streaming (no text yet just means mid-answer) or
 * while the whole chat status is 'error' (the alert already explains it; showing this too would be
 * two lines for one situation).
 */
function statusLineFor(m: AskUIMessage, isLive: boolean, chatStatus: string, stoppedIds: ReadonlySet<string>): string | null {
  const meta = m.metadata;
  if (meta?.stopReason === 'deadline') return TOO_LONG_TURN_MESSAGE;
  if (meta?.stopReason === 'user' || meta?.status === 'stopped' || stoppedIds.has(m.id)) return STOPPED_LINE;
  if (meta?.status === 'failed') return FAILED_MESSAGE;
  if (meta?.finishReason === 'length') return CUT_OFF_MESSAGE;
  if (meta?.finishReason === 'tool-calls') return RAN_OUT_MESSAGE;
  if (!hasVisibleText(m) && !isLive && chatStatus !== 'error') return RAN_OUT_MESSAGE;
  return null;
}

/**
 * Spec §11.3. One hook instance per chat (AskAi keys this component by the open chat's id). The
 * transport (lib/ask/transport.ts) sends only the new message text plus the chat id (and the model
 * on a first send) — the server loads history itself (spec §13). A first send learns the new
 * chat's id from the assistant message metadata and moves the URL there.
 *
 * `draft` is owned by AskAi, not this component (Task 9 fix round, item 8 / M1): a first send
 * changes the URL to `?c=<id>`, and since Thread is keyed by the open chat's id, that remounts it
 * — anything the member had queued mid-answer would otherwise vanish.
 */
export function Thread({ open, defaultModel, canSend, cantSendReason, appOrigin, draft, onDraftChange }: {
  open: OpenConversation | null; defaultModel: AskModelId; canSend: boolean; cantSendReason: string | null; appOrigin: string;
  draft: string; onDraftChange: (v: string) => void;
}) {
  const router = useRouter();
  const [model, setModel] = useState<AskModelId>(open?.model ?? defaultModel);
  const [cooldown, setCooldown] = useState(false);
  const [stoppedIds, setStoppedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [stoppedBeforeAnswer, setStoppedBeforeAnswer] = useState(false);
  const [transport] = useState(() => createAskTransport());
  // Captured once at mount (a lazy useState initialiser, not a direct Date.now() call in the
  // render body, which the React Compiler's purity rule rejects as an impure render call) — used
  // only for the "is inFlightSince recent" comparison below; it does not need to keep ticking.
  const [mountedAt] = useState(() => Date.now());
  // Delayed navigation after unmount (item 2): the member can leave the page within the 1.5s
  // ABORT_NAV_DELAY_MS window (useChat's own unmount cleanup calls stop(), which fires onFinish
  // with isAbort), and without this guard the pending router.replace would pull them back to the
  // chat they just left. The effect body only assigns a ref and its cleanup only clears a ref and
  // a timer — no state, so this is not the setState-in-effect the lint rule forbids.
  const alive = useRef(true);
  const navTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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
    onFinish: ({ message, isAbort, isError }) => {
      // item 3: a first-send error must not navigate away — that would replace the live error
      // line the member is looking at with a freshly (and wrongly) loaded chat.
      if (isError) { router.refresh(); return; }
      if (isAbort) {
        if (message.role === 'assistant') setStoppedIds((prev) => new Set(prev).add(message.id));
        else setStoppedBeforeAnswer(true); // Stop landed before any assistant message existed
      }
      const cid = message.metadata?.conversationId;
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
      // item 10 M6: an HTTP refusal (busy/full/no-balance/cross-site/...) carries a statusCode —
      // put the optimistic user message's text back in the draft and drop the message itself so a
      // resend does not show the same question twice. A stream-embedded error (the model itself
      // failing mid-turn) is a plain Error with no statusCode and is left alone.
      if (!APICallError.isInstance(err) || typeof err.statusCode !== 'number') return;
      const trailing = messages[messages.length - 1];
      if (trailing?.role !== 'user') return;
      onDraftChange(trailing.parts.map((p) => (p.type === 'text' ? p.text : '')).join(''));
      setMessages((msgs) => (msgs[msgs.length - 1]?.role === 'user' ? msgs.slice(0, -1) : msgs));
    },
  });
  const streaming = status === 'submitted' || status === 'streaming';
  const send = (text: string) => {
    onDraftChange('');
    setStoppedBeforeAnswer(false);
    // item 3: once the stream's start chunk has assigned a conversation id, use it even though
    // `open` (the server-rendered prop) has not caught up yet — otherwise a second send before the
    // URL replace lands (or right after an early Stop) would create a second chat.
    const cid = open?.id ?? messages.find((m) => m.metadata?.conversationId)?.metadata?.conversationId ?? null;
    void sendMessage({ text }, { body: { conversationId: cid, ...(cid ? {} : { model }) } });
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
   * first chunk, a turn still genuinely running elsewhere (a recent inFlightSince), or something
   * that leaves neither (a crashed function, a failed save, a reload mid-answer). Never
   * RAN_OUT_MESSAGE here — none of those are "ran out of steps".
   */
  const showBottomLine = status === 'ready' && last?.role === 'user';
  const recentlyInFlight = open?.inFlightSince != null && mountedAt - new Date(open.inFlightSince).getTime() < ASK_LIMITS.inFlightExpiryMinutes * 60_000;
  const bottomLine = !showBottomLine ? null : stoppedBeforeAnswer ? STOPPED_LINE : recentlyInFlight ? BUSY_MESSAGE : NO_ANSWER_MESSAGE;
  const busyInFlight = bottomLine === BUSY_MESSAGE;
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
          const line = m.role === 'assistant' ? statusLineFor(m, isLive, status, stoppedIds) : null;
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
        {error && <li role="alert" className="text-sm text-red-700">{describeChatError(error)}</li>}
      </ol>
      <Composer
        value={draft}
        onChange={onDraftChange}
        onSend={send}
        onStop={onStop}
        streaming={streaming}
        disabled={!canSend || busyInFlight}
        sendDisabled={cooldown}
        disabledReason={busyInFlight ? BUSY_MESSAGE : cantSendReason}
      />
    </section>
  );
}
