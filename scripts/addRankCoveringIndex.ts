/**
 * Add covering index `(week_end_date, search_term_id) INCLUDE (actual_rank)`
 * to each yearly partition of keyword_weekly_metrics.
 *
 * Why a covering index: today the rank_at_*w stages of the kcs refresh
 * spend ~28 min each doing Index Scan + heap fetches just to read one
 * int4 (`actual_rank`). The index needed includes that column so the
 * planner can do an Index Only Scan and skip the heap entirely.
 *
 * Why date-leading: the workload is heavily date-shaped (a small set of
 * exact target weeks against many terms). A date-leading index gives
 * better locality for both the current term-driven shape and any future
 * date-driven reshape we want to try.
 *
 * CONCURRENTLY:
 *   - PostgreSQL doesn't allow CREATE INDEX CONCURRENTLY on partitioned
 *     parents. Build on each child partition individually.
 *   - Concurrent builds don't take a write lock, so ongoing imports
 *     are NOT blocked. They're slower (~2-3x) but safe.
 *
 * After build: VACUUM (ANALYZE) each partition so the visibility map
 * is up-to-date — required for Index Only Scans to actually skip heap
 * access. Without this, even with the index, PG still has to fetch
 * heap pages to check tuple visibility.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { Pool } from 'pg';

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL!,
    keepAlive: true,
    statement_timeout: 0, // disable: index build can be slow, don't time out
  });
  const client = await pool.connect();

  try {
    // 1. Discover the partitions.
    const { rows: partitions } = await client.query<{ partition: string }>(`
      SELECT inhrelid::regclass::text AS partition
      FROM pg_inherits
      WHERE inhparent = 'keyword_weekly_metrics'::regclass
      ORDER BY partition
    `);
    console.log(`Found ${partitions.length} partitions:`);
    for (const p of partitions) console.log(`  ${p.partition}`);

    // 2. Build the covering index on each, concurrently.
    for (const { partition } of partitions) {
      const yearMatch = /(\d{4})$/.exec(partition);
      const year = yearMatch ? yearMatch[1] : 'unknown';
      const indexName = `kwm_${year}_week_term_rank_cover_idx`;

      console.log(`\n--- ${partition} ---`);

      // Skip if already exists (re-runnable)
      const existing = await client.query(
        `SELECT 1 FROM pg_indexes WHERE indexname = $1`,
        [indexName],
      );
      if (existing.rowCount && existing.rowCount > 0) {
        console.log(`  ${indexName} already exists — skipping build`);
      } else {
        const buildStart = Date.now();
        console.log(`  CREATE INDEX CONCURRENTLY ${indexName} ...`);
        await client.query(`
          CREATE INDEX CONCURRENTLY ${indexName}
          ON ${partition} (week_end_date, search_term_id)
          INCLUDE (actual_rank)
        `);
        console.log(`  built in ${((Date.now() - buildStart) / 1000).toFixed(1)}s`);
      }

      // 3. VACUUM ANALYZE so visibility map gets refreshed.
      const vacStart = Date.now();
      console.log(`  VACUUM (ANALYZE) ${partition} ...`);
      await client.query(`VACUUM (ANALYZE) ${partition}`);
      console.log(`  done in ${((Date.now() - vacStart) / 1000).toFixed(1)}s`);
    }

    console.log('\n✅ All partitions indexed + analyzed.');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
