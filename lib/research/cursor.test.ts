import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
const envMock = vi.hoisted(() => ({ env: { CLERK_SECRET_KEY: 'sk_test_fixed' } as Record<string, string | undefined> }));
vi.mock('@/lib/env', () => envMock);
import { cursorSecret, signCursor, verifyCursor, type CursorPayload } from './cursor';
import { searchRequestSchema } from './contracts';

// The 'derives a stable secret ...' test below mutates envMock.env.RESEARCH_CURSOR_SECRET (it has
// to, to exercise both the derived and the explicit-secret paths); restore it after every test so
// that mutation can never leak into a later test in this file (see lib/research/limits.test.ts for
// the same envMock-hygiene convention).
afterEach(() => {
  delete envMock.env.RESEARCH_CURSOR_SECRET;
});

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
  it('rejects a forged-but-parseable body under the original MAC, a wrong secret, and garbage as INVALID_CURSOR', () => {
    const token = signCursor(payload, 'secret-a');
    const [, mac] = token.split('.');
    // Unlike flipping a byte of the encoded body (which almost always decodes to invalid JSON
    // and so would still be rejected even with the MAC check deleted entirely), this body is
    // well-formed and parseable — it only fails because it isn't the body `mac` was computed
    // over. That makes this assertion actually discriminate a working MAC check from a deleted
    // one; see the temporarily-broken-MAC verification note in the PR description.
    const forgedBody = Buffer.from(JSON.stringify({ ...payload, off: 0, exp: 9_999_999_999 })).toString('base64url');
    expect(() => verifyCursor(`${forgedBody}.${mac}`, 'secret-a', NOW)).toThrow(expect.objectContaining({ code: 'INVALID_CURSOR' }));
    expect(() => verifyCursor(token, 'secret-b', NOW)).toThrow(expect.objectContaining({ code: 'INVALID_CURSOR' }));
    expect(() => verifyCursor('not-a-cursor', 'secret-a', NOW)).toThrow(expect.objectContaining({ code: 'INVALID_CURSOR' }));
    expect(() => verifyCursor('a'.repeat(9000), 'secret-a', NOW)).toThrow(expect.objectContaining({ code: 'INVALID_CURSOR' }));
  });
  it('rejects a MAC with a lenient-decoder-style trailing "=" as INVALID_CURSOR', () => {
    // verifyCursor compares the *encoded* mac string (Buffer.from(token.slice(dot+1)), no
    // transfer encoding), not base64url-decoded bytes. A trailing '=' is not part of the
    // canonical base64url alphabet used here, but a lenient decoder tolerates it as padding and
    // would decode 'mac=' to the same bytes as 'mac' — which, under a decode-then-compare MAC
    // check, would make this forged token indistinguishable from the original. Comparing the
    // encoded strings themselves makes the length differ immediately, so this is INVALID_CURSOR.
    const token = signCursor(payload, 'secret-a');
    expect(() => verifyCursor(`${token}=`, 'secret-a', NOW)).toThrow(expect.objectContaining({ code: 'INVALID_CURSOR' }));
  });
  it('reports an expired cursor as SEARCH_EXPIRED, including exactly at the expiry second', () => {
    const token = signCursor({ ...payload, exp: NOW - 1 }, 'secret-a');
    expect(() => verifyCursor(token, 'secret-a', NOW)).toThrow(expect.objectContaining({ code: 'SEARCH_EXPIRED' }));
    const boundary = signCursor({ ...payload, exp: NOW }, 'secret-a');
    expect(() => verifyCursor(boundary, 'secret-a', NOW)).toThrow(expect.objectContaining({ code: 'SEARCH_EXPIRED' }));
  });
  it('derives a stable, 64-character hex secret from CLERK_SECRET_KEY when RESEARCH_CURSOR_SECRET is unset, and prefers the explicit one', () => {
    delete envMock.env.RESEARCH_CURSOR_SECRET;
    const derived = cursorSecret();
    expect(derived).toHaveLength(64);
    expect(derived).toMatch(/^[0-9a-f]{64}$/);
    expect(cursorSecret()).toBe(derived);
    envMock.env.RESEARCH_CURSOR_SECRET = 'explicit';
    expect(cursorSecret()).toBe('explicit');
  });
  it('refuses to sign a cursor past MAX_CURSOR_LENGTH as RESPONSE_TOO_LARGE', () => {
    const leafPaths = Array.from({ length: 60 }, (_, i) => `Category/Sub/${'x'.repeat(120)}/${i}`);
    const req = searchRequestSchema.parse({ schemaVersion: 1, filters: { categories: { leafPaths } } });
    expect(() => signCursor({ ...payload, req }, 'secret-a')).toThrow(expect.objectContaining({ code: 'RESPONSE_TOO_LARGE' }));
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

  it('rejects a tm.value of the wrong type, and a tm carrying an extra key', () => {
    rejects({ tm: { kind: 'exact', value: 'lots' } });
    rejects({ tm: { kind: 'exact', value: 1, extra: true } });
  });

  it('reconstructs a valid tm with exactly its declared keys — no extra keys survive', () => {
    const token = signCursor(payload, 'secret-a');
    const result = verifyCursor(token, 'secret-a', NOW);
    expect(Object.keys(result.tm).sort()).toEqual(['kind', 'value']);
  });

  it('rejects the numeric edge cases the old hand-rolled checks let through: ps: 0 and a non-safe-integer off', () => {
    // Previously accepted: Number.isInteger(0) && 0 >= 0 is true (ps had no lower bound), and
    // Number.isInteger(1e300) is also true (every representable double at that magnitude has no
    // fractional part) even though it is nowhere near a usable offset.
    rejects({ ps: 0 });
    rejects({ off: 1e300 });
  });

  it('rejects a body whose JSON literally carries an exponent past the safe-integer range (e.g. "exp":1e400) as INVALID_CURSOR', () => {
    // 1e400 parses to Infinity (JSON's number grammar has no magnitude cap; double overflow does
    // the rest) — which the old typeof-only exp check accepted outright (typeof Infinity ===
    // 'number'), and which would then never satisfy `exp <= nowSeconds`, i.e. a cursor that can
    // never expire. Built by hand, via string replacement on a real signed body, because no
    // CursorPayload value stringifies to the literal text "1e400" — this reproduces exactly the
    // bytes a forged or bit-rotted cursor could carry, the same way the forged-body test above
    // does for a tampered `off`.
    const signedBody = signCursor(payload, 'secret-a').split('.')[0];
    const rawText = Buffer.from(signedBody, 'base64url').toString('utf8');
    expect(rawText).toContain('"exp":2000000000');
    const forgedText = rawText.replace('"exp":2000000000', '"exp":1e400');
    const forgedBody = Buffer.from(forgedText, 'utf8').toString('base64url');
    const forgedMac = createHmac('sha256', 'secret-a').update(forgedBody).digest('base64url');
    expect(() => verifyCursor(`${forgedBody}.${forgedMac}`, 'secret-a', NOW)).toThrow(expect.objectContaining({ code: 'INVALID_CURSOR' }));
  });
});
