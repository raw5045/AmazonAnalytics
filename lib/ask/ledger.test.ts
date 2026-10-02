import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('@/lib/env', () => ({ env: { DATABASE_URL: 'postgres://test' } }));
const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('@/db/client', () => ({ db: { execute } }));
import { PgDialect } from 'drizzle-orm/pg-core';
import { monthStartUtc, balanceMicro, ensureAccount, getAccount, resetPeriodIfDue, settleTurn, grantAccess, setAllowance, addCredit, revokeAccess, globalUsageForMonth, markCeilingAlert, sumRemainingAllowances, countMemberAccountsWithAccess, setAutoApprove } from './ledger';

const row = { user_id: 'u1', access: true, monthly_allowance_micro: '10000000', allowance_used_micro: '2500000', period_start: '2026-09-01', credit_micro: '0', conversation_count: 2, auto_approve_changes: false, auto_approve_deletes: false };
// Renders the real SQL text (placeholders as $1, $2…) and the bound parameter values separately —
// a `sql.raw()` fragment (e.g. markCeilingAlert's column name) is inlined into the SQL text, not a
// parameter, so substring checks on it belong on sqlOf(); an interpolated VALUE only ever shows up
// in paramsOf(), never as literal text in sqlOf().
const dialect = new PgDialect();
const sqlOf = (i = 0) => dialect.sqlToQuery(execute.mock.calls[i][0]).sql;
const paramsOf = (i = 0) => dialect.sqlToQuery(execute.mock.calls[i][0]).params;

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
    await expect(getAccount('u1')).resolves.toEqual({ userId: 'u1', access: true, monthlyAllowanceMicro: 10_000_000, allowanceUsedMicro: 2_500_000, periodStart: '2026-09-01', creditMicro: 0, conversationCount: 2, autoApproveChanges: false, autoApproveDeletes: false });
    execute.mockResolvedValueOnce({ rows: [] });
    await expect(getAccount('u1')).resolves.toBeNull();
  });
  it('ensureAccount inserts a metering row, a no-op DO UPDATE on conflict, and returns the row', async () => {
    execute.mockResolvedValueOnce({ rows: [{ ...row, access: false, monthly_allowance_micro: '0' }] });
    const a = await ensureAccount('u1', new Date('2026-09-28T00:00:00Z'), { access: false, allowanceMicro: 0 });
    expect(a.access).toBe(false);
    expect(sqlOf()).toContain('ON CONFLICT (user_id) DO UPDATE SET updated_at');
    expect(paramsOf()).toContain('2026-09-01');
  });
  it('resetPeriodIfDue resets used-to-zero and moves period_start in one statement that also writes the ledger entry, reading the result back snapshot-independently', async () => {
    execute.mockResolvedValueOnce({ rows: [{ ...row, allowance_used_micro: '0', period_start: '2026-10-01' }] });
    const a = await resetPeriodIfDue('u1', new Date('2026-10-02T00:00:00Z'));
    expect(a?.allowanceUsedMicro).toBe(0);
    expect(sqlOf()).toContain('period_start < ');
    expect(sqlOf()).toContain("'allowance_reset'");
    // The final SELECT mirrors `due`'s WHERE/SET rather than reading allowance_used_micro/
    // period_start back from ask_accounts: per Postgres docs 7.8.4 a data-modifying CTE's effects
    // are invisible to the primary query's own snapshot, so a plain re-read would return last
    // month's stale values right after the reset — and the same mirrored form is also correct for
    // a caller that loses a race against a concurrent reset for the same user, since its snapshot
    // may predate the winner's commit. This is only pinned at the SQL-text level: the mock just
    // returns whatever row it's given, so it can't prove the CASE logic is correct at runtime —
    // the integration test is the real proof.
    expect(sqlOf()).toContain('CASE WHEN period_start <');
    expect(sqlOf()).toContain('GREATEST(period_start, ');
  });
  it('settleTurn is one statement: split, update, ledger, global counter', async () => {
    execute.mockResolvedValueOnce({ rows: [{ from_allowance: '24500', from_credit: '0', global_cost_micro: '124500', global_questions: 7 }] });
    const r = await settleTurn({ userId: 'u1', conversationId: 'c1', messageId: 'm1', model: 'claude-sonnet-5', usage: { noCacheTokens: 5000, cacheWriteTokens: 1000, cacheReadTokens: 10000, outputTokens: 1000 }, costMicro: 24_500, now: new Date('2026-09-28T12:00:00Z') });
    expect(r).toEqual({ fromAllowanceMicro: 24_500, fromCreditMicro: 0, absorbedMicro: 0, globalCostMicro: 124_500, globalQuestions: 7 });
    const s = sqlOf();
    // The global-usage insert is sourced FROM upd (not a bare VALUES): it only runs when the
    // account update actually produced a row, so a missing account can never bump the global
    // counter even though the statement as a whole still correctly returns no row either way.
    // (The question count is a bound value since arc 4 — see the countQuestion tests below.)
    for (const fragment of ['FOR UPDATE', 'LEAST(', "'usage'", 'INSERT INTO ask_global_usage', '::int FROM upd', 'ON CONFLICT (month) DO UPDATE']) expect(s).toContain(fragment);
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('settleTurn computes absorbedMicro as the remainder after allowance and credit are exhausted', async () => {
    execute.mockResolvedValueOnce({ rows: [{ from_allowance: '100', from_credit: '50', global_cost_micro: '100', global_questions: 1 }] });
    const r = await settleTurn({ userId: 'u1', conversationId: 'c1', messageId: 'm1', model: 'claude-sonnet-5', usage: { noCacheTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 }, costMicro: 240, now: new Date('2026-09-28T12:00:00Z') });
    expect(r.absorbedMicro).toBe(90); // 240 - 100 - 50
  });
  it('settleTurn throws when the account row is missing (nothing to settle against)', async () => {
    execute.mockResolvedValueOnce({ rows: [] });
    await expect(settleTurn({ userId: 'u1', conversationId: 'c1', messageId: 'm1', model: 'claude-sonnet-5', usage: { noCacheTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 }, costMicro: 2, now: new Date() })).rejects.toThrow(/no ask_accounts row/);
  });
  it('settleTurn rejects a negative costMicro before any DB call', async () => {
    await expect(settleTurn({ userId: 'u1', conversationId: 'c1', messageId: 'm1', model: 'claude-sonnet-5', usage: { noCacheTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 }, costMicro: -1, now: new Date() })).rejects.toThrow(/non-negative/);
    expect(execute).not.toHaveBeenCalled();
  });
  it('admin operations upsert and write a ledger entry with the admin as created_by', async () => {
    execute.mockResolvedValue({ rows: [row] });
    await grantAccess({ userId: 'u1', allowanceMicro: 10_000_000, adminId: 'a1', now: new Date('2026-09-28T00:00:00Z') });
    expect(sqlOf(0)).toContain("'grant'");
    await setAllowance({ userId: 'u1', allowanceMicro: 5_000_000, adminId: 'a1', now: new Date() });
    expect(sqlOf(1)).toContain("'adjustment'");
    await addCredit({ userId: 'u1', amountMicro: 10_000_000, adminId: 'a1', note: 'manual top-up', now: new Date() });
    expect(sqlOf(2)).toContain("'credit'");
    expect(paramsOf(2)).toContain('manual top-up');
    await revokeAccess({ userId: 'u1', adminId: 'a1', now: new Date() });
    expect(sqlOf(3)).toContain("'revoke'");
    expect(sqlOf(3)).toContain('access = false');
  });
  it('grantAccess rejects a negative allowanceMicro before any DB call', async () => {
    await expect(grantAccess({ userId: 'u1', allowanceMicro: -1, adminId: 'a1', now: new Date() })).rejects.toThrow(/non-negative/);
    expect(execute).not.toHaveBeenCalled();
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
    // sql.raw()'s column-name fragment is inlined into the SQL text by drizzle's PgDialect, so this
    // is a genuinely contiguous substring (unlike the earlier JSON.stringify-based sqlOf, where the
    // raw fragment serialized as its own nested SQL object and split this exact text in two).
    expect(sqlOf(2)).toContain('alerted_80_at IS NULL');
  });
  it('admin aggregates', async () => {
    execute.mockResolvedValueOnce({ rows: [{ total: '12345' }] });
    await expect(sumRemainingAllowances(new Date('2026-09-28T00:00:00Z'))).resolves.toBe(12_345);
    execute.mockResolvedValueOnce({ rows: [{ n: '3' }] });
    await expect(countMemberAccountsWithAccess()).resolves.toBe(3);
  });
});

describe('write toggles (arc 4)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('getAccount maps the two toggles', async () => {
    execute.mockResolvedValueOnce({ rows: [{ ...row, auto_approve_changes: true, auto_approve_deletes: false }] });
    await expect(getAccount('u1')).resolves.toMatchObject({ autoApproveChanges: true, autoApproveDeletes: false });
    expect(sqlOf()).toContain('auto_approve_changes, auto_approve_deletes');
  });
  it('resetPeriodIfDue reads the two toggles back too (the gates and the /ask page take the account from it)', async () => {
    execute.mockResolvedValueOnce({ rows: [{ ...row, auto_approve_changes: false, auto_approve_deletes: true }] });
    await expect(resetPeriodIfDue('u1', new Date('2026-10-02T00:00:00Z'))).resolves.toMatchObject({ autoApproveChanges: false, autoApproveDeletes: true });
    expect(sqlOf()).toContain('credit_micro, conversation_count, auto_approve_changes, auto_approve_deletes');
  });
  it('setAutoApprove updates only the fields given, owner-scoped, and returns the row', async () => {
    execute.mockResolvedValueOnce({ rows: [{ ...row, auto_approve_changes: true, auto_approve_deletes: false }] });
    await expect(setAutoApprove('u1', { changes: true })).resolves.toMatchObject({ autoApproveChanges: true, autoApproveDeletes: false });
    expect(sqlOf()).toContain('auto_approve_changes = COALESCE($1::boolean, auto_approve_changes)');
    expect(sqlOf()).toContain('auto_approve_deletes = COALESCE($2::boolean, auto_approve_deletes)');
    expect(sqlOf()).toContain('WHERE user_id = $3::uuid');
    expect(sqlOf()).toContain('RETURNING user_id, access');
    expect(paramsOf()).toEqual([true, null, 'u1']);
  });
  it('setAutoApprove binds false as a value (turning a toggle off), not as "leave as is"', async () => {
    execute.mockResolvedValueOnce({ rows: [row] });
    await setAutoApprove('u1', { changes: false });
    expect(paramsOf()).toEqual([false, null, 'u1']);
  });
  it('setAutoApprove returns null when the account row is missing', async () => {
    execute.mockResolvedValueOnce({ rows: [] });
    await expect(setAutoApprove('u1', { deletes: true })).resolves.toBeNull();
    expect(paramsOf()).toEqual([null, true, 'u1']);
  });
});

describe('settleTurn countQuestion (arc 4: an approval resume is a billed turn, not a question)', () => {
  beforeEach(() => vi.clearAllMocks());
  const args = { userId: 'u1', conversationId: 'c1', messageId: 'm1', model: 'claude-sonnet-5' as const, usage: { noCacheTokens: 5000, cacheWriteTokens: 1000, cacheReadTokens: 10000, outputTokens: 1000 }, costMicro: 24_500, now: new Date('2026-09-28T12:00:00Z') };
  const settled = { rows: [{ from_allowance: '24500', from_credit: '0', global_cost_micro: '124500', global_questions: 7 }] };
  /** 0-based positions in paramsOf(i) of the two values that count the question: the inserted `questions` and the conflict increment. */
  const questionParams = (i: number): [number, number] => {
    const s = sqlOf(i);
    const inserted = /SELECT \$\d+::date, \$\d+::bigint, \$(\d+)::int FROM upd/.exec(s);
    const increment = /questions = ask_global_usage\.questions \+ \$(\d+)::int/.exec(s);
    if (!inserted || !increment) throw new Error('the ask_global_usage upsert changed shape');
    return [Number(inserted[1]) - 1, Number(increment[1]) - 1];
  };

  it('counts one question with no options and with countQuestion: true, binding 1 for both the inserted value and the increment', async () => {
    execute.mockResolvedValueOnce(settled).mockResolvedValueOnce(settled);
    await settleTurn(args);
    await settleTurn(args, { countQuestion: true });
    for (const i of [0, 1]) expect(questionParams(i).map((p) => paramsOf(i)[p])).toEqual([1, 1]);
  });
  it('countQuestion: false binds 0 for both, and nothing else in the statement changes (the usage row, the split, the cost)', async () => {
    execute.mockResolvedValueOnce(settled).mockResolvedValueOnce(settled);
    await settleTurn(args);
    await expect(settleTurn(args, { countQuestion: false })).resolves.toEqual({ fromAllowanceMicro: 24_500, fromCreditMicro: 0, absorbedMicro: 0, globalCostMicro: 124_500, globalQuestions: 7 });
    const positions = questionParams(1);
    expect(positions.map((p) => paramsOf(1)[p])).toEqual([0, 0]);
    expect(sqlOf(1)).toBe(sqlOf(0));
    expect(paramsOf(1)).toEqual(paramsOf(0).map((v, p) => (positions.includes(p) ? 0 : v)));
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
