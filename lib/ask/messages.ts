/**
 * Every member-facing string for Ask AI, in one place (Task 8 review, M4/M6). `gates.ts`, both
 * routes and `turn.ts` import their strings from here instead of holding literals inline, so
 * wording changes happen once and Task 9's client components can import the same strings without
 * pulling in server-only code. Env-free: imports only from ./models — never ./config, @/lib/env or
 * the `ai` package (see messages.test.ts, which asserts this from the source text).
 */
import { ASK_LIMITS } from './models';

/** The two safe lines a member ever sees for a model failure (turn.ts) — never the real provider error text. */
export const BUSY_LINE = 'The AI is busy, try again in a moment.';
export const PROBLEM_LINE = 'The AI hit a problem. Try again in a minute.';

/** A 503 for a setup/append/create/save failure that isn't one of the specific cases below. */
export const FAILED_MESSAGE = 'Something went wrong on our side. Try again in a minute.';
export const NOT_CONFIGURED_MESSAGE = "Ask AI isn't configured yet.";
export const CROSS_SITE_MESSAGE = 'Cross-site requests are not allowed.';
/** Body too large (content-length pre-check or the actual byte count) — not in the errors table; no UI copy depends on it. */
export const TOO_LARGE_MESSAGE = 'Request too large.';
/** Bad JSON, an unknown model, unknown body keys, or a non-uuid id — never surfaced by the normal UI. */
export const BAD_REQUEST_MESSAGE = 'Bad request.';
/** Also used for an empty message (post-sanitising min(1) failure), not just too-long. */
export const TOO_LONG_MESSAGE = `Keep it under ${ASK_LIMITS.maxMessageChars.toLocaleString('en-US')} characters.`;

export const CHAT_CAP_MESSAGE = `You have ${ASK_LIMITS.maxChats} chats. Delete one to start another.`;
export const CHAT_FULL_MESSAGE = 'This chat is full. Start a new one.';
export const BUSY_MESSAGE = 'Wait for the current answer to finish.';

export const NO_BALANCE_MESSAGE = "You've used this month's usage. Ask through the Feedback button to add more.";
export const GLOBAL_CEILING_MESSAGE = 'Ask AI is paused for the rest of the month.';

/** `limit` is always a whole number of questions per day; only 1 is ever singular. */
export function dailyLimitMessage(limit: number, seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const when = hours < 1 ? 'less than an hour' : hours === 1 ? '1 hour' : `${hours} hours`;
  const questions = limit === 1 ? 'question' : 'questions';
  return `You've reached today's limit of ${limit} ${questions}. It resets in ${when}.`;
}

// --- Task 9: page and client-component copy (spec §11-§12) ---

export const SWITCHED_OFF_MESSAGE = 'Ask AI is switched off for now.';
/** The loop ran out of steps (spec §12 "Loop ended without an answer") or a stored/live assistant message otherwise has no text — same line either way (Thread.tsx). */
export const RAN_OUT_MESSAGE = 'I ran out of steps before finishing. Try a narrower question.';
/** metadata.stopReason === 'deadline' (turn.ts) — no longer a stream error string; see the spec §12 amendment. */
export const TOO_LONG_TURN_MESSAGE = 'That took too long. Try a narrower question.';
/** metadata.finishReason === 'length': the model hit ASK_LIMITS.maxOutputTokens before finishing. */
export const CUT_OFF_MESSAGE = 'The answer was cut off because it got too long. Ask for a shorter version.';
/** metadata.status === 'stopped' with no stopReason — a member-initiated Stop or a closed tab. */
export const STOPPED_LINE = 'Stopped.';
export const ACCURACY_NOTICE = 'Answers can be wrong. Check the numbers on the keyword pages before acting.';
export const ADMIN_METER = 'Admin: usage is metered but not limited.';
export const DELETE_FAILED_MESSAGE = 'Could not delete the chat right now. Try again in a minute.';
/** The bottom-of-thread fallback (Thread.tsx) when the last message is the member's own and no answer followed, no recent Stop and no recent in-flight lock explain it — a crashed function, a failed save, or a stale reload (Task 9 fix round, item 1). */
export const NO_ANSWER_MESSAGE = 'No answer was saved for this question. Try asking again.';
