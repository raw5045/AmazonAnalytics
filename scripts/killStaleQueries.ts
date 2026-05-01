/**
 * Kill stale long-running queries from prior killed scripts.
 * pg_terminate_backend on any 'active' COUNT(*) on kwm or staging.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';

async function main() {
  const sql = neon(process.env.DATABASE_URL!);

  const stale = (await sql`
    SELECT pid, NOW() - query_start AS age, LEFT(query, 200) AS q
    FROM pg_stat_activity
    WHERE state = 'active'
      AND query NOT ILIKE '%pg_stat_activity%'
      AND query NOT ILIKE '%pg_terminate_backend%'
      AND (query ILIKE '%COUNT(*)::int c FROM keyword_weekly_metrics%'
        OR query ILIKE '%COUNT(*)::bigint c FROM keyword_weekly_metrics%'
        OR query ILIKE '%COUNT(*)::int c FROM staging_weekly_metrics%')
  `) as Array<{ pid: number; age: unknown; q: string }>;

  console.log(`Found ${stale.length} stale background queries`);
  for (const s of stale) {
    console.log(`  pid=${s.pid} | age=${JSON.stringify(s.age)} | ${s.q.replace(/\s+/g, ' ').slice(0, 100)}`);
  }

  if (stale.length > 0) {
    const ids = stale.map((s) => s.pid);
    const killed = (await sql`
      SELECT pid, pg_terminate_backend(pid) AS terminated
      FROM unnest(${ids}::int[]) AS t(pid)
    `) as Array<{ pid: number; terminated: boolean }>;
    for (const k of killed) console.log(`  ${k.terminated ? '✓ killed' : '✗ failed'} pid=${k.pid}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
