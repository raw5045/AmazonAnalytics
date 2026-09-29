import { APICallError } from 'ai';
import { BUSY_LINE, CHAT_GONE_MESSAGE, FAILED_MESSAGE, PROBLEM_LINE } from './messages';

export const GENERIC_ERROR = FAILED_MESSAGE;

/**
 * The transport surfaces a non-2xx response body as the thrown error's message; our routes send
 * `{ error }` JSON for a gate refusal (e.g. busy, chat full), and the stream's onError (turn.ts)
 * sends one of exactly two plain sentences for a model failure (BUSY_LINE, PROBLEM_LINE). Matched
 * by exact string equality, never a regex on English text (Task 9 D3) — a prefix/pattern match
 * would risk echoing an unrelated thrown message (e.g. a network error) back to the member as if
 * it were one of the two safe lines. The turn-deadline case no longer arrives as an error string
 * at all — it is `metadata.stopReason === 'deadline'` on the assistant message (see Thread.tsx).
 *
 * A bodyless 404 (Minor 9, final review) has no `{ error }` to surface: the AI SDK's transport fills
 * in its own generic fallback text for an empty response body (`createUIApiCallError` in
 * node_modules/ai/dist/index.js), which would otherwise fall through to GENERIC_ERROR below. Checked
 * last, after the JSON-body case, so a 404 that DOES carry `{ error }` (a real gate refusal) still
 * wins. CHAT_GONE_MESSAGE's copy stays neutral (nit 3, final re-review) because the route answers a
 * bodyless 404 for more than a follow-up's deleted/access-revoked chat — the kill switch going off
 * mid-session and ineligibility on a FIRST send (no chat exists yet) take this same path.
 */
export function describeChatError(e: unknown): string {
  const text = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  if (!text) return GENERIC_ERROR;
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (parsed && typeof parsed.error === 'string' && parsed.error) return parsed.error;
  } catch {}
  if (text === BUSY_LINE || text === PROBLEM_LINE) return text;
  if (APICallError.isInstance(e) && e.statusCode === 404) return CHAT_GONE_MESSAGE;
  return GENERIC_ERROR;
}
