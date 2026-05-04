/**
 * Kill stale long-running COUNT queries that are competing for Neon
 * compute. Targeted at the fake_volume_severity-related leftover from
 * killed scripts.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';

async function main() {
  const sql = neon(process.env.DATABASE_URL!);

  // Find queries that are NOT the active backfill UPDATE
  const stale = (await sql`
    SELECT pid, NOW() - query_start AS age, LEFT(query, 100) AS q
    FROM pg_stat_activity
    WHERE state = 'active'
      AND query NOT ILIKE '%pg_stat_activity%'
      AND query NOT ILIKE '%pg_terminate_backend%'
      AND (
        (query ILIKE '%COUNT(*)%FROM keyword_weekly_metrics%')
        OR (query ILIKE '%COUNT(*) FILTER%fake_volume%')
        OR (query ILIKE '%pgbouncer%')
      )
  `) as Array<{ pid: number; age: unknown; q: string }>;

  console.log(`Found ${stale.length} stale queries:`);
  for (const s of stale) {
    console.log(`  pid=${s.pid} age=${JSON.stringify(s.age)} | ${s.q.replace(/\s+/g, ' ').slice(0, 90)}`);
  }
  if (stale.length === 0) return;

  const ids = stale.map((s) => s.pid);
  const killed = (await sql`
    SELECT pid, pg_terminate_backend(pid) AS terminated
    FROM unnest(${ids}::int[]) AS t(pid)
  `) as Array<{ pid: number; terminated: boolean }>;
  for (const k of killed) console.log(`  ${k.terminated ? '✓ killed' : '✗ failed'} pid=${k.pid}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
