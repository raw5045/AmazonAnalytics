import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('@/lib/env', () => ({ env: { DATABASE_URL: 'postgres://test' } }));
const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('@/db/client', () => ({ db: { execute } }));
const ledger = vi.hoisted(() => ({
  getAccount: vi.fn(), ensureAccount: vi.fn(), resetPeriodIfDue: vi.fn(), globalUsageForMonth: vi.fn(),
}));
vi.mock('./ledger', async (importOriginal) => ({ ...(await importOriginal<typeof import('./ledger')>()), ...ledger }));
vi.mock('./config', async (importOriginal) => ({ ...(await importOriginal<typeof import('./config')>()), dailyMessageLimit: () => 3, globalMonthlyCeilingMicro: () => 1_000_000 }));
import { PgDialect } from 'drizzle-orm/pg-core';
import { runGates, reserveDailyQuestion, secondsToNextUtcDay } from './gates';
import { dailyLimitMessage } from './messages';

const dialect = new PgDialect();
const sqlOf = (i = 0) => dialect.sqlToQuery(execute.mock.calls[i][0]).sql;
const paramsOf = (i = 0) => dialect.sqlToQuery(execute.mock.calls[i][0]).params;
const member = { id: 'u1', role: 'standard_user' as const };
const admin = { id: 'a1', role: 'admin' as const };
const now = new Date('2026-09-28T18:00:00Z');
const account = { userId: 'u1', access: true, monthlyAllowanceMicro: 10_000_000, allowanceUsedMicro: 0, periodStart: '2026-09-01', creditMicro: 0, conversationCount: 0 };

describe('gates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ledger.resetPeriodIfDue.mockImplementation(async () => account);
    ledger.globalUsageForMonth.mockResolvedValue({ month: '2026-09-01', costMicro: 0, questions: 0, alerted80At: null, alerted100At: null });
    execute.mockResolvedValue({ rows: [{ requests: 1 }] });
  });

  it('refuses a member without an accessible account with a 404-shaped refusal, before touching the daily bucket', async () => {
    ledger.getAccount.mockResolvedValueOnce(null);
    const r = await runGates({ user: member, now });
    expect(r).toEqual({ ok: false, refusal: { status: 404, code: 'not_eligible', message: 'Not found' } });
    expect(execute).not.toHaveBeenCalled();
    ledger.getAccount.mockResolvedValueOnce({ ...account, access: false });
    expect((await runGates({ user: member, now })).ok).toBe(false);
  });
  it('creates a metering row for an admin with no account and lets them through without a balance', async () => {
    ledger.getAccount.mockResolvedValueOnce(null);
    ledger.ensureAccount.mockResolvedValueOnce({ ...account, userId: 'a1', access: false, monthlyAllowanceMicro: 0 });
    ledger.resetPeriodIfDue.mockResolvedValueOnce({ ...account, userId: 'a1', access: false, monthlyAllowanceMicro: 0 });
    const r = await runGates({ user: admin, now });
    expect(r.ok).toBe(true);
    expect(ledger.ensureAccount).toHaveBeenCalledWith('a1', now, { access: false, allowanceMicro: 0 });
  });
  it('runs the daily guard after eligibility and refuses past the limit with the seconds to the next UTC day', async () => {
    ledger.getAccount.mockResolvedValueOnce(account);
    execute.mockResolvedValueOnce({ rows: [{ requests: 4 }] });
    const r = await runGates({ user: member, now });
    expect(r).toEqual({ ok: false, refusal: { status: 429, code: 'daily_limit', message: "You've reached today's limit of 3 questions. It resets in 6 hours.", retryAfterSeconds: 21_600 } });
    expect(sqlOf()).toContain("'chat_day'");
    expect(paramsOf()).toContain('2026-09-28T00:00:00.000Z');
  });
  it('refuses a member with no balance (402) but not an admin', async () => {
    const empty = { ...account, allowanceUsedMicro: 10_000_000 };
    ledger.getAccount.mockResolvedValueOnce(empty);
    ledger.resetPeriodIfDue.mockResolvedValueOnce(empty);
    expect(await runGates({ user: member, now })).toEqual({ ok: false, refusal: { status: 402, code: 'no_balance', message: "You've used this month's usage. Ask through the Feedback button to add more." } });
    ledger.getAccount.mockResolvedValueOnce({ ...empty, userId: 'a1' });
    ledger.resetPeriodIfDue.mockResolvedValueOnce({ ...empty, userId: 'a1' });
    expect((await runGates({ user: admin, now })).ok).toBe(true);
  });
  it('refuses everyone, admins included, at the global ceiling', async () => {
    ledger.getAccount.mockResolvedValueOnce(account);
    ledger.globalUsageForMonth.mockResolvedValueOnce({ month: '2026-09-01', costMicro: 1_000_000, questions: 9, alerted80At: null, alerted100At: null });
    expect(await runGates({ user: admin, now })).toEqual({ ok: false, refusal: { status: 503, code: 'global_ceiling', message: 'Ask AI is paused for the rest of the month.' } });
  });
  it('passes and returns the (period-reset) account', async () => {
    ledger.getAccount.mockResolvedValueOnce(account);
    const r = await runGates({ user: member, now });
    expect(r).toEqual({ ok: true, account });
    expect(ledger.resetPeriodIfDue).toHaveBeenCalledWith('u1', now);
  });
  it('passes on the reset account even when getAccount alone would have refused it (a stale pre-reset object must never be used for the balance check)', async () => {
    const usedUp = { ...account, allowanceUsedMicro: 10_000_000 };
    const fresh = { ...account, allowanceUsedMicro: 0, periodStart: '2026-10-01' };
    ledger.getAccount.mockResolvedValueOnce(usedUp);
    ledger.resetPeriodIfDue.mockResolvedValueOnce(fresh);
    await expect(runGates({ user: member, now })).resolves.toEqual({ ok: true, account: fresh });
  });
  it('the daily guard is checked before the balance: over the limit AND at zero balance still refuses with daily_limit (429) and never reaches globalUsageForMonth', async () => {
    const empty = { ...account, allowanceUsedMicro: 10_000_000 };
    ledger.getAccount.mockResolvedValueOnce(empty);
    ledger.resetPeriodIfDue.mockResolvedValueOnce(empty);
    execute.mockResolvedValueOnce({ rows: [{ requests: 4 }] });
    const r = await runGates({ user: member, now });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.refusal.code).toBe('daily_limit');
    expect(!r.ok && r.refusal.status).toBe(429);
    expect(ledger.globalUsageForMonth).not.toHaveBeenCalled();
  });
  it('reserveDailyQuestion upserts the chat_day bucket keyed by UTC day and reports the count', async () => {
    execute.mockResolvedValueOnce({ rows: [{ requests: 2 }] });
    await expect(reserveDailyQuestion('u1', now)).resolves.toEqual({ requests: 2 });
    expect(sqlOf()).toContain('ON CONFLICT (user_id, channel, bucket_start) DO UPDATE');
  });
  it('secondsToNextUtcDay and the message wording', () => {
    expect(secondsToNextUtcDay(now)).toBe(21_600);
    expect(secondsToNextUtcDay(new Date('2026-09-28T23:59:30Z'))).toBe(30);
    expect(dailyLimitMessage(3, 21_600)).toBe("You've reached today's limit of 3 questions. It resets in 6 hours.");
    expect(dailyLimitMessage(3, 3_599)).toBe("You've reached today's limit of 3 questions. It resets in less than an hour.");
    expect(dailyLimitMessage(3, 3_600)).toBe("You've reached today's limit of 3 questions. It resets in 1 hour.");
  });
  it('countQuestion: false (an approval resume) skips the daily reservation but keeps every other gate', async () => {
    ledger.getAccount.mockResolvedValueOnce(account);
    // Today's bucket is already past the limit: a resume must still pass, because it never reserves.
    execute.mockResolvedValue({ rows: [{ requests: 99 }] });
    const out = await runGates({ user: member, now }, { countQuestion: false });
    expect(out.ok).toBe(true);
    expect(execute.mock.calls.map((c) => dialect.sqlToQuery(c[0]).sql).some((s) => s.includes('research_usage_buckets'))).toBe(false);
  });
  it('countQuestion: false still refuses on eligibility, balance and the global ceiling', async () => {
    ledger.getAccount.mockResolvedValueOnce(null);
    expect(await runGates({ user: member, now }, { countQuestion: false })).toMatchObject({ ok: false, refusal: { code: 'not_eligible' } });
    const empty = { ...account, allowanceUsedMicro: 10_000_000 };
    ledger.getAccount.mockResolvedValueOnce(empty);
    ledger.resetPeriodIfDue.mockResolvedValueOnce(empty);
    expect(await runGates({ user: member, now }, { countQuestion: false })).toMatchObject({ ok: false, refusal: { code: 'no_balance' } });
    ledger.getAccount.mockResolvedValueOnce(account);
    ledger.globalUsageForMonth.mockResolvedValueOnce({ month: '2026-09-01', costMicro: 1_000_000, questions: 9, alerted80At: null, alerted100At: null });
    expect(await runGates({ user: member, now }, { countQuestion: false })).toMatchObject({ ok: false, refusal: { code: 'global_ceiling' } });
    expect(execute).not.toHaveBeenCalled();
  });
  it('by default (and with countQuestion: true) every call reserves the daily question: one research_usage_buckets statement each', async () => {
    ledger.getAccount.mockResolvedValueOnce(account);
    expect((await runGates({ user: member, now })).ok).toBe(true);
    ledger.getAccount.mockResolvedValueOnce(account);
    expect((await runGates({ user: member, now }, { countQuestion: true })).ok).toBe(true);
    expect(execute.mock.calls.map((c) => dialect.sqlToQuery(c[0]).sql).filter((s) => s.includes('research_usage_buckets'))).toHaveLength(2);
  });
});
