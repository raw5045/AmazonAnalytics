/**
 * Validation for POST /api/feedback (the signed-in feedback modal).
 * Message bounds mirror lib/contact/validate.ts. The page is a nicety:
 * anything that isn't a plain in-app relative path becomes null rather than
 * an error, so a bad page value never costs the user their message.
 */
export interface FeedbackInput {
  message: string;
  page: string | null;
}

export const MESSAGE_MIN = 10;
export const MESSAGE_MAX = 5000;
const PAGE_MAX = 2000;

export function validateFeedback(
  raw: unknown,
): { ok: true; input: FeedbackInput } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'invalid payload' };
  const r = raw as Record<string, unknown>;
  const message = typeof r.message === 'string' ? r.message.trim() : '';
  if (message.length < MESSAGE_MIN || message.length > MESSAGE_MAX) {
    return { ok: false, error: 'message must be 10–5,000 characters' };
  }
  return { ok: true, input: { message, page: normalizePage(r.page) } };
}

/**
 * Accept only an in-app relative path ("/explorer?rank_max=100"): exactly one
 * leading "/", no whitespace, control, or format characters (zero-width,
 * bidi overrides — display-only risk in the email link text), and short. Rejects
 * absolute URLs and protocol-relative "//host" forms — the email renders this
 * after the app's own base URL, so it must never point anywhere else.
 */
export function normalizePage(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const p = raw.trim();
  if (p.length === 0 || p.length > PAGE_MAX) return null;
  if (!p.startsWith('/') || p.startsWith('//')) return null;
  if (/[\s\p{Cc}\p{Cf}]/u.test(p)) return null;
  return p;
}
