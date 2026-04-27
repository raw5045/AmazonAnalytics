/**
 * Fast check: how many rows in kwm and which weeks are present.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';

async function main() {
  const sql = neon(process.env.DATABASE_URL!);

  console.log('\n=== TOTAL kwm row count ===');
  const [total] = (await sql`SELECT COUNT(*)::bigint c FROM keyword_weekly_metrics`) as Array<{ c: string }>;
  console.log(' total:', Number(total.c).toLocaleString());

  console.log('\n=== kwm BY WEEK (per week_end_date) ===');
  const byWeek = (await sql`
    SELECT week_end_date, COUNT(*)::int c, COUNT(DISTINCT source_file_id)::int distinct_sources
    FROM keyword_weekly_metrics
    GROUP BY week_end_date ORDER BY week_end_date
  `) as Array<{ week_end_date: string; c: number; distinct_sources: number }>;
  for (const w of byWeek) {
    console.log(` - ${w.week_end_date?.toString().slice(0, 10)}: ${w.c.toLocaleString()} rows | ${w.distinct_sources} src`);
  }
  console.log(`\n total weeks: ${byWeek.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
