/**
 * Read-only integration check that the LIVE keyword_current_summary snapshot
 * has zero volume-monotonicity inversions (see lib/analytics/volumeMonotonicity.ts
 * for what an "inversion" means and why the invariant matters). This does not
 * write anything — it's a sanity check on whatever snapshot is currently live.
 *
 * Gated by RUN_INTEGRATION=1 (tests/integration/** is excluded from the plain
 * `vitest run` glob otherwise — see vitest.config.ts). Requires DATABASE_URL,
 * loaded from .env.local by tests/integration/setup.ts, which may point at
 * the PRODUCTION database — read-only by design; do not add a beforeAll/afterAll
 * that writes here.
 *
 * Run: cross-env RUN_INTEGRATION=1 pnpm vitest run tests/integration/volumeMonotonicity.test.ts
 */
import { describe, it, expect } from 'vitest';
import { Pool } from 'pg';
import { countVolumeInversions } from '@/lib/analytics/volumeMonotonicity';

describe('current snapshot volume monotonicity (read-only)', () => {
  it('has zero inversions', async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, statement_timeout: 120_000 });
    try {
      expect(await countVolumeInversions(pool, 'keyword_current_summary')).toBe(0);
    } finally {
      await pool.end();
    }
  }, 150_000);
});
