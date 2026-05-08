/**
 * Debug why the search_terms upsert failed during the 5/02 smoke test.
 * Runs the query against current staging data to surface the real
 * Postgres error (Drizzle wraps it and hides the message).
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { Pool } from 'pg';

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL!,
    keepAlive: true,
    statement_timeout: 600_000,
  });
  const client = await pool.connect();
  try {
    const fileId = '9a9b8cdb-7235-4895-8e80-d0cd3a78ef71';

    console.log('\n=== Staging row count for this file ===');
    const c = await client.query<{ c: string }>(
      `SELECT COUNT(*)::text c FROM staging_weekly_metrics WHERE uploaded_file_id = $1`,
      [fileId],
    );
    console.log(`  ${c.rows[0]?.c} rows`);

    console.log('\n=== Sample staging row (showing new columns) ===');
    const s = await client.query(
      `SELECT search_term_raw_original, search_term_raw, search_term_normalized,
              had_unicode_noise, source_row_number, actual_rank
       FROM staging_weekly_metrics
       WHERE uploaded_file_id = $1
       LIMIT 3`,
      [fileId],
    );
    for (const r of s.rows) console.log(' ', JSON.stringify(r));

    console.log('\n=== Distinct normalized values count ===');
    const dn = await client.query<{ c: string }>(
      `SELECT COUNT(DISTINCT search_term_normalized)::text c FROM staging_weekly_metrics WHERE uploaded_file_id = $1`,
      [fileId],
    );
    console.log(`  ${dn.rows[0]?.c} distinct normalized values`);

    console.log('\n=== Try the search_terms upsert manually (will surface real PG error) ===');
    try {
      await client.query('BEGIN');
      await client.query(
        `
        INSERT INTO search_terms (search_term_raw, search_term_normalized, first_seen_week, last_seen_week)
        SELECT DISTINCT ON (search_term_normalized)
          search_term_raw, search_term_normalized, $1::date, $2::date
        FROM staging_weekly_metrics
        WHERE uploaded_file_id = $3
        ON CONFLICT (search_term_normalized) DO UPDATE
          SET last_seen_week = GREATEST(search_terms.last_seen_week, EXCLUDED.last_seen_week),
              first_seen_week = LEAST(search_terms.first_seen_week, EXCLUDED.first_seen_week),
              search_term_raw = EXCLUDED.search_term_raw
          WHERE
            search_terms.last_seen_week < EXCLUDED.last_seen_week
            OR search_terms.first_seen_week > EXCLUDED.first_seen_week
            OR search_terms.search_term_raw <> EXCLUDED.search_term_raw
        `,
        ['2026-05-02', '2026-05-02', fileId],
      );
      await client.query('ROLLBACK'); // dry-run only
      console.log('  ✓ query succeeded (rolled back to leave state untouched)');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      console.log('  ✗ query failed with:');
      console.log(e);
    }
  } finally {
    client.release();
    await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
