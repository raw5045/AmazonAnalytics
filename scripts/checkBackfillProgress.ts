import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';

async function main() {
  const sql = neon(process.env.DATABASE_URL!);

  console.log('\n=== Active backends with fake_volume context ===');
  const acts = (await sql`
    SELECT pid, NOW() - query_start AS age, state, wait_event_type, wait_event, LEFT(query, 200) AS q
    FROM pg_stat_activity
    WHERE state = 'active'
      AND query ILIKE '%fake_volume%'
      AND query NOT ILIKE '%pg_stat_activity%'
  `) as Array<Record<string, unknown>>;
  if (acts.length === 0) console.log(' (none active)');
  for (const a of acts) console.log(' ', JSON.stringify(a, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
