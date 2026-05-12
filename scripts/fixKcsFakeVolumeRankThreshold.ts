/**
 * One-shot UPDATE on keyword_current_summary to apply the rank > 100,000
 * threshold rule for fake_volume_severity_current. Runs once after
 * migration 0019 + the importFile + refreshSummary changes ship.
 *
 * After this script:
 *   - kcs.fake_volume_severity_current = 'none' for any row with
 *     current_rank > 100,000 that previously had a non-'none' severity.
 *   - Future kcs refreshes apply the same rule via the CASE in
 *     refreshSummary.ts.
 *   - Future imports apply the same rule via importFile.ts.
 *
 * Does NOT touch kwm — the raw data stays as Amazon shipped it. The
 * detail page fetcher applies the same threshold mask at read time.
 *
 * Usage: pnpm tsx scripts/fixKcsFakeVolumeRankThreshold.ts
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { Pool } from 'pg';

const THRESHOLD = 100_000;

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL!,
    statement_timeout: 1_800_000,
  });
  const c = await pool.connect();
  try {
    // Count rows to fix first so we can report scope.
    const { rows: pre } = await c.query<{ n: number }>(`
      SELECT COUNT(*)::int AS n
      FROM keyword_current_summary
      WHERE current_rank > ${THRESHOLD}
        AND fake_volume_severity_current IS NOT NULL
        AND fake_volume_severity_current::text != 'none'
    `);
    console.log(`Rows in kcs needing severity reset: ${pre[0].n.toLocaleString()}`);

    if (pre[0].n === 0) {
      console.log('Nothing to do.');
      return;
    }

    const t0 = Date.now();
    const result = await c.query(`
      UPDATE keyword_current_summary
      SET fake_volume_severity_current = 'none'::fake_volume_severity
      WHERE current_rank > ${THRESHOLD}
        AND fake_volume_severity_current IS NOT NULL
        AND fake_volume_severity_current::text != 'none'
    `);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\n✅ Updated ${(result.rowCount ?? 0).toLocaleString()} rows in ${elapsed}s.`);
  } finally {
    c.release();
    await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
