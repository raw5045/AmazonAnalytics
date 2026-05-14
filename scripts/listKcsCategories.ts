/**
 * Pull the exhaustive list of top_clicked_category_1_current values
 * present in the current kcs, with default-severity counts so we can
 * see relative volume. Used to design the category exclusion list
 * for the Keepa enrichment scope.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';

async function main() {
  const sql = neon(process.env.DATABASE_URL!);
  const meta = (await sql`
    SELECT snapshot_version::text AS sv FROM keyword_current_summary_meta WHERE singleton = true
  `) as Array<{ sv: string }>;
  const sv = meta[0].sv;

  const rows = (await sql`
    SELECT category, default_severity_count, all_count
    FROM keyword_current_summary_category_facets
    WHERE snapshot_version = ${sv}::uuid
    ORDER BY all_count DESC
  `) as Array<{ category: string; default_severity_count: number; all_count: number }>;

  console.log(`\n${rows.length} categories in current snapshot (${sv}):\n`);
  console.log('rank | all_count   | default_severity_count | category');
  console.log('-----|-------------|------------------------|----------');
  rows.forEach((r, i) => {
    console.log(
      `${(i + 1).toString().padStart(4)} | ${r.all_count.toLocaleString().padStart(11)} | ${r.default_severity_count.toLocaleString().padStart(22)} | ${r.category}`,
    );
  });
}
main().catch((e) => { console.error(e); process.exit(1); });
