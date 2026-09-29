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
  onEnd: (outcome: { assistant: AskUIMessage | null; status: MessageStatus; usage: TurnUsage; steps: number; finishReason?: string }) => Promise<void>;
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

  const original = [...input.history, input.newMessage];
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
        if (part.type === 'abort') return { stopReason: String(part.reason ?? '').includes(TURN_DEADLINE) ? ('deadline' as const) : ('user' as const) };
        return undefined;
      },
      onError: (error) => lineFor(error),
      onEnd: async ({ responseMessage, isAborted, isCancelled, outcome, finishReason }) => {
        if (isCancelled) cancelled.abort(new Error('response cancelled'));
        const assistant = hasOutput(responseMessage) ? (responseMessage as AskUIMessage) : null;
        const status = statusFor({ isAborted: isAborted || isCancelled === true, errored: errored || outcome?.status === 'failed' });
        try {
          await input.onEnd({ assistant, status, usage, steps, finishReason });
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
