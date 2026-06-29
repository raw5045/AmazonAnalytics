// lib/notifications/digest/unsubToken.test.ts
import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { signUnsubToken, verifyUnsubToken, TOKEN_TTL_MS } from './unsubToken';

const USER_ID = '00000000-0000-0000-0000-000000000001';
const NOW = 1_700_000_000_000;

describe('unsubToken', () => {
  it('round-trips a userId through sign → verify', () => {
    const token = signUnsubToken(USER_ID, NOW);
    expect(verifyUnsubToken(token, NOW + 1000)).toEqual({ userId: USER_ID });
  });

  it('returns null for a tampered token', () => {
    const token = signUnsubToken(USER_ID);
    const tampered = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a');
    expect(verifyUnsubToken(tampered)).toBeNull();
  });

  it('returns null for a token with the wrong number of parts', () => {
    expect(verifyUnsubToken('garbage')).toBeNull();
    expect(verifyUnsubToken('a.b.c')).toBeNull();
  });

  it('returns null for a payload with the wrong purpose', () => {
    const token = signUnsubToken(USER_ID);
    const [, sig] = token.split('.');
    const fakePayload = Buffer.from(
      JSON.stringify({ userId: USER_ID, purpose: 'something-else' }),
    ).toString('base64url');
    expect(verifyUnsubToken(`${fakePayload}.${sig}`)).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(verifyUnsubToken('')).toBeNull();
  });

  it('rejects a token past its TTL', () => {
    const token = signUnsubToken(USER_ID, NOW);
    expect(verifyUnsubToken(token, NOW + TOKEN_TTL_MS + 1)).toBeNull();
  });

  it('accepts a token right at the TTL boundary', () => {
    const token = signUnsubToken(USER_ID, NOW);
    expect(verifyUnsubToken(token, NOW + TOKEN_TTL_MS)).toEqual({ userId: USER_ID });
  });

  it('grandfathers a legacy token with no iat (never expires)', () => {
    // Reconstruct a pre-expiry token (payload had no `iat`), signed with the
    // same secret the module uses, so already-sent emails keep working.
    const SECRET = process.env.DIGEST_UNSUB_SECRET ?? 'dev-insecure-digest-secret';
    const payloadB64 = Buffer.from(
      JSON.stringify({ userId: USER_ID, purpose: 'unsubscribe-digest' }),
    ).toString('base64url');
    const sig = createHmac('sha256', SECRET).update(payloadB64).digest('base64url');
    const legacy = `${payloadB64}.${sig}`;
    // Even far in the future, a legacy token still verifies.
    expect(verifyUnsubToken(legacy, NOW + TOKEN_TTL_MS * 10)).toEqual({ userId: USER_ID });
  });
});
