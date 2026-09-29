import {
  convertToModelMessages, createUIMessageStreamResponse, isStepCount, isToolUIPart, streamText, toUIMessageStream, RetryError,
  type LanguageModel, type ModelMessage, type ToolSet, type UIMessage,
} from 'ai';
import { ASK_LIMITS, type AskModelId } from './config';
import { errFields } from './logSafe';
import { BUSY_LINE, PROBLEM_LINE } from './messages';
import { addUsage, usageFromSdk, ZERO_USAGE, type TurnUsage } from './pricing';
import type { AskUIMessage, MessageStatus } from './conversations';

/** The route aborts the turn's combined signal with `new Error(TURN_DEADLINE)` on the 240s deadline; matched by string (see messageMetadata below), never a regex literal, so the sentinel lives in exactly one place. */
export const TURN_DEADLINE = 'ask turn deadline';

/** Spec §6. One turn: bounded loop, streamed to the browser, persisted and settled through `onEnd`. */
export interface TurnInput {
  model: LanguageModel;
  /** Gates the Anthropic `effort` provider option (Task 7 review): Haiku 4.5 rejects it. */
  modelId: AskModelId;
  instructions: string;
  tools: ToolSet;
  /** Already windowed by the caller (windowHistory). */
  history: AskUIMessage[];
  newMessage: AskUIMessage;
  abortSignal: AbortSignal;
  generateMessageId: () => string;
  /** Attached to the assistant message when the stream starts — the new conversation's id on a first send. */
  startMetadata?: AskUIMessage['metadata'];
  onEnd: (outcome: { assistant: AskUIMessage | null; status: MessageStatus; usage: TurnUsage; steps: number; finishReason?: string; stopReason?: 'deadline' | 'user' }) => Promise<void>;
}

const CACHE = { anthropic: { cacheControl: { type: 'ephemeral' as const } } };

const BUSY_STATUS_CODES = new Set([429, 529]);

/**
 * `streamRetries`/the SDK's own retry loop wraps an exhausted retry in a `RetryError` whose
 * `.lastError` is the real provider error; a non-retried failure (e.g. `isRetryable: false`,
 * or no retry configured) reaches here unwrapped. Either way, `statusCode` is read off the real
 * provider error (`APICallError`/`StreamProviderError` both carry it) so 429/529 map to the busy
 * line and everything else (validation errors, network errors, a plain throw) gets the generic one.
 */
function lineFor(error: unknown): string {
  const unwrapped = RetryError.isInstance(error) ? error.lastError : error;
  const statusCode = (unwrapped as { statusCode?: unknown } | undefined)?.statusCode;
  return typeof statusCode === 'number' && BUSY_STATUS_CODES.has(statusCode) ? BUSY_LINE : PROBLEM_LINE;
}

/** Richer than a bare message (Task 7 review, §F): statusCode/type let ops triage a provider failure without a stack trace. */
function logModelError(error: unknown): void {
  const outer = error as { name?: unknown; message?: unknown } | undefined;
  const unwrapped = (RetryError.isInstance(error) ? error.lastError : error) as { statusCode?: unknown; type?: unknown } | undefined;
  const message = typeof outer?.message === 'string' ? outer.message.slice(0, 300) : outer?.message;
  console.error('[ask turn]', JSON.stringify({ outcome: 'model_error', name: outer?.name, statusCode: unwrapped?.statusCode, type: unwrapped?.type, message }));
}

export function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}

/** Anthropic rejects a prompt whose first turn is an assistant message (e.g. after a turn stored only its user message, spec §12); never start the window there. */
function fromFirstUser(m: AskUIMessage[]): AskUIMessage[] {
  const i = m.findIndex((x) => x.role === 'user');
  return i < 0 ? [] : m.slice(i);
}

/** Last 20 stored messages, then drop the oldest while the estimate exceeds the token guard (spec §6), always re-anchored to the first remaining user turn. */
export function windowHistory(history: AskUIMessage[], limits: Pick<typeof ASK_LIMITS, 'historyWindowMessages' | 'historyWindowTokens'> = ASK_LIMITS): AskUIMessage[] {
  let out = fromFirstUser(history.slice(-limits.historyWindowMessages));
  while (out.length > 1 && estimateTokens(out) > limits.historyWindowTokens) out = fromFirstUser(out.slice(1));
  return out;
}

/**
 * A stored assistant message can end mid-tool-loop — a completed tool step (Stop right after a
 * tool resolved), a mid-loop failure with output, ran-out-of-steps, or the turn deadline (spec §12:
 * `hasOutput` below allows storing all of these). Replaying it as-is sends `assistant[tool_use]`
 * followed by `user[tool_result, new question]` with no thinking block ahead of it — reasoning is
 * never stored (see `sendReasoning: false` below) — which the Anthropic API can reject once adaptive
 * thinking is active (Sonnet 5 / Opus 5.5), and then EVERY later question in that chat fails until
 * the message ages out of the 20-message window (Important 2, final review). Fix: cut each HISTORY
 * assistant message's parts after its last non-empty text part (dropping any trailing tool parts or
 * step-start), and drop a history assistant message that has no non-empty text part at all.
 *
 * Purely a trim: user messages are untouched (never dropped, never edited) and the new turn's own
 * message is never passed to this helper. That alone keeps the user-first invariant intact for the
 * one caller this has (runTurn, on windowHistory's already-anchored output): since index 0 of a
 * non-empty window is always a user message and this function never touches user messages, index 0
 * of the result is that exact same message, untouched — never re-derived here with `fromFirstUser`,
 * which would incorrectly discard a message passed in isolation (see the [text, tool] -> [text] unit
 * tests below, which call this directly on a lone assistant message with no user message at all).
 */
export function trimHistoryForReplay(messages: AskUIMessage[]): AskUIMessage[] {
  return messages.flatMap((m) => {
    if (m.role !== 'assistant') return [m];
    let cut = -1;
    for (let i = m.parts.length - 1; i >= 0; i--) {
      const p = m.parts[i];
      if (p.type === 'text' && p.text.trim() !== '') { cut = i; break; }
    }
    if (cut < 0) return [];
    return [cut === m.parts.length - 1 ? m : { ...m, parts: m.parts.slice(0, cut + 1) }];
  });
}

export function statusFor(f: { isAborted: boolean; errored: boolean }): MessageStatus {
  if (f.isAborted) return 'stopped';
  return f.errored ? 'failed' : 'complete';
}

/** Spec §12: store an assistant message only if it produced real output — never a lone step-start or a dangling in-progress tool call left by a cancel. */
function hasOutput(m: UIMessage): boolean {
  return m.parts.some((p) => (p.type === 'text' && p.text.trim() !== '') || (isToolUIPart(p) && (p.state === 'output-available' || p.state === 'output-error')));
}

export async function runTurn(input: TurnInput): Promise<Response> {
  let usage: TurnUsage = { ...ZERO_USAGE };
  let steps = 0;
  let errored = false;
  // Cancelling the response body (Stop, a closed tab) does not by itself reach the model call:
  // toUIMessageStream reads result.stream through a tee(), and the UI stream sent to the browser
  // is only one of the two branches — cancelling one branch never cancels the shared source, so
  // the other branch (the SDK's own internal read) keeps the model call running. A body cancel
  // (isCancelled, in onEnd below) therefore has to abort this combined signal explicitly, which
  // the model call and every tool execution observe. The caller's own signal (request abort, the
  // turn deadline) still applies unchanged.
  const cancelled = new AbortController();
  const abortSignal = AbortSignal.any([input.abortSignal, cancelled.signal]);

  const original = [...trimHistoryForReplay(input.history), input.newMessage];
  const messages: ModelMessage[] = await convertToModelMessages(original, { tools: input.tools, ignoreIncompleteToolCalls: true });
  const last = messages[messages.length - 1];
  if (last) messages[messages.length - 1] = { ...last, providerOptions: { ...last.providerOptions, ...CACHE } } as ModelMessage;

  // Haiku 4.5 rejects the effort option; only the two heavier models get it (Task 7 review, §D3).
  const providerOptions = input.modelId === 'claude-sonnet-5' || input.modelId === 'claude-opus-5-5'
    ? { anthropic: { effort: 'low' as const } }
    : undefined;

  const result = streamText({
    model: input.model,
    instructions: [{ role: 'system', content: input.instructions, providerOptions: CACHE }],
    messages,
    tools: input.tools,
    providerOptions,
    stopWhen: isStepCount(ASK_LIMITS.maxSteps),
    maxOutputTokens: ASK_LIMITS.maxOutputTokens,
    abortSignal,
    onStepEnd: ({ usage: stepUsage }) => {
      usage = addUsage(usage, usageFromSdk(stepUsage));
      steps += 1;
    },
    onError: ({ error }) => {
      errored = true;
      logModelError(error);
    },
  });

  return createUIMessageStreamResponse({
    headers: { 'cache-control': 'no-store' },
    stream: toUIMessageStream({
      stream: result.stream,
      tools: input.tools,
      originalMessages: original,
      generateMessageId: input.generateMessageId,
      // Signed thinking is never streamed, stored or replayed: a stored reasoning block would be
      // replayed verbatim next turn (convertToModelMessages round-trips it through jsonb), and
      // Opus 5.5 returns 400 when a replayed thinking block's signature no longer matches history.
      sendReasoning: false,
      // Live per spec §12: the finish reason once the model settles, and — on an abort — whether
      // it was the server's own deadline or a member-initiated Stop/closed tab. Both merge into
      // the message's metadata (the AI SDK merges successive messageMetadata results) alongside
      // `startMetadata`'s conversationId from the `start` part, so none of the three clobber another.
      messageMetadata: ({ part }) => {
        if (part.type === 'start') return input.startMetadata;
        if (part.type === 'finish') return { finishReason: part.finishReason };
        if (part.type === 'abort') {
          // `status: 'stopped'` (Task 9 fix round, item 1) alongside stopReason: a live abort
          // previously carried only stopReason, so the client had nothing to key a "Stopped."
          // line off during streaming — it could only infer status from a later reload, by which
          // time stopReason is gone (never persisted; see conversations.ts's storedToUiMessage).
          const stopReason = String(part.reason ?? '').includes(TURN_DEADLINE) ? ('deadline' as const) : ('user' as const);
          return { status: 'stopped' as const, stopReason };
        }
        return undefined;
      },
      onError: (error) => lineFor(error),
      onEnd: async ({ responseMessage, isAborted, isCancelled, outcome, finishReason }) => {
        if (isCancelled) cancelled.abort(new Error('response cancelled'));
        const finalMessage = responseMessage as AskUIMessage;
        const assistant = hasOutput(responseMessage) ? finalMessage : null;
        const status = statusFor({ isAborted: isAborted || isCancelled === true, errored: errored || outcome?.status === 'failed' });
        // Read off the message's own metadata first — messageMetadata's 'abort' branch above already
        // set it there for a live abort part, merged in regardless of whether hasOutput ends up
        // keeping or discarding the message for storage (Minor 7, final review — ops needs stopReason
        // on the log line even for a stop that produced no storable output). But a cancelled body
        // (Stop, a closed tab) reaches onEnd through toUIMessageStream's own cancel() handling, which
        // runs BEFORE any 'abort' part is ever emitted — so metadata.stopReason is still undefined on
        // that path, even though it is just as much a member Stop as the abort-part path is (a member
        // Stop on Vercel can land as either, per Task 9 review). Fall back to 'user' whenever isCancelled
        // is what triggered the stop (nit 2, final re-review).
        try {
          await input.onEnd({ assistant, status, usage, steps, finishReason, stopReason: finalMessage.metadata?.stopReason ?? (isCancelled ? 'user' : undefined) });
        } catch (e) {
          // The stream has already been rendered to the browser by this point; a persistence
          // failure here must never surface as a broken response. Log-safe (Task 8 re-review): the
          // raw error object used to be passed straight to console.error, which — for a
          // DrizzleQueryError — would print its bound SQL params (possibly message text).
          console.error('[ask turn]', JSON.stringify({ outcome: 'on_end_threw', ...errFields(e) }));
        }
      },
    }),
  });
}
