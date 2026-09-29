import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { ensureAccount, settleTurn, getAccount, balanceMicro, resetPeriodIfDue, grantAccess, addCredit, globalUsageForMonth } from '@/lib/ask/ledger';
import { createTestUser, deleteTestUser } from './helpers';

// Run (owner-gated, after migration 0048 is applied): RUN_INTEGRATION=1 pnpm vitest run tests/integration/askLedger.test.ts

// Fixed test months this file settles against — cleared before AND after the run so a killed
// process (which skips afterAll) can never leave a prior run's cost/questions counted into a
// later run's "exact totals" assertions.
const TEST_MONTHS = ['2030-03-01', '2031-01-01'];
async function clearTestGlobalUsageMonths() {
  // Not `= ANY(${TEST_MONTHS}::date[])`: drizzle renders an interpolated JS array as a
  // parenthesised list, so that would become `ANY(($1, $2)::date[])` — a row constructor, which
  // Postgres refuses to cast to date[] ("cannot cast type record to date[]"). `IN` renders the
  // same parenthesised list as a plain `IN (...)`, which is exactly what that list means here.
  await db.execute(sql`DELETE FROM ask_global_usage WHERE month IN ${TEST_MONTHS}`);
}

describe('ask ledger (integration, real Postgres)', () => {
  let userId: string | undefined;
  beforeAll(clearTestGlobalUsageMonths);
  afterAll(async () => {
    await deleteTestUser(userId);
    await clearTestGlobalUsageMonths();
  });

  it('settles concurrent turns atomically: allowance first, then credit, overshoot absorbed', async () => {
    userId = (await createTestUser('itest')).id;
    const now = new Date('2030-03-15T00:00:00Z');
    await grantAccess({ userId, allowanceMicro: 100, adminId: userId, now });
    await addCredit({ userId, amountMicro: 50, adminId: userId, note: 'test', now });
    const conv = await db.execute<{ id: string }>(sql`INSERT INTO ask_conversations (user_id, title, model) VALUES (${userId}::uuid, 't', 'claude-sonnet-5') RETURNING id`);
    const conversationId = conv.rows[0].id;
    const usage = { noCacheTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 };
    const results = await Promise.all(
      Array.from({ length: 4 }, () => settleTurn({ userId: userId!, conversationId, messageId: crypto.randomUUID(), model: 'claude-sonnet-5', usage, costMicro: 60, now })),
    );
    const totals = results.reduce((t, r) => ({ a: t.a + r.fromAllowanceMicro, c: t.c + r.fromCreditMicro, x: t.x + r.absorbedMicro }), { a: 0, c: 0, x: 0 });
    expect(totals).toEqual({ a: 100, c: 50, x: 90 }); // 240 charged: 100 allowance + 50 credit + 90 absorbed
    const acct = (await getAccount(userId))!;
    expect(acct.allowanceUsedMicro).toBe(100);
    expect(acct.creditMicro).toBe(0);
    expect(balanceMicro(acct)).toBe(0);
    expect(Math.max(...results.map((r) => r.globalQuestions))).toBeGreaterThanOrEqual(4);
    // The global counter was cleared for this month in beforeAll, so these four settles are the
    // only contributors — exact, not just "at least".
    await expect(globalUsageForMonth('2030-03-01')).resolves.toMatchObject({ costMicro: 240, questions: 4 });
  });

  it('resets the period once when the month moves on', async () => {
    const later = new Date('2030-04-02T00:00:00Z');
    const a = (await resetPeriodIfDue(userId!, later))!;
    expect(a.allowanceUsedMicro).toBe(0);
    expect(a.periodStart).toBe('2030-04-01');
    const again = (await resetPeriodIfDue(userId!, later))!;
    expect(again.periodStart).toBe('2030-04-01');
    const entries = await db.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM ask_ledger WHERE user_id = ${userId}::uuid AND kind = 'allowance_reset'`);
    expect(Number(entries.rows[0].n)).toBe(1);
  });

  it('ensureAccount is idempotent', async () => {
    const other = await createTestUser('itest');
    try {
      const a = await ensureAccount(other.id, new Date('2030-01-01T00:00:00Z'), { access: false, allowanceMicro: 0 });
      const b = await ensureAccount(other.id, new Date('2030-01-01T00:00:00Z'), { access: true, allowanceMicro: 5 });
      expect(a).toEqual(b);
    } finally {
      await deleteTestUser(other.id);
    }
  });

  it('settleTurn rejects a user with no ask_accounts row, and never touches the global counter (Task 5 code review: the all-or-nothing fix)', async () => {
    const ghost = await createTestUser('itest');
    try {
      await expect(
        settleTurn({
          userId: ghost.id,
          conversationId: crypto.randomUUID(),
          messageId: crypto.randomUUID(),
          model: 'claude-sonnet-5',
          usage: { noCacheTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 },
          costMicro: 1,
          now: new Date('2031-01-15T00:00:00Z'),
        }),
      ).rejects.toThrow(/no ask_accounts row/);
      // Before the fix, the bare `INSERT ... VALUES` in settleTurn's `glob` CTE ran unconditionally
      // even though `upd` (and thus `led`) produced no row — this month must still read zero.
      await expect(globalUsageForMonth('2031-01-01')).resolves.toEqual({ month: '2031-01-01', costMicro: 0, questions: 0, alerted80At: null, alerted100At: null });
    } finally {
      await deleteTestUser(ghost.id);
    }
  });
});
