/**
 * Quick read-only: show kwm partitions + their indexes, so we know
 * what the planner has to work with.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { Pool } from 'pg';

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL! });
  const c = await pool.connect();
  try {
    const { rows: parts } = await c.query<{ tbl: string; rows: string; size: string }>(`
      SELECT c.relname AS tbl,
             c.reltuples::bigint::text AS rows,
             pg_size_pretty(pg_total_relation_size(c.oid)) AS size
      FROM pg_class c JOIN pg_inherits i ON c.oid = i.inhrelid
      JOIN pg_class p ON i.inhparent = p.oid
      WHERE p.relname = 'keyword_weekly_metrics'
      ORDER BY c.relname
    `);
    console.log('Partitions:');
    for (const p of parts) console.log(`  ${p.tbl.padEnd(40)} rows=${p.rows.padStart(12)} size=${p.size}`);

    const { rows: idx } = await c.query<{ tbl: string; idx: string; def: string }>(`
      SELECT tablename AS tbl, indexname AS idx, indexdef AS def
      FROM pg_indexes
      WHERE tablename LIKE 'keyword_weekly_metrics%'
      ORDER BY tablename, indexname
    `);
    console.log('\nIndexes:');
    for (const i of idx) console.log(`  ${i.tbl.padEnd(40)} ${i.idx}\n    ${i.def}`);
  } finally {
    c.release();
    await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
