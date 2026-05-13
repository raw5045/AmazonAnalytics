/**
 * Verify migration 0020 — confirm keyword_current_summary_meta has a
 * single row whose current_week_end_date matches MAX from kcs.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';

async function main() {
  const sql = neon(process.env.DATABASE_URL!);
  const rows = (await sql`
    SELECT
      m.current_week_end_date::text AS meta_week,
      m.refreshed_at::text          AS meta_refreshed_at,
      (SELECT MAX(current_week_end_date)::text FROM keyword_current_summary) AS kcs_max_week,
      (SELECT COUNT(*) FROM keyword_current_summary_meta)::int AS row_count
    FROM keyword_current_summary_meta m
  `) as Array<{ meta_week: string; meta_refreshed_at: string; kcs_max_week: string; row_count: number }>;
  const r = rows[0];
  console.log(`keyword_current_summary_meta:`);
  console.log(`  row_count: ${r.row_count}`);
  console.log(`  current_week_end_date: ${r.meta_week}`);
  console.log(`  refreshed_at: ${r.meta_refreshed_at}`);
  console.log(`\nkcs.MAX(current_week_end_date): ${r.kcs_max_week}`);
  console.log(`\nmatch: ${r.meta_week === r.kcs_max_week ? '✓' : '✗'}`);
  if (r.row_count !== 1 || r.meta_week !== r.kcs_max_week) {
    console.error('VERIFICATION FAILED');
    process.exit(1);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
