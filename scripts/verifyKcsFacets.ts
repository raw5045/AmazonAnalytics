import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';

async function main() {
  const sql = neon(process.env.DATABASE_URL!);
  const meta = (await sql`
    SELECT
      current_week_end_date::text AS week,
      snapshot_version::text AS sv,
      default_severity_total AS total
    FROM keyword_current_summary_meta
    WHERE singleton = true
  `) as Array<{ week: string; sv: string; total: number }>;
  console.log('Meta:');
  console.log(`  week=${meta[0].week}`);
  console.log(`  snapshot_version=${meta[0].sv}`);
  console.log(`  default_severity_total=${meta[0].total.toLocaleString()}`);

  const facets = (await sql`
    SELECT COUNT(*)::int AS facets_count,
           SUM(default_severity_count)::bigint AS sum_default,
           SUM(all_count)::bigint AS sum_all,
           MIN(category) AS first_cat,
           MAX(category) AS last_cat
    FROM keyword_current_summary_category_facets
  `) as Array<{ facets_count: number; sum_default: string; sum_all: string; first_cat: string; last_cat: string }>;
  console.log(`\nFacets:`);
  console.log(`  rows: ${facets[0].facets_count} categories`);
  console.log(`  sum default_severity_count: ${Number(facets[0].sum_default).toLocaleString()}`);
  console.log(`  sum all_count: ${Number(facets[0].sum_all).toLocaleString()}`);
  console.log(`  first category alphabetically: ${facets[0].first_cat}`);
  console.log(`  last category alphabetically: ${facets[0].last_cat}`);

  // Sanity: top 5 categories
  const top = (await sql`
    SELECT category, default_severity_count, all_count
    FROM keyword_current_summary_category_facets
    ORDER BY all_count DESC
    LIMIT 5
  `) as Array<{ category: string; default_severity_count: number; all_count: number }>;
  console.log(`\nTop 5 categories by all_count:`);
  for (const r of top) {
    console.log(`  ${r.category.padEnd(40)} default=${r.default_severity_count.toLocaleString().padStart(8)} all=${r.all_count.toLocaleString().padStart(8)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
