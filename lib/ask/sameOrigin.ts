import { env } from '@/lib/env';

/**
 * Spec §13: cookie-authenticated mutations accept only same-origin browser requests. Browsers send
 * `Origin` on every POST/DELETE (same-origin included) and `Sec-Fetch-Site` on every request; a
 * missing Origin therefore means "not a browser form/fetch from our page" and is refused.
 */
export function isSameOrigin(req: Request): boolean {
  const site = req.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers.get('origin');
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(env.APP_PUBLIC_URL).origin;
  } catch {
    return false;
  }
}
