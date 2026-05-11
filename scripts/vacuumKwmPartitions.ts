/**
 * One-shot: VACUUM (ANALYZE) on kwm child partitions affected by the
 * 6-week reset. Reclaims dead-tuple space so the upcoming backfill
 * UPDATEs have a chance of being HOT (no index maintenance per update).
 *
 * Also reports pre/post n_dead_tup so we can see the effect.
 *
 * Skips partitions that don't show meaningful dead tuples — VACUUM on
 * a clean partition is wasted work.
 *
 * Usage: pnpm tsx scripts/vacuumKwmPartitions.ts
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { Pool } from 'pg';

const PARTITIONS = ['keyword_weekly_metrics_2025']; // 6 reset weeks all in 2025

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL!,
    statement_timeout: 1_800_000,
  });
  const client = await pool.connect();
  try {
    for (const p of PARTITIONS) {
      const { rows: pre } = await client.query<{
        n_live_tup: string;
        n_dead_tup: string;
        last_vacuum: string | null;
        last_autovacuum: string | null;
      }>(
        `SELECT
           n_live_tup::text, n_dead_tup::text,
           last_vacuum::text, last_autovacuum::text
         FROM pg_stat_user_tables WHERE relname = $1`,
        [p],
      );
      const preStats = pre[0];
      const liveTup = Number(preStats?.n_live_tup ?? 0);
      const deadTup = Number(preStats?.n_dead_tup ?? 0);
      const deadPct = liveTup > 0 ? (deadTup / (liveTup + deadTup) * 100).toFixed(1) : 'n/a';
      console.log(`\n${p}:`);
      console.log(`  pre:  live=${liveTup.toLocaleString()}, dead=${deadTup.toLocaleString()} (${deadPct}%)`);
      console.log(`        last_vacuum=${preStats?.last_vacuum ?? 'never'}`);
      console.log(`        last_autovacuum=${preStats?.last_autovacuum ?? 'never'}`);

      const t0 = Date.now();
      // VACUUM cannot run inside a transaction. node-pg defaults to
      // auto-commit per query for simple text queries.
      await client.query(`VACUUM (ANALYZE) ${p}`);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

      const { rows: post } = await client.query<{
        n_dead_tup: string;
        last_vacuum: string | null;
      }>(
        `SELECT n_dead_tup::text, last_vacuum::text
         FROM pg_stat_user_tables WHERE relname = $1`,
        [p],
      );
      console.log(`  vacuumed in ${elapsed}s. post-dead=${Number(post[0]?.n_dead_tup ?? 0).toLocaleString()}, last_vacuum=${post[0]?.last_vacuum}`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
