import { describe, it, expect, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { researchUsageBuckets } from '@/db/schema';
import { reserveResearchRequest } from '@/lib/research/usage';
import { DEFAULT_LIMITS } from '@/lib/research/limits';
import { createTestUser, deleteTestUser } from './helpers';

// Run: cross-env RUN_INTEGRATION=1 pnpm vitest run tests/integration/researchUsage.test.ts
describe('research usage buckets (integration, real Postgres)', () => {
  let userId: string | undefined;
  afterAll(async () => { await deleteTestUser(userId); });

  it('counts concurrent reservations atomically and refuses beyond the limit', async () => {
    userId = (await createTestUser('itest')).id;
    const now = new Date('2030-01-01T00:00:30Z');
    const limits = { ...DEFAULT_LIMITS, requestsPerMinute: 3 };
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => reserveResearchRequest({ userId: userId!, channel: 'mcp', rows: 50, now, limits })),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected).toHaveLength(2);
    for (const r of rejected) expect(r.reason).toMatchObject({ code: 'RATE_LIMITED', retryAfterSeconds: 30 });
    const [bucket] = await db.select().from(researchUsageBuckets).where(eq(researchUsageBuckets.userId, userId!));
    expect(bucket).toMatchObject({ requests: 5, rows: 250, channel: 'mcp' });
  });
});
