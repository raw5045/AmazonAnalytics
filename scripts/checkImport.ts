import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';

async function main() {
  const sql = neon(process.env.DATABASE_URL!);

  console.log('\n=== kwm rows for Feb 07 (any source) ===');
  const [byWeek] = (await sql`
    SELECT COUNT(*)::int c FROM keyword_weekly_metrics WHERE week_end_date = '2026-02-07'::date
  `) as Array<{ c: number }>;
  console.log(' rows for week 2026-02-07:', byWeek.c);

  console.log('\n=== kwm rows for the failed file ===');
  const [bySource] = (await sql`
    SELECT COUNT(*)::int c FROM keyword_weekly_metrics
    WHERE source_file_id = '03475965-fcfa-4b40-8e9c-3da6f25fcfaf'::uuid
  `) as Array<{ c: number }>;
  console.log(' rows for source_file_id 03475965:', bySource.c);

  console.log('\n=== Active import-related backends in pg_stat_activity ===');
  const activity = (await sql`
    SELECT pid, application_name, state, wait_event_type, wait_event,
           NOW() - query_start AS query_age,
           LEFT(query, 250) AS query
    FROM pg_stat_activity
    WHERE state = 'active'
      AND (query ILIKE '%keyword_weekly_metrics%'
        OR query ILIKE '%staging_weekly_metrics%'
        OR query ILIKE '%search_terms%')
      AND query NOT ILIKE '%pg_stat_activity%'
    ORDER BY query_start
  `) as Array<{
    pid: number;
    application_name: string;
    state: string;
    wait_event_type: string | null;
    wait_event: string | null;
    query_age: unknown;
    query: string;
  }>;
  if (activity.length === 0) console.log(' (none active)');
  for (const a of activity) {
    console.log(`\n  pid=${a.pid} | app=${a.application_name} | state=${a.state}`);
    console.log(`  wait=${a.wait_event_type}/${a.wait_event} | query_age=${JSON.stringify(a.query_age)}`);
    console.log(`  query: ${a.query}`);
  }

  console.log('\n=== Staging total ===');
  const [stg] = (await sql`SELECT COUNT(*)::bigint c FROM staging_weekly_metrics`) as Array<{ c: string }>;
  console.log(' staging rows:', Number(stg.c).toLocaleString());
}

main().catch((e) => { console.error(e); process.exit(1); });
