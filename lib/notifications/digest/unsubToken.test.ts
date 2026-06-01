// lib/notifications/digest/unsubToken.test.ts
import { describe, it, expect } from 'vitest';
import { signUnsubToken, verifyUnsubToken } from './unsubToken';

const USER_ID = '00000000-0000-0000-0000-000000000001';

describe('unsubToken', () => {
  it('round-trips a userId through sign → verify', () => {
    const token = signUnsubToken(USER_ID);
    expect(verifyUnsubToken(token)).toEqual({ userId: USER_ID });
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
});
