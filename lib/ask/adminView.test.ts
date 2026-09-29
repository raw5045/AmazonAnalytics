import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('@/lib/env', () => ({ env: { DATABASE_URL: 'postgres://test' } }));
const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('@/db/client', () => ({ db: { execute } }));
import { listAccountsForAdmin, findUserIdByEmail } from './adminView';
describe('adminView', () => {
  beforeEach(() => vi.clearAllMocks());
  it('lists accounts with this month\'s question count and last activity, newest activity first', async () => {
    execute.mockResolvedValueOnce({ rows: [{ user_id: 'u1', email: 'm@example.com', role: 'standard_user', access: true, monthly_allowance_micro: '10000000', allowance_used_micro: '400000', period_start: '2026-09-01', credit_micro: '0', questions_month: '12', last_at: '2026-09-28T10:00:00.000Z' }] });
    const rows = await listAccountsForAdmin(new Date('2026-09-28T12:00:00Z'));
    expect(rows[0]).toEqual({ userId: 'u1', email: 'm@example.com', role: 'standard_user', access: true, monthlyAllowanceMicro: 10_000_000, allowanceUsedMicro: 400_000, periodStart: '2026-09-01', creditMicro: 0, questionsMonth: 12, lastAt: new Date('2026-09-28T10:00:00.000Z') });
    const s = JSON.stringify(execute.mock.calls[0][0]);
    expect(s).toContain("kind = 'usage'");
    expect(s).toContain('ORDER BY');
  });
  it('finds a user id by email, case-insensitively', async () => {
    execute.mockResolvedValueOnce({ rows: [{ id: 'u2' }] });
    await expect(findUserIdByEmail('  Member@Example.com ')).resolves.toBe('u2');
    expect(JSON.stringify(execute.mock.calls[0][0])).toContain('lower(email)');
    execute.mockResolvedValueOnce({ rows: [] });
    await expect(findUserIdByEmail('nobody@example.com')).resolves.toBeNull();
  });
});
