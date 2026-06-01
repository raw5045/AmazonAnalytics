// lib/notifications/digest/unsubToken.ts
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signed, non-expiring unsubscribe tokens for the weekly digest.
 *
 * Format: base64url(JSON payload) + "." + base64url(HMAC-SHA256(payload)).
 * The payload is { userId, purpose: 'unsubscribe-digest' }. We sign the
 * userId (rather than putting it raw in the URL) so nobody can
 * unsubscribe another user by editing the link. No expiry — an
 * unsubscribe link from an old email must always work.
 *
 * Secret: DIGEST_UNSUB_SECRET. Falls back to a dev-only constant (with a
 * warning) so local dev works; MUST be set in production.
 */

const PURPOSE = 'unsubscribe-digest';

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
}

function hmac(payloadB64: string): string {
  return createHmac('sha256', secret()).update(payloadB64).digest('base64url');
}

export function signUnsubToken(userId: string): string {
  const payload: UnsubPayload = { userId, purpose: PURPOSE };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${payloadB64}.${hmac(payloadB64)}`;
}

export function verifyUnsubToken(token: string): { userId: string } | null {
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
    return { userId: payload.userId };
  } catch {
    return null;
  }
}
