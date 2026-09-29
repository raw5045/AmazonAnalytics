import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('@/lib/env', () => ({ env: { DATABASE_URL: 'postgres://test' } }));
const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('@/db/client', () => ({ db: { execute } }));
import { listAccountsForAdmin, findUserIdByEmail, modelMixForMonth, sumCreditWithAccess } from './adminView';
describe('adminView', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('listAccountsForAdmin', () => {
    it('lists accounts with this month\'s question count, spend and last activity, newest activity first', async () => {
      execute.mockResolvedValueOnce({ rows: [{ user_id: 'u1', email: 'm@example.com', role: 'standard_user', access: true, monthly_allowance_micro: '10000000', allowance_used_micro: '400000', period_start: '2026-09-01', credit_micro: '0', questions_month: '12', spend_month_micro: '480000', last_at: '2026-09-28T10:00:00.000Z' }] });
      const rows = await listAccountsForAdmin(new Date('2026-09-28T12:00:00Z'));
      expect(rows[0]).toEqual({ userId: 'u1', email: 'm@example.com', role: 'standard_user', access: true, monthlyAllowanceMicro: 10_000_000, allowanceUsedMicro: 400_000, periodStart: '2026-09-01', creditMicro: 0, questionsMonth: 12, spendMonthMicro: 480_000, lastAt: new Date('2026-09-28T10:00:00.000Z') });
      const s = JSON.stringify(execute.mock.calls[0][0]);
      expect(s).toContain("kind = 'usage'");
      expect(s).toContain('ORDER BY');
      // Task 10 review, C-m6: created_at is filtered against a UTC timestamptz literal, not a date
      // literal whose interpretation would depend on the session time zone.
      expect(s).toContain('::timestamptz');
      // Task 10 nits, N6: spend is a NEGATED sum of the 'usage' ledger rows (settleTurn writes
      // amount_micro as -cost for that kind), proven here in the query text itself.
      expect(s).toContain('-COALESCE(SUM(amount_micro), 0)');
    });
    it('reads $0 "used this period" and the reset (current-month) period_start for a stale period_start, mirroring the lazy period reset (S3, N6)', async () => {
      // The CASE WHEN / GREATEST live in the SQL itself (a mocked db.execute cannot exercise real
      // SQL), so the mocked row reflects what the query itself would return for a stale period —
      // 0 used and the CURRENT month's start, not the raw stale columns — and this test additionally
      // proves the query text actually contains both guards, consistently.
      execute.mockResolvedValueOnce({ rows: [{ user_id: 'u1', email: 'm@example.com', role: 'standard_user', access: true, monthly_allowance_micro: '10000000', allowance_used_micro: '0', period_start: '2026-09-01', credit_micro: '0', questions_month: '0', spend_month_micro: '0', last_at: null }] });
      const rows = await listAccountsForAdmin(new Date('2026-09-28T12:00:00Z'));
      expect(rows[0].allowanceUsedMicro).toBe(0);
      expect(rows[0].periodStart).toBe('2026-09-01');
      expect(rows[0].lastAt).toBeNull();
      const s = JSON.stringify(execute.mock.calls[0][0]);
      expect(s).toContain('CASE WHEN');
      expect(s).toContain('GREATEST(a.period_start');
    });
  });

  it('finds a user id by email, case-insensitively', async () => {
    execute.mockResolvedValueOnce({ rows: [{ id: 'u2' }] });
    await expect(findUserIdByEmail('  Member@Example.com ')).resolves.toBe('u2');
    expect(JSON.stringify(execute.mock.calls[0][0])).toContain('lower(email)');
    execute.mockResolvedValueOnce({ rows: [] });
    await expect(findUserIdByEmail('nobody@example.com')).resolves.toBeNull();
  });

  it('returns the model mix for the month, most-used first, spend as a positive amount', async () => {
    execute.mockResolvedValueOnce({ rows: [{ model: 'claude-sonnet-5', n: '120', cost_micro: '4800000' }, { model: 'claude-opus-5-5', n: '12', cost_micro: '1900000' }] });
    const mix = await modelMixForMonth(new Date('2026-09-28T12:00:00Z'));
    expect(mix).toEqual([{ model: 'claude-sonnet-5', questions: 120, costMicro: 4_800_000 }, { model: 'claude-opus-5-5', questions: 12, costMicro: 1_900_000 }]);
    const s = JSON.stringify(execute.mock.calls[0][0]);
    expect(s).toContain("kind = 'usage'");
    expect(s).toContain('::timestamptz');
    expect(s).toContain('-COALESCE(SUM(amount_micro), 0)');
    // Task 10 nits, N6: a tie-break on `model` makes the ordering deterministic when two models tie
    // on question count, instead of leaving the tie order up to Postgres.
    expect(s).toContain('ORDER BY n DESC, model');
  });
  it('returns an empty model mix when nothing was asked this month', async () => {
    execute.mockResolvedValueOnce({ rows: [] });
    await expect(modelMixForMonth(new Date('2026-09-28T12:00:00Z'))).resolves.toEqual([]);
  });

  it('sums spendable credit on accounts with access', async () => {
    execute.mockResolvedValueOnce({ rows: [{ total: '15000000' }] });
    await expect(sumCreditWithAccess()).resolves.toBe(15_000_000);
    expect(JSON.stringify(execute.mock.calls[0][0])).toContain('access = true');
  });
});
