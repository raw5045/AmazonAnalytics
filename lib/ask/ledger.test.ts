import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('@/lib/env', () => ({ env: { DATABASE_URL: 'postgres://test' } }));
const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('@/db/client', () => ({ db: { execute } }));
import { monthStartUtc, balanceMicro, ensureAccount, getAccount, resetPeriodIfDue, settleTurn, grantAccess, setAllowance, addCredit, revokeAccess, globalUsageForMonth, markCeilingAlert, sumRemainingAllowances, countMemberAccountsWithAccess } from './ledger';

const row = { user_id: 'u1', access: true, monthly_allowance_micro: '10000000', allowance_used_micro: '2500000', period_start: '2026-09-01', credit_micro: '0', conversation_count: 2 };
const sqlOf = (i = 0) => JSON.stringify(execute.mock.calls[i][0]);

describe('ledger', () => {
  beforeEach(() => vi.clearAllMocks());

  it('monthStartUtc floors to the first of the UTC month', () => {
    expect(monthStartUtc(new Date('2026-09-28T23:59:59Z'))).toBe('2026-09-01');
    expect(monthStartUtc(new Date('2026-12-31T23:59:59Z'))).toBe('2026-12-01');
  });
  it('balance = unused allowance (floored at 0) + credit', () => {
    expect(balanceMicro({ monthlyAllowanceMicro: 10, allowanceUsedMicro: 3, creditMicro: 5 })).toBe(12);
    expect(balanceMicro({ monthlyAllowanceMicro: 10, allowanceUsedMicro: 30, creditMicro: 5 })).toBe(5);
  });
  it('getAccount maps bigint strings to numbers and returns null when absent', async () => {
    execute.mockResolvedValueOnce({ rows: [row] });
    await expect(getAccount('u1')).resolves.toEqual({ userId: 'u1', access: true, monthlyAllowanceMicro: 10_000_000, allowanceUsedMicro: 2_500_000, periodStart: '2026-09-01', creditMicro: 0, conversationCount: 2 });
    execute.mockResolvedValueOnce({ rows: [] });
    await expect(getAccount('u1')).resolves.toBeNull();
  });
  it('ensureAccount inserts a metering row on conflict-do-nothing and returns the row', async () => {
    execute.mockResolvedValueOnce({ rows: [{ ...row, access: false, monthly_allowance_micro: '0' }] });
    const a = await ensureAccount('u1', new Date('2026-09-28T00:00:00Z'), { access: false, allowanceMicro: 0 });
    expect(a.access).toBe(false);
    expect(sqlOf()).toContain('ON CONFLICT (user_id) DO UPDATE SET updated_at');
    expect(sqlOf()).toContain('2026-09-01');
  });
  it('resetPeriodIfDue resets used-to-zero and moves period_start in one statement that also writes the ledger entry', async () => {
    execute.mockResolvedValueOnce({ rows: [{ ...row, allowance_used_micro: '0', period_start: '2026-10-01' }] });
    const a = await resetPeriodIfDue('u1', new Date('2026-10-02T00:00:00Z'));
    expect(a?.allowanceUsedMicro).toBe(0);
    expect(sqlOf()).toContain('period_start < ');
    expect(sqlOf()).toContain("'allowance_reset'");
  });
  it('settleTurn is one statement: split, update, ledger, global counter', async () => {
    execute.mockResolvedValueOnce({ rows: [{ from_allowance: '24500', from_credit: '0', global_cost_micro: '124500', global_questions: 7 }] });
    const r = await settleTurn({ userId: 'u1', conversationId: 'c1', messageId: 'm1', model: 'claude-sonnet-5', usage: { noCacheTokens: 5000, cacheWriteTokens: 1000, cacheReadTokens: 10000, outputTokens: 1000 }, costMicro: 24_500, now: new Date('2026-09-28T12:00:00Z') });
    expect(r).toEqual({ fromAllowanceMicro: 24_500, fromCreditMicro: 0, absorbedMicro: 0, globalCostMicro: 124_500, globalQuestions: 7 });
    const s = sqlOf();
    for (const fragment of ['FOR UPDATE', 'LEAST(', "'usage'", 'INSERT INTO ask_global_usage', 'ON CONFLICT (month) DO UPDATE']) expect(s).toContain(fragment);
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('settleTurn throws when the account row is missing (nothing to settle against)', async () => {
    execute.mockResolvedValueOnce({ rows: [] });
    await expect(settleTurn({ userId: 'u1', conversationId: 'c1', messageId: 'm1', model: 'claude-sonnet-5', usage: { noCacheTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 }, costMicro: 2, now: new Date() })).rejects.toThrow(/no ask_accounts row/);
  });
  it('admin operations upsert and write a ledger entry with the admin as created_by', async () => {
    execute.mockResolvedValue({ rows: [row] });
    await grantAccess({ userId: 'u1', allowanceMicro: 10_000_000, adminId: 'a1', now: new Date('2026-09-28T00:00:00Z') });
    expect(sqlOf(0)).toContain("'grant'");
    await setAllowance({ userId: 'u1', allowanceMicro: 5_000_000, adminId: 'a1', now: new Date() });
    expect(sqlOf(1)).toContain("'adjustment'");
    await addCredit({ userId: 'u1', amountMicro: 10_000_000, adminId: 'a1', note: 'manual top-up', now: new Date() });
    expect(sqlOf(2)).toContain("'credit'");
    expect(sqlOf(2)).toContain('manual top-up');
    await revokeAccess({ userId: 'u1', adminId: 'a1', now: new Date() });
    expect(sqlOf(3)).toContain("'revoke'");
    expect(sqlOf(3)).toContain('access = false');
  });
  it('addCredit rejects a non-positive amount before any DB call', async () => {
    await expect(addCredit({ userId: 'u1', amountMicro: 0, adminId: 'a1', note: 'x', now: new Date() })).rejects.toThrow(/positive/);
    expect(execute).not.toHaveBeenCalled();
  });
  it('global usage and alerts', async () => {
    execute.mockResolvedValueOnce({ rows: [{ month: '2026-09-01', cost_micro: '5', questions: 1, alerted_80_at: null, alerted_100_at: null }] });
    await expect(globalUsageForMonth('2026-09-01')).resolves.toEqual({ month: '2026-09-01', costMicro: 5, questions: 1, alerted80At: null, alerted100At: null });
    execute.mockResolvedValueOnce({ rows: [] });
    await expect(globalUsageForMonth('2026-08-01')).resolves.toEqual({ month: '2026-08-01', costMicro: 0, questions: 0, alerted80At: null, alerted100At: null });
    execute.mockResolvedValueOnce({ rows: [{ month: '2026-09-01' }] });
    await expect(markCeilingAlert('2026-09-01', 80, new Date())).resolves.toBe(true);
    execute.mockResolvedValueOnce({ rows: [] });
    await expect(markCeilingAlert('2026-09-01', 100, new Date())).resolves.toBe(false);
    // Task 5 deviation (see the blockquote under docs/superpowers/plans/2026-09-28-ask-ai.md's
    // Task 5 heading): the level-80 column name is interpolated via sql.raw() and embedded in the
    // outer template, so drizzle nests it as its own SQL object rather than a flat string chunk —
    // 'alerted_80_at IS NULL' is never a contiguous substring of JSON.stringify(query) even though
    // both pieces are present. Asserted separately instead of weakening the SQL.
    expect(sqlOf(2)).toContain('alerted_80_at');
    expect(sqlOf(2)).toContain('IS NULL');
  });
  it('admin aggregates', async () => {
    execute.mockResolvedValueOnce({ rows: [{ total: '12345' }] });
    await expect(sumRemainingAllowances(new Date('2026-09-28T00:00:00Z'))).resolves.toBe(12_345);
    execute.mockResolvedValueOnce({ rows: [{ n: '3' }] });
    await expect(countMemberAccountsWithAccess()).resolves.toBe(3);
  });
});
