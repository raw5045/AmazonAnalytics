// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('@/lib/env', () => ({ env: { APP_PUBLIC_URL: 'https://keywordquarry.com' } }));
vi.mock('@clerk/nextjs/server', () => ({ auth: vi.fn() }));
vi.mock('@/db/client', () => ({ db: { execute: vi.fn() } }));
const auth = vi.hoisted(() => ({ role: 'admin' as 'admin' | 'standard_user' }));
vi.mock('@/lib/auth/requireAdmin', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/auth/requireAdmin')>();
  return { ...mod, requireAdmin: async () => { if (auth.role !== 'admin') throw new mod.AuthError('FORBIDDEN', 'Admin only'); return { id: 'a1', role: 'admin' }; } };
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
  beforeEach(() => { vi.clearAllMocks(); auth.role = 'admin'; for (const fn of Object.values(ledger)) fn.mockResolvedValue(account); view.findUserIdByEmail.mockResolvedValue('u1'); });
  it('is admin-only and same-origin', async () => {
    auth.role = 'standard_user';
    expect((await post({ action: 'revoke', userId: '11111111-1111-4111-8111-111111111111' })).status).toBe(403);
    auth.role = 'admin';
    expect((await post({ action: 'revoke', userId: '11111111-1111-4111-8111-111111111111' }, { origin: 'https://evil.example' })).status).toBe(403);
  });
  it('the cross-site refusal body is the shared CROSS_SITE_MESSAGE copy', async () => {
    const res = await post({ action: 'revoke', userId: '11111111-1111-4111-8111-111111111111' }, { origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: CROSS_SITE_MESSAGE });
  });
  it('grants by email at the default allowance, 404 for an unknown email', async () => {
    const res = await post({ action: 'grant', email: 'm@example.com' });
    expect(res.status).toBe(200);
    expect(ledger.grantAccess).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', allowanceMicro: 10_000_000, adminId: 'a1' }));
    view.findUserIdByEmail.mockResolvedValueOnce(null);
    expect((await post({ action: 'grant', email: 'x@example.com' })).status).toBe(404);
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
  it('validates: unknown action, credit without a note, negative amounts, missing user', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    expect((await post({ action: 'nuke', userId: id })).status).toBe(400);
    expect((await post({ action: 'add_credit', userId: id, amountUsd: 10 })).status).toBe(400);
    expect((await post({ action: 'set_allowance', userId: id, amountUsd: -1 })).status).toBe(400);
    expect((await post({ action: 'set_allowance', amountUsd: 5 })).status).toBe(400);
    ledger.setAllowance.mockResolvedValueOnce(null);
    expect((await post({ action: 'set_allowance', userId: id, amountUsd: 5 })).status).toBe(404);
  });
});
