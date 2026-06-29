// lib/notifications/digest/unsubToken.ts
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signed unsubscribe tokens for the weekly digest.
 *
 * Format: base64url(JSON payload) + "." + base64url(HMAC-SHA256(payload)).
 * Payload is { userId, purpose: 'unsubscribe-digest', iat }. We sign the userId
 * (rather than putting it raw in the URL) so nobody can unsubscribe another user
 * by editing the link.
 *
 * Expiry: tokens carry an issued-at (`iat`, epoch ms) and are accepted for up to
 * TOKEN_TTL_MS (1 year). Unsubscribe links must keep working from old emails, so
 * the window is deliberately generous — long enough to cover any realistic click,
 * but no longer literally "forever" (the old design). Legacy tokens (no `iat`,
 * issued before this change) are grandfathered so already-sent emails keep
 * working; they age out of inboxes naturally.
 *
 * Secret: DIGEST_UNSUB_SECRET. Falls back to a dev-only constant (with a warning)
 * so local dev works; MUST be set in production.
 */

const PURPOSE = 'unsubscribe-digest';

/** Tokens are valid for 1 year from issue. */
export const TOKEN_TTL_MS = 365 * 24 * 60 * 60 * 1000;

function secret(): string {
  const s = process.env.DIGEST_UNSUB_SECRET;
  if (!s) {
    console.warn(
      '[unsubToken] DIGEST_UNSUB_SECRET not set — using an insecure dev fallback. Set this in production.',
    );
    return 'dev-insecure-digest-secret';
  }
  return s;
}

interface UnsubPayload {
  userId: string;
  purpose: typeof PURPOSE;
  /** Issued-at, epoch ms. Absent on legacy (pre-expiry) tokens. */
  iat?: number;
}

function hmac(payloadB64: string): string {
  return createHmac('sha256', secret()).update(payloadB64).digest('base64url');
}

/**
 * Sign an unsubscribe token. `issuedAt` is injectable for tests; defaults to now.
 */
export function signUnsubToken(userId: string, issuedAt: number = Date.now()): string {
  const payload: UnsubPayload = { userId, purpose: PURPOSE, iat: issuedAt };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${payloadB64}.${hmac(payloadB64)}`;
}

/**
 * Verify an unsubscribe token. `now` is injectable for tests; defaults to now.
 * Returns null for any bad/expired token.
 */
export function verifyUnsubToken(
  token: string,
  now: number = Date.now(),
): { userId: string } | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;

  // Constant-time signature comparison.
  const expected = hmac(payloadB64);
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(payloadB64, 'base64url').toString('utf8'),
    ) as Partial<UnsubPayload>;
    if (payload.purpose !== PURPOSE || typeof payload.userId !== 'string') {
      return null;
    }
    // Enforce expiry when an iat is present; grandfather legacy (no-iat) tokens.
    if (typeof payload.iat === 'number' && now - payload.iat > TOKEN_TTL_MS) {
      return null;
    }
    return { userId: payload.userId };
  } catch {
    return null;
  }
}
