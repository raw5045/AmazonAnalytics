// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DrizzleQueryError } from 'drizzle-orm';
vi.mock('@/lib/env', () => ({ env: { APP_PUBLIC_URL: 'https://keywordquarry.com' } }));
vi.mock('@clerk/nextjs/server', () => ({ auth: vi.fn() }));
vi.mock('@/db/client', () => ({ db: { execute: vi.fn() } }));
const auth = vi.hoisted(() => ({ state: 'admin' as 'admin' | 'standard_user' | 'unauthenticated' }));
vi.mock('@/lib/auth/requireAdmin', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/auth/requireAdmin')>();
  return {
    ...mod,
    requireAdmin: async () => {
      if (auth.state === 'unauthenticated') throw new mod.AuthError('UNAUTHENTICATED', 'Not signed in');
      if (auth.state === 'standard_user') throw new mod.AuthError('FORBIDDEN', 'Admin only');
      return { id: 'a1', role: 'admin' };
    },
  };
});
const ledger = vi.hoisted(() => ({ grantAccess: vi.fn(), setAllowance: vi.fn(), addCredit: vi.fn(), revokeAccess: vi.fn() }));
vi.mock('@/lib/ask/ledger', () => ledger);
const view = vi.hoisted(() => ({ findUserIdByEmail: vi.fn() }));
vi.mock('@/lib/ask/adminView', () => view);
vi.mock('@/lib/ask/config', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/ask/config')>()), defaultAllowanceMicro: () => 10_000_000 }));
import { CROSS_SITE_MESSAGE } from '@/lib/ask/messages';
import { POST } from './route';
const account = { userId: 'u1', access: true, monthlyAllowanceMicro: 10_000_000, allowanceUsedMicro: 0, periodStart: '2026-09-01', creditMicro: 0, conversationCount: 0 };
const post = (body: unknown, h: Record<string, string> = { 'content-type': 'application/json', origin: 'https://keywordquarry.com', 'sec-fetch-site': 'same-origin' }) =>
  POST(new Request('https://keywordquarry.com/api/admin/ask-ai/accounts', { method: 'POST', headers: h, body: JSON.stringify(body) }));
describe('POST /api/admin/ask-ai/accounts', () => {
  beforeEach(() => { vi.clearAllMocks(); auth.state = 'admin'; for (const fn of Object.values(ledger)) fn.mockResolvedValue(account); view.findUserIdByEmail.mockResolvedValue('u1'); });

  it('is admin-only (401 unauthenticated, 403 forbidden) and same-origin', async () => {
    auth.state = 'unauthenticated';
    expect((await post({ action: 'revoke', userId: '11111111-1111-4111-8111-111111111111' })).status).toBe(401);
    auth.state = 'standard_user';
    expect((await post({ action: 'revoke', userId: '11111111-1111-4111-8111-111111111111' })).status).toBe(403);
    auth.state = 'admin';
    expect((await post({ action: 'revoke', userId: '11111111-1111-4111-8111-111111111111' }, { origin: 'https://evil.example' })).status).toBe(403);
  });
  it('the cross-site refusal body is the shared CROSS_SITE_MESSAGE copy', async () => {
    const res = await post({ action: 'revoke', userId: '11111111-1111-4111-8111-111111111111' }, { origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: CROSS_SITE_MESSAGE });
  });
  it('rejects malformed JSON with the generic invalid-request message', async () => {
    const res = await POST(new Request('https://keywordquarry.com/api/admin/ask-ai/accounts', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://keywordquarry.com', 'sec-fetch-site': 'same-origin' }, body: '{not json' }));
    expect(res.status).toBe(400);
  });
  it('grants by email at the default allowance, 404 for an unknown email', async () => {
    const res = await post({ action: 'grant', email: 'm@example.com' });
    expect(res.status).toBe(200);
    expect(ledger.grantAccess).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', allowanceMicro: 10_000_000, adminId: 'a1' }));
    view.findUserIdByEmail.mockResolvedValueOnce(null);
    expect((await post({ action: 'grant', email: 'x@example.com' })).status).toBe(404);
  });
  it('grant with neither userId nor email is a 400 explaining what to provide (C-m4)', async () => {
    const res = await post({ action: 'grant' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Provide an email or a member id.' });
    expect(view.findUserIdByEmail).not.toHaveBeenCalled();
  });
  it('grant with both userId and email: userId wins, no email lookup (C-m4)', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const res = await post({ action: 'grant', userId: id, email: 'stale@example.com' });
    expect(res.status).toBe(200);
    expect(view.findUserIdByEmail).not.toHaveBeenCalled();
    expect(ledger.grantAccess).toHaveBeenCalledWith(expect.objectContaining({ userId: id }));
  });
  it('sets the allowance and adds credit in dollars, converting to micro-dollars; revokes', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    await post({ action: 'set_allowance', userId: id, amountUsd: 25 });
    expect(ledger.setAllowance).toHaveBeenCalledWith(expect.objectContaining({ userId: id, allowanceMicro: 25_000_000 }));
    await post({ action: 'add_credit', userId: id, amountUsd: 10, note: 'paid by invoice' });
    expect(ledger.addCredit).toHaveBeenCalledWith(expect.objectContaining({ userId: id, amountMicro: 10_000_000, note: 'paid by invoice' }));
    await post({ action: 'revoke', userId: id });
    expect(ledger.revokeAccess).toHaveBeenCalledWith(expect.objectContaining({ userId: id }));
  });
  it('a sub-micro credit amount is a 400 and never reaches addCredit (S5b)', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const res = await post({ action: 'add_credit', userId: id, amountUsd: 0.0000001, note: 'tiny' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Amount too small.' });
    expect(ledger.addCredit).not.toHaveBeenCalled();
  });
  it('validates: unknown action, credit without a note, negative amounts, missing user', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    expect((await post({ action: 'nuke', userId: id })).status).toBe(400);
    expect((await post({ action: 'add_credit', userId: id, amountUsd: 10 })).status).toBe(400);
    expect((await post({ action: 'set_allowance', userId: id, amountUsd: -1 })).status).toBe(400);
    expect((await post({ action: 'set_allowance', amountUsd: 5 })).status).toBe(400);
    ledger.setAllowance.mockResolvedValueOnce(null);
    expect((await post({ action: 'set_allowance', userId: id, amountUsd: 5 })).status).toBe(404);
  });
  it('a DrizzleQueryError-shaped failure never lets the email or note reach a console call, and answers 503 instead of the default error log (S5a)', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const email = 'sensitive-member@example.com';
    const cause1 = Object.assign(new Error('connection reset'), { code: '57P01' });
    view.findUserIdByEmail.mockRejectedValueOnce(new DrizzleQueryError('SELECT id FROM users WHERE lower(email) = $1', [email], cause1));
    const res1 = await post({ action: 'grant', email });
    expect(res1.status).toBe(503);
    expect(await res1.json()).toEqual({ error: 'Something went wrong. Try again in a minute.' });
    const note = 'a very specific private note';
    const cause2 = Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
    ledger.addCredit.mockRejectedValueOnce(new DrizzleQueryError('INSERT INTO ask_ledger (note) VALUES ($1)', [note], cause2));
    const id = '11111111-1111-4111-8111-111111111111';
    const res2 = await post({ action: 'add_credit', userId: id, amountUsd: 10, note });
    expect(res2.status).toBe(503);
    expect(await res2.json()).toEqual({ error: 'Something went wrong. Try again in a minute.' });
    const everything = error.mock.calls.flat().map((a) => (typeof a === 'string' ? a : JSON.stringify(a)));
    expect(everything.some((s) => s.includes(email))).toBe(false);
    expect(everything.some((s) => s.includes(note))).toBe(false);
    expect(everything.some((s) => s.includes('db_failed'))).toBe(true);
    error.mockRestore();
  });
});
