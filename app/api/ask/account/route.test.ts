// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
const envMock = vi.hoisted(() => ({ env: { APP_PUBLIC_URL: 'https://keywordquarry.com', ASK_AI_ENABLED: '1', ASK_AI_WRITES_ENABLED: '1' } as Record<string, string | undefined> }));
vi.mock('@/lib/env', () => envMock);
vi.mock('@clerk/nextjs/server', () => ({ auth: vi.fn() }));
vi.mock('@/db/client', () => ({ db: { execute: vi.fn() } }));
const auth = vi.hoisted(() => ({ user: null as null | { id: string; role: 'admin' | 'standard_user' } }));
// A spy (the DELETE test's mock is a plain function) so the kill-switch and cross-site cases can
// pin that the session is never read.
const session = vi.hoisted(() => ({
  requireAuthenticatedUser: vi.fn(async () => {
    if (!auth.user) { const { AuthError } = await import('@/lib/auth/AuthError'); throw new AuthError('UNAUTHENTICATED', 'Not signed in'); }
    return auth.user;
  }),
}));
vi.mock('@/lib/auth/requireAuthenticatedUser', () => session);
const ledger = vi.hoisted(() => ({ getAccount: vi.fn(), setAutoApprove: vi.fn() }));
vi.mock('@/lib/ask/ledger', () => ledger);
import { AuthError } from '@/lib/auth/AuthError';
import { BAD_REQUEST_MESSAGE, CROSS_SITE_MESSAGE, TOO_LARGE_MESSAGE } from '@/lib/ask/messages';
import { PATCH } from './route';

const account = { userId: 'u1', access: true, monthlyAllowanceMicro: 10_000_000, allowanceUsedMicro: 0, periodStart: '2026-09-01', creditMicro: 0, conversationCount: 0, autoApproveChanges: false, autoApproveDeletes: false };
const headers = { 'content-type': 'application/json', origin: 'https://keywordquarry.com', 'sec-fetch-site': 'same-origin' };
const crossSite = { ...headers, origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' };
/** A string body is sent as is (bad JSON, padding), anything else as JSON; `init.headers` replaces the same-origin set. */
const patch = (body: unknown, init: { headers?: Record<string, string> } = {}) =>
  PATCH(new Request('https://keywordquarry.com/api/ask/account', { method: 'PATCH', headers: init.headers ?? headers, body: typeof body === 'string' ? body : JSON.stringify(body) }));
async function expectBodyless404(res: Response) {
  expect(res.status).toBe(404);
  expect(await res.text()).toBe('');
  expect(res.headers.get('cache-control')).toBe('no-store');
}

describe('PATCH /api/ask/account (spec 2026-10-01 §8)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envMock.env = { APP_PUBLIC_URL: 'https://keywordquarry.com', ASK_AI_ENABLED: '1', ASK_AI_WRITES_ENABLED: '1' };
    auth.user = { id: 'u1', role: 'standard_user' };
    ledger.getAccount.mockResolvedValue(account);
    ledger.setAutoApprove.mockResolvedValue(account);
  });

  it('is 404 when Ask AI or the writes flag is off, before auth', async () => {
    auth.user = null; // a session check that ran first would answer 401 instead
    envMock.env.ASK_AI_ENABLED = undefined; // the writes flag alone does not open the route
    await expectBodyless404(await patch({ autoApproveChanges: true }));
    envMock.env.ASK_AI_ENABLED = '1';
    envMock.env.ASK_AI_WRITES_ENABLED = undefined;
    await expectBodyless404(await patch({ autoApproveChanges: true }));
    // Before the origin check too: a cross-site caller gets the same nothing.
    await expectBodyless404(await patch({ autoApproveChanges: true }, { headers: crossSite }));
    expect(session.requireAuthenticatedUser).not.toHaveBeenCalled();
    expect(ledger.getAccount).not.toHaveBeenCalled();
    expect(ledger.setAutoApprove).not.toHaveBeenCalled();
  });

  it('refuses cross-site (403) and unauthenticated (401)', async () => {
    const res = await patch({ autoApproveChanges: true }, { headers: crossSite });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: CROSS_SITE_MESSAGE });
    expect(res.headers.get('cache-control')).toBe('no-store');
    // No Origin at all is not a fetch from our page either.
    expect((await patch({ autoApproveChanges: true }, { headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' } })).status).toBe(403);
    expect(session.requireAuthenticatedUser).not.toHaveBeenCalled();

    auth.user = null;
    const signedOut = await patch({ autoApproveChanges: true });
    expect(signedOut.status).toBe(401);
    expect(await signedOut.json()).toEqual({ error: 'Not signed in' });
    expect(signedOut.headers.get('cache-control')).toBe('no-store');

    // Any other AuthError code is a 403 with its fixed message.
    session.requireAuthenticatedUser.mockRejectedValueOnce(new AuthError('UNPROVISIONABLE', 'This account no longer exists.'));
    const unprovisionable = await patch({ autoApproveChanges: true });
    expect(unprovisionable.status).toBe(403);
    expect(await unprovisionable.json()).toEqual({ error: 'This account no longer exists.' });
    expect(unprovisionable.headers.get('cache-control')).toBe('no-store');

    // Anything else is not a refusal: it propagates.
    session.requireAuthenticatedUser.mockRejectedValueOnce(new Error('session store down'));
    await expect(patch({ autoApproveChanges: true })).rejects.toThrow('session store down');

    expect(ledger.getAccount).not.toHaveBeenCalled();
    expect(ledger.setAutoApprove).not.toHaveBeenCalled();
  });

  it('is 404 for an ineligible member (no access row)', async () => {
    ledger.getAccount.mockResolvedValueOnce(null);
    await expectBodyless404(await patch({ autoApproveChanges: true }));
    expect(ledger.getAccount).toHaveBeenCalledWith('u1');
    // A row whose access was revoked is the same answer.
    ledger.getAccount.mockResolvedValueOnce({ ...account, access: false });
    await expectBodyless404(await patch({ autoApproveDeletes: true }));
    expect(ledger.setAutoApprove).not.toHaveBeenCalled();
  });

  it('updates only the fields sent and answers the account\'s current values', async () => {
    ledger.setAutoApprove.mockResolvedValue({ ...account, autoApproveChanges: true, autoApproveDeletes: false });
    const res = await patch({ autoApproveChanges: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ autoApproveChanges: true, autoApproveDeletes: false });
    expect(ledger.setAutoApprove).toHaveBeenCalledWith('u1', { changes: true });
    expect(res.headers.get('cache-control')).toBe('no-store');
    // The answer is the row after the update, not an echo of the request: changes, not sent here, reads true.
    ledger.setAutoApprove.mockResolvedValueOnce({ ...account, autoApproveChanges: true, autoApproveDeletes: true });
    const deletes = await patch({ autoApproveDeletes: true });
    expect(deletes.status).toBe(200);
    expect(await deletes.json()).toEqual({ autoApproveChanges: true, autoApproveDeletes: true });
    expect(ledger.setAutoApprove).toHaveBeenLastCalledWith('u1', { deletes: true });
  });

  it('an admin without an account row is still 404 (the row appears on the first turn)', async () => {
    // askAiEligible admits an admin by role, row or not, so the update runs and finds no row to
    // update (gates.ts's ensureAccount creates it on the admin's first chat turn).
    auth.user = { id: 'u1', role: 'admin' };
    ledger.getAccount.mockResolvedValueOnce(null);
    ledger.setAutoApprove.mockResolvedValueOnce(null);
    await expectBodyless404(await patch({ autoApproveChanges: true }));
    expect(ledger.setAutoApprove).toHaveBeenCalledWith('u1', { changes: true });
    // After that turn the admin's metering row has access false; the role still admits them.
    const metering = { ...account, access: false, monthlyAllowanceMicro: 0 };
    ledger.getAccount.mockResolvedValueOnce(metering);
    ledger.setAutoApprove.mockResolvedValueOnce({ ...metering, autoApproveChanges: true });
    const res = await patch({ autoApproveChanges: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ autoApproveChanges: true, autoApproveDeletes: false });
  });

  it('rejects an empty body, an unknown key, a non-boolean and malformed JSON with 400', async () => {
    const bodies: unknown[] = [{}, { nope: true }, { autoApproveChanges: true, nope: true }, { autoApproveDeletes: 'yes' }, { autoApproveChanges: null }, 'not json', '', 'null', '[]'];
    for (const body of bodies) {
      const res = await patch(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.json()).toEqual({ error: BAD_REQUEST_MESSAGE, code: 'bad_request' });
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
    // Validated before any database call, as the DELETE route checks the id's shape first.
    expect(ledger.getAccount).not.toHaveBeenCalled();
    expect(ledger.setAutoApprove).not.toHaveBeenCalled();
  });

  it('is 404 when the account row vanished (setAutoApprove → null)', async () => {
    ledger.setAutoApprove.mockResolvedValueOnce(null); // eligible on the read, no row by the update
    await expectBodyless404(await patch({ autoApproveDeletes: false }));
    expect(ledger.setAutoApprove).toHaveBeenCalledWith('u1', { deletes: false });
  });

  it('both fields in one request reach setAutoApprove together', async () => {
    ledger.setAutoApprove.mockResolvedValueOnce({ ...account, autoApproveChanges: false, autoApproveDeletes: true });
    const res = await patch({ autoApproveChanges: false, autoApproveDeletes: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ autoApproveChanges: false, autoApproveDeletes: true });
    expect(ledger.setAutoApprove).toHaveBeenCalledTimes(1);
    expect(ledger.setAutoApprove).toHaveBeenCalledWith('u1', { changes: false, deletes: true });
  });

  it('is 413 over 1 KiB: by content-length before reading the body, by the real byte count after', async () => {
    const announced = await patch({ autoApproveChanges: true }, { headers: { ...headers, 'content-length': '5000' } });
    expect(announced.status).toBe(413);
    expect(await announced.json()).toEqual({ error: TOO_LARGE_MESSAGE });
    expect(announced.headers.get('cache-control')).toBe('no-store');
    // Valid JSON padded past the cap, with no content-length (a string body gets none here).
    const padded = await patch(`{"autoApproveChanges":true${' '.repeat(1024)}}`);
    expect(padded.status).toBe(413);
    expect(ledger.getAccount).not.toHaveBeenCalled();
    expect(ledger.setAutoApprove).not.toHaveBeenCalled();
    // Exactly 1 KiB still passes.
    const atCap = `{"autoApproveChanges":true${' '.repeat(1024 - 27)}}`;
    expect(atCap.length).toBe(1024);
    expect((await patch(atCap)).status).toBe(200);
  });
});
