'use client';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useChat } from '@ai-sdk/react';
import { APICallError, getToolName, isToolUIPart, type ToolUIPart } from 'ai';
import type { AskModelId } from '@/lib/ask/models';
import type { AskUIMessage } from '@/lib/ask/conversations';
import { EXAMPLE_QUESTIONS } from '@/lib/ask/examples';
import {
  BUSY_MESSAGE, CHAT_CAP_MESSAGE, CHAT_GONE_MESSAGE, CUT_OFF_MESSAGE, FAILED_MESSAGE, NO_ANSWER_MESSAGE, RAN_OUT_MESSAGE, STOPPED_LINE, TOO_LONG_TURN_MESSAGE,
} from '@/lib/ask/messages';
import { describeChatError } from '@/lib/ask/clientErrors';
import { createAskTransport } from '@/lib/ask/transport';
// The browser-safe modules (arc 4): never '@/lib/ask/approvals' (node:crypto) or the tool definitions here.
import { APPROVAL_RESULT_PREFIX, isApprovalResultMessage } from '@/lib/ask/approvalResult';
import { writeKind } from '@/lib/ask/writeKinds';
import { AnswerMarkdown } from './AnswerMarkdown';
import { ApprovalCard, type ApprovalAnswer } from './ApprovalCard';
import { Composer } from './Composer';
import { ModelLabel, ModelPicker } from './ModelPicker';
import { ToolActivity } from './ToolActivity';
import { useWorkspaceNames } from './useWorkspaceNames';

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
/** Spec 2026-10-04 §4: the streaming answer's minimum height (the viewport less the app bar, its question and the composer band), so its question can sit at the top of the view. Small viewport units: stable while a phone's toolbars show and hide. */
const GROWN = 'min-h-[calc(100svh-20rem)]';

function hasVisibleText(m: AskUIMessage): boolean {
  return m.parts.some((p) => p.type === 'text' && p.text.trim().length > 0);
}

/** A tool part that paused for an approval card (spec 2026-10-01 §5): asked, answered here, or resolved by the server. */
type CardPart = ToolUIPart & { approval: NonNullable<ToolUIPart['approval']> };
function cardParts(m: AskUIMessage): CardPart[] {
  return (m.parts.filter(isToolUIPart) as ToolUIPart[]).filter((p): p is CardPart => p.approval != null);
}
/**
 * Still open on the server: asked, or answered in this tab but not sent yet — addToolApprovalResponse
 * marks a part approval-responded at once, and the route only records answers once all are in.
 */
function isOpenCard(p: { state: string }): boolean {
  return p.state === 'approval-requested' || p.state === 'approval-responded';
}
/**
 * The hidden placeholder an approval resend goes out with. Its id never matches a member message's:
 * useChat's generated ids have no '-'. Only this one is dropped on a refused resend; a member's own
 * text that starts with the prefix (the route refuses it) goes back into the draft like any refusal.
 */
const PLACEHOLDER_ID_PREFIX = 'approval-';
const placeholderIdFor = (messageId: string): string => `${PLACEHOLDER_ID_PREFIX}${messageId}`;
function isApprovalPlaceholder(m: AskUIMessage): boolean {
  return m.id.startsWith(PLACEHOLDER_ID_PREFIX) && isApprovalResultMessage(m);
}
/**
 * Asked again: the resend that carried these answers failed before the route recorded anything, so
 * the cards are open on the server and get their buttons back (spec 2026-10-01 §6, §9). The request
 * shape is restored as the route stored it — `approval: { id }` — so addToolApprovalResponse finds
 * the part again on the next click.
 */
function reopenCards(m: AskUIMessage, ids: ReadonlySet<string>): AskUIMessage {
  return {
    ...m,
    parts: m.parts.map((p): AskUIMessage['parts'][number] => {
      if (!isToolUIPart(p) || p.state !== 'approval-responded' || !ids.has(p.approval.id)) return p;
      return { ...p, state: 'approval-requested', approval: { id: p.approval.id } };
    }),
  };
}
/** A refused resume whose JSON body says `answered: true`: the route had stored the answers before its setup failed. */
function saysAnswered(body: string): boolean {
  try {
    return (JSON.parse(body) as { answered?: unknown } | null)?.answered === true;
  } catch {
    return false;
  }
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
 *
 * An answer that paused for an approval card (arc 4) ends with finishReason 'tool-calls' and often
 * no text: that is the card's question, not "ran out of steps" — live, after a reload, and once the
 * card is answered — so a message with any card part gets none of the lines after the failure check.
 */
function statusLineFor(m: AskUIMessage, isLive: boolean, isLast: boolean, chatStatus: string, stoppedIds: ReadonlySet<string>): string | null {
  const meta = m.metadata;
  if (meta?.stopReason === 'deadline') return TOO_LONG_TURN_MESSAGE;
  if (meta?.stopReason === 'user' || meta?.status === 'stopped' || stoppedIds.has(m.id)) return STOPPED_LINE;
  if (meta?.status === 'failed') return FAILED_MESSAGE;
  if (cardParts(m).length > 0) return null;
  if (meta?.finishReason === 'length') return CUT_OFF_MESSAGE;
  if (meta?.finishReason === 'tool-calls') return RAN_OUT_MESSAGE;
  if (!hasVisibleText(m) && !isLive && !(isLast && chatStatus === 'error')) return RAN_OUT_MESSAGE;
  return null;
}

/**
 * Spec §11.3, laid out per spec 2026-10-04 §4. One hook instance per chat (AskAi keys this
 * component by the open chat's id, plus an epoch that advances only on a busy→idle transition —
 * fix round 2 item 1 / round-3 B1). The transport (lib/ask/transport.ts) sends only the new
 * message text plus the chat id (and the model on a first send) — the server loads history itself
 * (spec §13). A first send learns the new chat's id from the assistant message metadata and moves
 * the URL there.
 *
 * `draft` is owned by AskAi, not this component (Task 9 fix round, item 8 / M1): a first send
 * changes the URL to `?c=<id>`, and since Thread is keyed by the open chat's id, that remounts it
 * — anything the member had queued mid-answer would otherwise vanish.
 *
 * Approval cards (arc 4, spec 2026-10-01 §5, §6): an answer that paused for the member's approval
 * shows one ApprovalCard per paused write; only the last answer's cards are live. Once every one of
 * them is answered, ONE request carries all the answers, in part order (the route refuses a partial
 * set), sent with a hidden placeholder user message so the resumed answer arrives as a new message
 * after the cards — what a reload shows. The route's own hidden outcome messages are never rendered.
 */
export function Thread({ open, defaultModel, cantSendReason, atCap, appOrigin, draft, onDraftChange, onAlwaysApproved, writesEnabled, landAtEnd = true }: {
  open: OpenConversation | null; defaultModel: AskModelId;
  /** The server-computed reason (no balance / chat full), or null — the cap case is decided below, since only this component knows about a chat id already learned from the stream (item 6). */
  cantSendReason: string | null;
  atCap: boolean; appOrigin: string;
  draft: string; onDraftChange: (v: string) => void;
  /** The writes switch as the page last saw it (spec 2026-10-01 §2): off, a card still waiting is read-only — an answer would get a 404 — and the next message resolves it. */
  writesEnabled: boolean;
  /** An "Always approve" answer landed (the resend's answer reached the thread): the matching "always allow" switch is now on (spec 2026-10-01 §8). */
  onAlwaysApproved?: (kind: 'changes' | 'deletes') => void;
  /** False when the page just moved from the new chat to its freshly created id after a first send (AskAi): the member is reading that first answer, so the remounted Thread keeps their place. Default true: opening a chat lands at its end (spec 2026-10-04 §4). */
  landAtEnd?: boolean;
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
  // Arc 4: the member's answers to approval cards, by approval id — what a card's record says ("for
  // this chat" / "always", known only to the tab that clicked) and what the resend carries.
  const [answers, setAnswers] = useState<Readonly<Record<string, ApprovalAnswer>>>({});
  // The resend in flight: the cards' message, the approval ids it answers, and the kinds an "Always
  // approve" in it covered. When it failed before anything streamed, onError reopens those cards (or,
  // after a 404 or `answered: true`, keeps their records); onFinish drains it (spec 2026-10-01 §6, §8, §9).
  const resendInFlight = useRef<{ messageId: string; ids: ReadonlySet<string>; always: ReadonlySet<'changes' | 'deletes'> } | null>(null);
  // Where focus goes once a card answered from the keyboard collapses: the next open card (its approval id), else the composer (null).
  const [focusAfterAnswer, setFocusAfterAnswer] = useState<{ approvalId: string | null } | null>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  // A resend refused with 400 (the route's open cards differ from this tab's): the alert shows the
  // chat-gone line, since only a reload resyncs. Cleared by the next request (send / answerApproval).
  const [cardsOutOfSync, setCardsOutOfSync] = useState(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (navTimer.current !== null) clearTimeout(navTimer.current);
    };
  }, []);
  const { messages, sendMessage, status, stop, error, setMessages, addToolApprovalResponse } = useChat<AskUIMessage>({
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
      const reached = finishedMessages.some((m) => m.id === message.id);
      // Arc 4 (spec 2026-10-01 §8): an "Always approve" answer turns its switch on once the resend's
      // answer reached the thread — the route saves the preference before any write and before it
      // streams, so a streamed answer means it landed (even one that then stops or errors), while a
      // refused resend (404/400/409/5xx) never streams. Drained on every finish, so it never leaks
      // into a later turn (onError, which runs first, has already reopened a failed one's cards).
      const sent = resendInFlight.current;
      resendInFlight.current = null;
      if (sent && reached) for (const kind of sent.always) onAlwaysApproved?.(kind);
      if (isError) {
        // M2: onError already navigated for this exact failure — one navigation, not two.
        if (navigatedByErrorRef.current) navigatedByErrorRef.current = false;
        else router.refresh();
        return;
      }
      if (isAbort) {
        if (reached) setStoppedIds((prev) => new Set(prev).add(message.id));
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
        // fresh data for the new URL a replace navigates to. `scroll: false` (spec 2026-10-04 §4):
        // Next's own navigation scroll would put the page back at its top once the remount lands;
        // the member is reading this first answer, and AskAi's landAtEnd keeps their place.
        if (!open && cid) router.replace(`/ask?c=${encodeURIComponent(cid)}`, { scroll: false });
        else router.refresh();
      };
      if (isAbort) navTimer.current = setTimeout(moveOn, ABORT_NAV_DELAY_MS);
      else moveOn();
    },
    onError: (err) => {
      // Arc 4 (spec 2026-10-01 §6, §9): a resend that failed before anything streamed — refused by
      // the route (409 busy or full, 402, 5xx) or lost on the network — still has the hidden
      // placeholder last. Its cards reopen for one more click (the alert says what happened; they
      // are live in useChat's error state): nothing was recorded, or (approval_record_failed) the
      // writes ran but were not recorded — the accepted double-run window. Three answers keep the
      // records instead (the placeholder goes, nothing reopens): a 404, the cards being gone
      // (answered elsewhere, the chat deleted, writes switched off), with the chat-gone line; a 400,
      // the route's open cards differing from this tab's (a Stop between two parallel approval
      // chunks), which only a reload resyncs — the chat-gone line too, where "Bad request." would
      // greet every retry; and a setup failure after the route had stored the answers, which it
      // marks `answered: true`, with the setup-failed line. Once anything streamed the answers are
      // stored, so the guard on the placeholder being last leaves the records and the partial answer
      // alone. Checked before the HTTP-only early return below, so a network failure is covered
      // too. `undone` is set inside the updater, which @ai-sdk/react runs once, synchronously (M5
      // below), on the current messages.
      const sent = resendInFlight.current;
      if (sent) {
        const status = APICallError.isInstance(err) ? err.statusCode : undefined;
        const outOfSync = status === 400;
        const keepRecords = status === 404 || outOfSync || (APICallError.isInstance(err) && saysAnswered(err.message));
        let undone = false;
        setMessages((msgs) => {
          if (msgs[msgs.length - 1]?.id !== placeholderIdFor(sent.messageId)) return msgs;
          undone = true;
          const kept = msgs.slice(0, -1);
          return keepRecords ? kept : kept.map((m) => (m.id === sent.messageId ? reopenCards(m, sent.ids) : m));
        });
        if (undone) {
          if (!keepRecords) setAnswers((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => !sent.ids.has(id))));
          if (outOfSync) setCardsOutOfSync(true);
          return;
        }
      }
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
        router.replace(`/ask?c=${encodeURIComponent(refusedConversationId)}`, { scroll: false }); // as in onFinish's move
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
        // Arc 4 backstop: the resend branch above handles a failed resend; a hidden placeholder
        // found last here anyway is dropped and never put in the draft.
        if (trailing && isApprovalPlaceholder(trailing)) return msgs.slice(0, -1);
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
  const last = messages[messages.length - 1];
  const names = useWorkspaceNames(messages);
  const send = (text: string) => {
    onDraftChange('');
    setStoppedBeforeAnswer(false);
    setCardsOutOfSync(false);
    void sendMessage({ text }, { body: { conversationId: knownChatId, ...(knownChatId ? {} : { model }) } });
  };
  /**
   * One card answered (spec 2026-10-01 §5, §6): the answer is recorded and the card collapses to its
   * record. Nothing is sent until every card still open on the last answer has one — the model can
   * pause several calls in one step, and the route takes them all in ONE request, in part order.
   * The request goes out as a hidden placeholder user message (the transport puts only the answers
   * on the wire), so the SDK starts a NEW assistant message for the resumed answer — what a reload
   * shows. The SDK's own approval resend, sendMessage(undefined), would continue the cards' message
   * instead, even with a placeholder appended first (Thread.live.test.tsx drives the real hook).
   * Keep it that way: never call sendMessage() without a message here, and never give useChat a
   * sendAutomaticallyWhen — those are the only readers of the SDK's pendingApprovalMessageId (which
   * addToolApprovalResponse sets), so leaving it unused is what lets a refused resend simply reopen
   * its cards (onError) and a later click start over.
   * An answer given from the keyboard then moves focus to the next card still open (part order,
   * wrapping), else to the composer. A mouse click or a touch tap moves none: on a phone, focusing
   * the composer would open the keyboard over the answer that is about to stream.
   */
  const answerApproval = (a: ApprovalAnswer, viaKeyboard: boolean) => {
    if (last?.role !== 'assistant') return;
    const next = { ...answers, [a.approvalId]: a };
    setAnswers((prev) => ({ ...prev, [a.approvalId]: a }));
    void addToolApprovalResponse({ id: a.approvalId, approved: a.approved });
    const waiting = cardParts(last).filter(isOpenCard);
    const at = waiting.findIndex((p) => p.approval.id === a.approvalId);
    const nextOpen = [...waiting.slice(at + 1), ...waiting.slice(0, Math.max(at, 0))].find((p) => !next[p.approval.id]);
    if (viaKeyboard) setFocusAfterAnswer({ approvalId: nextOpen?.approval.id ?? null });
    if (nextOpen) return;
    resendInFlight.current = {
      messageId: last.id,
      ids: new Set(waiting.map((p) => p.approval.id)),
      always: new Set(waiting.filter((p) => next[p.approval.id].remember === 'always').map((p): 'changes' | 'deletes' => (writeKind(getToolName(p)) === 'delete' ? 'deletes' : 'changes'))),
    };
    setCardsOutOfSync(false);
    void sendMessage(
      { id: placeholderIdFor(last.id), role: 'user', parts: [{ type: 'text', text: `${APPROVAL_RESULT_PREFIX} pending` }] },
      { body: { conversationId: knownChatId, approvals: waiting.map((p) => next[p.approval.id]) } },
    );
  };
  // After an answer from the keyboard: focus the next open card's first button, else the composer's
  // textarea. Composer does not expose its textarea, so it is found inside this thread's own section
  // (its form lives there).
  useEffect(() => {
    if (!focusAfterAnswer) return;
    const section = sectionRef.current;
    if (!section) return;
    const card = focusAfterAnswer.approvalId === null ? undefined : [...section.querySelectorAll<HTMLElement>('[data-approval-id]')].find((el) => el.dataset.approvalId === focusAfterAnswer.approvalId);
    (card?.querySelector('button') ?? section.querySelector('textarea'))?.focus();
  }, [focusAfterAnswer]);
  /**
   * How a card shows. A card still open when the member sent a new message was denied by that send
   * (spec 2026-10-01 §6: the route records the denial before it stores the message), so it reads
   * "Denied" without a reload. If that send is refused, onError takes the message back out: the card
   * is the last answer's again, open as it still is on the server, and live in useChat's error state.
   * A card answered here shows its record at once, before useChat's throttled re-render brings the
   * SDK's approval-responded part.
   */
  const shownCard = (p: CardPart, deniedBySend: boolean): ToolUIPart => {
    if (deniedBySend && (p.state === 'approval-requested' || p.state === 'approval-responded')) {
      return { ...p, state: 'output-denied', approval: { ...p.approval, approved: false } };
    }
    const answer = answers[p.approval.id];
    return answer && p.state === 'approval-requested' ? { ...p, state: 'approval-responded', approval: { ...p.approval, approved: answer.approved } } : p;
  };
  // The card buttons wait while a turn streams, through the Stop cooldown and while the page moves to
  // a new chat — and whenever nothing can be sent (no balance, the chat full): a resume is a billed
  // turn that needs room for one more message, so a click could only be refused.
  const cardsBusy = streaming || cooldown || leaving || !canSend;
  const onStop = () => {
    stop();
    setCooldown(true);
    setTimeout(() => setCooldown(false), STOP_COOLDOWN_MS);
  };
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
  /**
   * Spec 2026-10-04 §4. Opening a chat lands at the page end, once per mount (Thread remounts per
   * chat through AskAi's key, so `open?.id` runs this exactly once here), before the first paint —
   * except after a first send's move to its new id (`landAtEnd` false), where the member keeps
   * their place in the answer they are reading. It scrolls the window, the page's scroll
   * container, rather than the last message into view: the composer band sticks to the viewport
   * bottom and would cover the end of that message, and only at the page end does the band's own
   * place in the flow keep it clear. The navigations to a chat pass `scroll: false` (the rail's
   * links, the first send's move, the recovery link), so Next's own scroll to the page top never
   * undoes this. Skipped where the page has no layout (jsdom: scrollHeight 0).
   */
  const openId = open?.id ?? null;
  const landed = useRef(false);
  useLayoutEffect(() => {
    if (!openId || !landAtEnd || landed.current) return;
    landed.current = true;
    const page = document.documentElement;
    if (page.scrollHeight > 0 && typeof window.scrollTo === 'function') window.scrollTo({ top: page.scrollHeight });
  }, [openId, landAtEnd]);
  /**
   * Every message that starts a turn scrolls to the top of the view when it first appears, so the
   * answer streams in below it (`scroll-mt` on each message keeps it clear of the app bar): a
   * member question, or the answer that resumes a turn after approval cards — the message after a
   * hidden approval message (this tab's placeholder while live, the route's stored outcome after a
   * reload). The hidden messages themselves are never scrolled to. The turn starts shown at mount
   * are the landing's, and each id is scrolled to once only, so a refused send that takes its
   * question back (onError) leaves an earlier, already seen question last and nothing moves. The
   * scroll is smooth, or instant under prefers-reduced-motion. Reads the DOM only; skipped where
   * scrollIntoView does not exist (jsdom).
   */
  const turnStartIds = messages.flatMap((m, i) => {
    if (isApprovalResultMessage(m)) return [];
    const prev = messages[i - 1];
    return m.role === 'user' || (prev !== undefined && isApprovalResultMessage(prev)) ? [m.id] : [];
  });
  const turnStartsKey = turnStartIds.join(' ');
  const lastTurnStartId = turnStartIds[turnStartIds.length - 1] ?? null;
  const seenTurnStarts = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (seenTurnStarts.current === null) { seenTurnStarts.current = new Set(turnStartsKey === '' ? [] : turnStartsKey.split(' ')); return; }
    if (lastTurnStartId === null || seenTurnStarts.current.has(lastTurnStartId)) return;
    seenTurnStarts.current.add(lastTurnStartId);
    const el = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-message-id]') ?? [])].find((li) => li.dataset.messageId === lastTurnStartId);
    const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
  }, [lastTurnStartId, turnStartsKey]);
  /**
   * Room below the question, as on claude.ai: a question can only reach the top of the view when
   * the page runs on below it for most of a viewport, so the answer that is streaming gets GROWN's
   * minimum height and grows into that space. Its id is kept once set, so the page does not shrink
   * and jump when the stream ends; a reopened chat starts with none and lands compactly. A question
   * still waiting for its first chunk gets a spacer of the same height right after it, so nothing
   * moves when the answer's message takes the spacer's place — and the kept answer gives its room
   * up at that moment, at send time, so the turn-start scroll measures the final layout. Released
   * any later, it would shrink above a question already at the top of the view, where scroll
   * anchoring does not compensate (the shrinking item is itself the anchor, or the browser has no
   * anchoring), and the question would jump. The id is adjusted during render (React's pattern for
   * state that follows a change), not in an effect: the lint rule forbids setState in effects.
   */
  const lastShown = [...messages].reverse().find((m) => !isApprovalResultMessage(m));
  const [grownId, setGrownId] = useState<string | null>(null);
  if (streaming && lastShown?.role === 'assistant' && grownId !== lastShown.id) setGrownId(lastShown.id);
  const awaitingFirstChunk = streaming && lastShown?.role === 'user';
  if (awaitingFirstChunk && grownId !== null) setGrownId(null);

  return (
    <section ref={sectionRef} aria-label="Conversation" className="flex flex-1 flex-col">
      <div className="mx-auto flex w-full max-w-[48rem] flex-1 flex-col px-4 pt-6 md:px-6">
        {empty && !open && (
          <div className="flex flex-1 flex-col items-center justify-center py-10 text-center">
            <h2 className="text-2xl font-semibold text-slate-800">What do you want to find?</h2>
            <p className="mt-2 text-slate-500">Same data as the Explorer, answered in plain language.</p>
            <ul className="mt-6 grid w-full gap-2 md:grid-cols-2">
              {EXAMPLE_QUESTIONS.map((q) => (
                <li key={q}>
                  <button type="button" onClick={() => onDraftChange(q)} className="h-full w-full rounded-xl border border-slate-200 bg-[#F4F6FA] px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-100">{q}</button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <ol ref={listRef} className="flex flex-col gap-5 pb-6">
          {messages.map((m, index) => {
            // The route's hidden outcome messages (and this tab's placeholder for one) are never shown.
            if (isApprovalResultMessage(m)) return null;
            // A card is a question to the member, not activity (spec 2026-10-01 §5): not in the "Used N tools" strip.
            const toolParts = (m.parts.filter(isToolUIPart) as ToolUIPart[]).filter((p) => p.approval == null);
            const cards = m.role === 'assistant' ? cardParts(m) : [];
            // A member message right after this answer was sent while its cards were open (an answered
            // set is followed by the hidden placeholder or outcome message instead): that send denied them.
            const after = messages[index + 1];
            const deniedBySend = after !== undefined && after.role === 'user' && !isApprovalResultMessage(after);
            const isLive = streaming && m === last;
            const line = m.role === 'assistant' ? statusLineFor(m, isLive, m === last, status, stoppedIds) : null;
            return (
              <li key={m.id} data-message-id={m.id} className={`scroll-mt-16 ${m.role === 'user' ? 'self-end' : 'w-full self-start'}${m.id === grownId ? ` ${GROWN}` : ''}`}>
                <article
                  aria-label={m.role === 'user' ? 'You' : 'Ask AI'}
                  className={m.role === 'user' ? 'max-w-[36rem] rounded-2xl rounded-br-md bg-[#0B1E3A] px-4 py-2.5 text-[15px] leading-relaxed text-white' : 'text-[15px] leading-relaxed text-slate-800'}
                >
                  {m.role === 'assistant' && <ToolActivity parts={toolParts} streaming={isLive} />}
                  {m.parts.map((p, i) => (p.type === 'text' ? (m.role === 'user' ? <p key={i} className="whitespace-pre-wrap">{p.text}</p> : <AnswerMarkdown key={i} appOrigin={appOrigin}>{p.text}</AnswerMarkdown>) : null))}
                  {/* The cards read after the answer's lead-in, nearest the composer. Live on the last
                      answer whenever nothing is streaming — in useChat's error state too, so a card a
                      refused send or resend left open keeps its buttons. */}
                  {cards.map((p) => (
                    <ApprovalCard
                      key={p.toolCallId}
                      part={shownCard(p, deniedBySend)}
                      names={names}
                      interactive={m === last && !streaming && !open?.inFlight}
                      busy={cardsBusy}
                      onAnswer={answerApproval}
                      record={answers[p.approval.id]?.remember}
                      writesOff={!writesEnabled}
                    />
                  ))}
                  {line && <p className={`mt-1 text-xs ${m.metadata?.status === 'failed' ? 'text-red-700' : 'text-slate-500'}`}>{line}</p>}
                </article>
              </li>
            );
          })}
          {awaitingFirstChunk && <li aria-hidden="true" className={GROWN} />}
          {bottomLine && <li className="text-sm text-slate-600">{bottomLine}</li>}
          {error && (
            <li role="alert" className="text-sm text-red-700">
              {cardsOutOfSync ? CHAT_GONE_MESSAGE : describeChatError(error)}
              {/* item 6: a first send that then errored still created the chat — a manual way back
                  to it, since a first-send error deliberately never auto-navigates (item 3). */}
              {!open && streamedCid && <> <Link href={`/ask?c=${encodeURIComponent(streamedCid)}`} scroll={false} className="underline">Open this chat</Link></>}
            </li>
          )}
        </ol>
      </div>
      {/* Spec 2026-10-04 §4: the composer band sticks to the viewport bottom; the window stays the scroll container. */}
      <div className="sticky bottom-0 border-t border-slate-100 bg-white px-4 pb-3 pt-2 md:px-6">
        <div className="mx-auto max-w-[48rem]">
          <Composer
            value={draft}
            onChange={onDraftChange}
            onSend={send}
            onStop={onStop}
            streaming={streaming}
            disabled={!canSend}
            sendDisabled={cooldown || leaving}
            disabledReason={cantSendReasonEffective}
            // An open chat's model is fixed; a new chat picks one until its first message exists.
            modelControl={open ? <ModelLabel model={open.model} /> : <ModelPicker value={model} onChange={setModel} disabled={streaming || !empty} />}
          />
        </div>
      </div>
    </section>
  );
}
