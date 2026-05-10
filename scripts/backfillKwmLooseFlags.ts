/**
 * Backfill keyword_in_title_*_loose + keyword_title_match_count_loose
 * columns on existing kwm rows. Computes loose flags from each row's
 * search_term_raw + product titles using the same POSITION-based SQL
 * as the import path.
 *
 * Strategy: process one week at a time.
 *   - Per-week filter hits the partitioned kwm table efficiently
 *   - Each week is ~3M rows, runs in ~30-60 sec
 *   - 53 weeks × ~45 sec = ~30-40 min total
 *   - Per-statement timeout 30 min as a safety net
 *
 * Idempotent: re-running picks up where a prior run left off using a
 * `WHERE keyword_in_title_1_loose IS NULL` filter.
 *
 * Connection: pg.Pool (TCP) — neon-http would time out on multi-min
 * UPDATE.
 *
 * Usage: pnpm tsx scripts/backfillKwmLooseFlags.ts
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { Pool } from 'pg';

const STOPWORDS = `'a','an','and','are','as','at','be','by','for','from','has','have',
  'in','is','it','its','of','on','or','that','the','this','to','with'`;

// Inline the loose-flag SQL fragment (mirror of looseFlagSqlFragment in
// inngest/functions/importFile.ts). Kept here for the backfill so we
// don't need to import worker code into a pure-SQL script.
function looseFlagSql(searchTermSql: string, titleSql: string): string {
  return `
    CASE WHEN ${titleSql} IS NULL THEN NULL
      ELSE NOT EXISTS (
        SELECT 1 FROM unnest(
          string_to_array(
            regexp_replace(LOWER(${searchTermSql}), '[^a-z0-9]+', ' ', 'g'),
            ' '
          )
        ) AS w
        WHERE w <> ''
          AND w NOT IN (${STOPWORDS})
          AND POSITION(' ' || w || ' ' IN ' ' || regexp_replace(LOWER(${titleSql}), '[^a-z0-9]+', ' ', 'g') || ' ') = 0
      )
    END
  `;
}

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL!,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    statement_timeout: 1_800_000, // 30 min ceiling
  });
  const client = await pool.connect();

  try {
    console.log('\n=== Weeks to backfill ===');
    const { rows: weeks } = await client.query<{ week_end_date: string; total: number; need_backfill: number }>(
      `SELECT
        week_end_date::text,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE keyword_in_title_1_loose IS NULL)::int AS need_backfill
      FROM keyword_weekly_metrics
      GROUP BY week_end_date
      ORDER BY week_end_date`,
    );
    const todo = weeks.filter((w) => w.need_backfill > 0);
    const totalNeed = todo.reduce((s, w) => s + w.need_backfill, 0);
    console.log(
      `  ${weeks.length} weeks total; ${todo.length} need backfill; ${totalNeed.toLocaleString()} rows`,
    );

    if (todo.length === 0) {
      console.log('Nothing to do.');
      return;
    }

    const startedAt = Date.now();
    const slot1 = looseFlagSql('st.search_term_raw', 'kwm.top_clicked_product_1_title');
    const slot2 = looseFlagSql('st.search_term_raw', 'kwm.top_clicked_product_2_title');
    const slot3 = looseFlagSql('st.search_term_raw', 'kwm.top_clicked_product_3_title');

    for (let i = 0; i < todo.length; i++) {
      const w = todo[i];
      const ws = w.week_end_date.slice(0, 10);
      const sliceStart = Date.now();
      const result = await client.query(
        `
        UPDATE keyword_weekly_metrics kwm
        SET
          keyword_in_title_1_loose = (${slot1}),
          keyword_in_title_2_loose = (${slot2}),
          keyword_in_title_3_loose = (${slot3}),
          keyword_title_match_count_loose = (
            (CASE WHEN (${slot1}) IS TRUE THEN 1 ELSE 0 END)
            + (CASE WHEN (${slot2}) IS TRUE THEN 1 ELSE 0 END)
            + (CASE WHEN (${slot3}) IS TRUE THEN 1 ELSE 0 END)
          )::smallint
        FROM search_terms st
        WHERE kwm.search_term_id = st.id
          AND kwm.week_end_date = $1::date
          AND kwm.keyword_in_title_1_loose IS NULL
        `,
        [ws],
      );
      const sliceMs = Date.now() - sliceStart;
      const remaining = todo.length - i - 1;
      const avgMs = (Date.now() - startedAt) / (i + 1);
      const etaMin = Math.round((remaining * avgMs) / 60_000);
      const updated = result.rowCount ?? 0;
      console.log(
        ` [${(i + 1).toString().padStart(2)}/${todo.length}] ${ws} | ${updated.toLocaleString().padStart(10)} rows | ${(sliceMs / 1000).toFixed(1).padStart(6)}s | ETA ~${etaMin}m`,
      );
    }

    console.log(`\nTotal elapsed: ${Math.round((Date.now() - startedAt) / 60_000)} min`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
