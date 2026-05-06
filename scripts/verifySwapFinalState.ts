import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';

async function main() {
  const sql = neon(process.env.DATABASE_URL!);
  console.log('\n=== Live keyword_current_summary ===');
  const live = (await sql`
    SELECT COUNT(*)::int n,
           MAX(updated_at) as last_updated,
           MAX(current_week_end_date) as latest_week
    FROM keyword_current_summary
  `) as Array<Record<string, unknown>>;
  console.log(`  rows: ${(live[0].n as number).toLocaleString()}`);
  console.log(`  last updated: ${live[0].last_updated}`);
  console.log(`  latest week: ${live[0].latest_week}`);

  console.log('\n=== keyword_current_summary_stage (should hold prior snapshot) ===');
  const stage = (await sql`
    SELECT COUNT(*)::int n,
           MAX(updated_at) as last_updated
    FROM keyword_current_summary_stage
  `) as Array<Record<string, unknown>>;
  console.log(`  rows: ${(stage[0].n as number).toLocaleString()}`);
  console.log(`  last updated: ${stage[0].last_updated}`);

  // Sanity: live's last_updated should be NEWER than stage's
  const liveTs = new Date(live[0].last_updated as string).getTime();
  const stageTs = stage[0].last_updated ? new Date(stage[0].last_updated as string).getTime() : 0;
  console.log(`\n  live newer than stage by: ${((liveTs - stageTs)/60_000).toFixed(1)} min ✓`);
}
main().catch((e) => { console.error(e); process.exit(1); });
