import { BUSY_LINE, FAILED_MESSAGE, PROBLEM_LINE } from './messages';

export const GENERIC_ERROR = FAILED_MESSAGE;

/**
 * The transport surfaces a non-2xx response body as the thrown error's message; our routes send
 * `{ error }` JSON for a gate refusal (e.g. busy, chat full), and the stream's onError (turn.ts)
 * sends one of exactly two plain sentences for a model failure (BUSY_LINE, PROBLEM_LINE). Matched
 * by exact string equality, never a regex on English text (Task 9 D3) — a prefix/pattern match
 * would risk echoing an unrelated thrown message (e.g. a network error) back to the member as if
 * it were one of the two safe lines. The turn-deadline case no longer arrives as an error string
 * at all — it is `metadata.stopReason === 'deadline'` on the assistant message (see Thread.tsx).
 */
export function describeChatError(e: unknown): string {
  const text = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  if (!text) return GENERIC_ERROR;
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (parsed && typeof parsed.error === 'string' && parsed.error) return parsed.error;
  } catch {}
  return text === BUSY_LINE || text === PROBLEM_LINE ? text : GENERIC_ERROR;
}
