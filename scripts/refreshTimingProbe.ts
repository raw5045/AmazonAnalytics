/**
 * Probe what each stage of the refresh actually costs by running each
 * stage in isolation and timing it. Doesn't TRUNCATE/INSERT into kcs —
 * stays fully read-only on the production data. Stages run in a single
 * transaction so the temp tables persist across stages.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { Pool } from 'pg';

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL!,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    statement_timeout: 1_800_000,
  });
  const client = await pool.connect();
  const t = (): number => Date.now();
  const start = t();
  const stage = async (name: string, sql: string) => {
    const s = t();
    await client.query(sql);
    console.log(` ${name.padEnd(32)} ${((t() - s) / 1000).toFixed(1).padStart(7)}s`);
  };

  try {
    await client.query('BEGIN');

    await stage(
      'latest_per_term',
      `CREATE TEMP TABLE latest_per_term ON COMMIT DROP AS
       WITH ref AS (
         SELECT MAX(week_end_date)::date AS current_week
         FROM reporting_weeks WHERE is_complete = true
       )
       SELECT DISTINCT ON (k.search_term_id)
         k.search_term_id, st.search_term_raw, k.week_end_date, k.actual_rank,
         k.top_clicked_product_1_title, k.top_clicked_product_2_title, k.top_clicked_product_3_title
       FROM keyword_weekly_metrics k
       JOIN search_terms st ON st.id = k.search_term_id, ref
       WHERE k.week_end_date >= ref.current_week - INTERVAL '28 days'
       ORDER BY k.search_term_id, k.week_end_date DESC;
       CREATE INDEX ON latest_per_term (search_term_id);`,
    );

    for (const w of [1, 4, 13, 26, 52]) {
      await stage(
        `rank_at_${w}w`,
        `CREATE TEMP TABLE rank_at_${w}w ON COMMIT DROP AS
         SELECT l.search_term_id, k.actual_rank
         FROM latest_per_term l
         JOIN keyword_weekly_metrics k
           ON k.search_term_id = l.search_term_id
           AND k.week_end_date = (l.week_end_date - (${w} * INTERVAL '7 days'))::date;
         CREATE INDEX ON rank_at_${w}w (search_term_id);`,
      );
    }

    await stage(
      'term_normalized',
      `CREATE TEMP TABLE term_normalized ON COMMIT DROP AS
       SELECT
         l.search_term_id,
         ' ' || regexp_replace(LOWER(l.search_term_raw), '[^a-z0-9]+', ' ', 'g') || ' ' AS s,
         CASE WHEN l.top_clicked_product_1_title IS NULL THEN NULL
              ELSE ' ' || regexp_replace(LOWER(l.top_clicked_product_1_title), '[^a-z0-9]+', ' ', 'g') || ' '
         END AS t1,
         CASE WHEN l.top_clicked_product_2_title IS NULL THEN NULL
              ELSE ' ' || regexp_replace(LOWER(l.top_clicked_product_2_title), '[^a-z0-9]+', ' ', 'g') || ' '
         END AS t2,
         CASE WHEN l.top_clicked_product_3_title IS NULL THEN NULL
              ELSE ' ' || regexp_replace(LOWER(l.top_clicked_product_3_title), '[^a-z0-9]+', ' ', 'g') || ' '
         END AS t3
       FROM latest_per_term l;
       CREATE INDEX ON term_normalized (search_term_id);`,
    );

    await stage(
      'loose_flags',
      `CREATE TEMP TABLE loose_flags ON COMMIT DROP AS
       SELECT
         tn.search_term_id,
         CASE WHEN tn.t1 IS NULL THEN NULL ELSE NOT EXISTS (
           SELECT 1 FROM unnest(string_to_array(trim(tn.s), ' ')) AS word
           WHERE word <> '' AND word NOT IN ('a','an','and','are','as','at','be','by','for','from','has','have','in','is','it','its','of','on','or','that','the','this','to','with')
             AND POSITION(' ' || word || ' ' IN tn.t1) = 0
         ) END AS f1,
         CASE WHEN tn.t2 IS NULL THEN NULL ELSE NOT EXISTS (
           SELECT 1 FROM unnest(string_to_array(trim(tn.s), ' ')) AS word
           WHERE word <> '' AND word NOT IN ('a','an','and','are','as','at','be','by','for','from','has','have','in','is','it','its','of','on','or','that','the','this','to','with')
             AND POSITION(' ' || word || ' ' IN tn.t2) = 0
         ) END AS f2,
         CASE WHEN tn.t3 IS NULL THEN NULL ELSE NOT EXISTS (
           SELECT 1 FROM unnest(string_to_array(trim(tn.s), ' ')) AS word
           WHERE word <> '' AND word NOT IN ('a','an','and','are','as','at','be','by','for','from','has','have','in','is','it','its','of','on','or','that','the','this','to','with')
             AND POSITION(' ' || word || ' ' IN tn.t3) = 0
         ) END AS f3
       FROM term_normalized tn;
       CREATE INDEX ON loose_flags (search_term_id);`,
    );

    console.log(` ${''.padEnd(32)} ----`);
    console.log(` ${'TOTAL'.padEnd(32)} ${((t() - start) / 1000).toFixed(1).padStart(7)}s`);

    await client.query('ROLLBACK');
  } finally {
    client.release();
    await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
