import { describe, it, expect, vi } from 'vitest';
const envMock = vi.hoisted(() => ({ env: { CLERK_SECRET_KEY: 'sk_test_fixed' } as Record<string, string | undefined> }));
vi.mock('@/lib/env', () => envMock);
import { cursorSecret, signCursor, verifyCursor, type CursorPayload } from './cursor';
import { searchRequestSchema } from './contracts';

const payload: CursorPayload = {
  v: 1,
  req: searchRequestSchema.parse({ schemaVersion: 1, filters: { averageReviews: { lt: 500 } } }),
  snap: '9d2c7a1e-0000-4000-8000-000000000001',
  off: 50,
  ps: 50,
  exp: 2_000_000_000,
  uid: 'uuid-user',
  ch: 'mcp',
  tm: { kind: 'exact', value: 137 },
};
const NOW = 1_999_999_000;

describe('cursor', () => {
  it('round-trips a payload under the right secret', () => {
    const token = signCursor(payload, 'secret-a');
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(verifyCursor(token, 'secret-a', NOW)).toEqual(payload);
  });
  it('rejects a tampered body, a wrong secret, and garbage as INVALID_CURSOR', () => {
    const token = signCursor(payload, 'secret-a');
    const [body, mac] = token.split('.');
    const flipped = (body[10] === 'A' ? 'B' : 'A') + body.slice(1);
    expect(() => verifyCursor(`${flipped}.${mac}`, 'secret-a', NOW)).toThrow(expect.objectContaining({ code: 'INVALID_CURSOR' }));
    expect(() => verifyCursor(token, 'secret-b', NOW)).toThrow(expect.objectContaining({ code: 'INVALID_CURSOR' }));
    expect(() => verifyCursor('not-a-cursor', 'secret-a', NOW)).toThrow(expect.objectContaining({ code: 'INVALID_CURSOR' }));
    expect(() => verifyCursor('a'.repeat(9000), 'secret-a', NOW)).toThrow(expect.objectContaining({ code: 'INVALID_CURSOR' }));
  });
  it('reports an expired cursor as SEARCH_EXPIRED', () => {
    const token = signCursor({ ...payload, exp: NOW - 1 }, 'secret-a');
    expect(() => verifyCursor(token, 'secret-a', NOW)).toThrow(expect.objectContaining({ code: 'SEARCH_EXPIRED' }));
  });
  it('derives a stable secret from CLERK_SECRET_KEY when RESEARCH_CURSOR_SECRET is unset, and prefers the explicit one', () => {
    delete envMock.env.RESEARCH_CURSOR_SECRET;
    const derived = cursorSecret();
    expect(derived).toHaveLength(64);
    expect(cursorSecret()).toBe(derived);
    envMock.env.RESEARCH_CURSOR_SECRET = 'explicit';
    expect(cursorSecret()).toBe('explicit');
  });
});

describe('verifyCursor field hardening beyond the base spec', () => {
  // Bypasses CursorPayload's own type checking so a deliberately malformed payload can still be
  // signed and handed to verifyCursor, the same way a forged or bit-rotted cursor would arrive.
  const sign = (over: Record<string, unknown>) => signCursor({ ...payload, ...over } as unknown as CursorPayload, 'secret-a');
  const rejects = (over: Record<string, unknown>) => expect(() => verifyCursor(sign(over), 'secret-a', NOW)).toThrow(expect.objectContaining({ code: 'INVALID_CURSOR' }));

  it('rejects a non-integer or negative off/ps', () => {
    rejects({ off: 1.5 });
    rejects({ off: -1 });
    rejects({ ps: 1.5 });
    rejects({ ps: -1 });
  });

  it('rejects a wrong-typed ps, snap, or ch', () => {
    rejects({ ps: '50' });
    rejects({ snap: 12345 });
    rejects({ ch: 'web' });
  });

  it('rejects a non-object or null req, and one that is an object but fails searchRequestSchema', () => {
    rejects({ req: null });
    rejects({ req: 'nope' });
    // An object, but pageSize is past the schema's max of 100 — the service re-applies presets
    // from req, so a structurally-plausible-but-invalid request must not verify successfully.
    rejects({ req: { schemaVersion: 1, pageSize: 999 } });
  });

  it('rejects a tm that is not an object, or whose kind is not one of the three documented TotalMatches kinds', () => {
    rejects({ tm: 'exact' });
    rejects({ tm: null });
    rejects({ tm: { kind: 'approximate', value: 1 } });
  });
});
