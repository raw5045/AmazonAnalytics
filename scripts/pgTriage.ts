/**
 * Postgres triage: check for active COPY operations or stale connections
 * from the import path. Run before retry to make sure we're not racing
 * against a zombie backend that thinks it's still mid-COPY.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';

async function main() {
  const sql = neon(process.env.DATABASE_URL!);

  console.log('\n=== pg_stat_progress_copy (active COPYs) ===');
  const copies = (await sql`SELECT * FROM pg_stat_progress_copy`) as Array<Record<string, unknown>>;
  if (copies.length === 0) {
    console.log(' (no active COPY operations)');
  } else {
    for (const c of copies) {
      console.log(JSON.stringify(c, null, 2));
    }
  }

  console.log('\n=== pg_stat_activity for import-related queries ===');
  const activity = (await sql`
    SELECT pid, application_name, state,
           wait_event_type, wait_event,
           NOW() - query_start AS query_age,
           NOW() - state_change AS state_age,
           LEFT(query, 200) AS query
    FROM pg_stat_activity
    WHERE application_name ILIKE 'csv-import:%'
       OR query ILIKE '%COPY staging_weekly_metrics%'
       OR query ILIKE '%FROM staging_weekly_metrics%'
       OR query ILIKE '%INTO keyword_weekly_metrics%'
    ORDER BY query_start DESC NULLS LAST
  `) as Array<Record<string, unknown>>;
  if (activity.length === 0) {
    console.log(' (no import-related backends active)');
  } else {
    for (const a of activity) {
      console.log(`\n  pid=${a.pid} | app=${a.application_name} | state=${a.state}`);
      console.log(`  wait=${a.wait_event_type}/${a.wait_event}`);
      console.log(`  query_age=${a.query_age} | state_age=${a.state_age}`);
      console.log(`  query: ${a.query}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
