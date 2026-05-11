/**
 * One-shot: clear the four loose columns on the six weeks backfilled
 * with the old (apostrophe-buggy, no-plurals) SQL fragment. These
 * weeks need to be redone with the new logic from migration 0015.
 *
 * Idempotent — re-running is a no-op once the weeks are reset.
 *
 * Usage: pnpm tsx scripts/resetSixBuggyLooseWeeks.ts
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { Pool } from 'pg';

const WEEKS_TO_RESET = [
  '2025-04-19',
  '2025-04-26',
  '2025-05-03',
  '2025-05-10',
  '2025-05-17',
  '2025-05-24',
];

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL!,
    statement_timeout: 600_000, // 10 min per week is plenty
  });
  const client = await pool.connect();
  try {
    for (const w of WEEKS_TO_RESET) {
      const startedAt = Date.now();
      const result = await client.query(
        `
        UPDATE keyword_weekly_metrics
        SET keyword_in_title_1_loose = NULL,
            keyword_in_title_2_loose = NULL,
            keyword_in_title_3_loose = NULL,
            keyword_title_match_count_loose = NULL
        WHERE week_end_date = $1::date
          AND keyword_title_match_count_loose IS NOT NULL
        `,
        [w],
      );
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.log(`  ${w}: ${(result.rowCount ?? 0).toLocaleString().padStart(10)} rows reset in ${elapsed}s`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
