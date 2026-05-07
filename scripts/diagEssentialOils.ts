/**
 * Look at the actual weekly history for "essential oils" by walking
 * kwm via search_terms.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';

async function main() {
  const sql = neon(process.env.DATABASE_URL!);

  console.log('\n=== search_terms rows whose normalized = "essential oils" ===');
  const ids = (await sql`
    SELECT id, search_term_raw, length(search_term_raw) AS raw_len
    FROM search_terms
    WHERE search_term_normalized = 'essential oils'
  `) as Array<{ id: string; search_term_raw: string; raw_len: number }>;
  for (const r of ids) console.log(`  ${r.id}  raw_len=${r.raw_len}  raw="${r.search_term_raw}"`);

  console.log('\n=== kwm history for that search_term_id ===');
  const id = ids[0]?.id;
  if (!id) {
    console.log('  no match found');
    return;
  }
  const hist = (await sql`
    SELECT week_end_date, actual_rank,
           top_clicked_product_1_title,
           source_file_id
    FROM keyword_weekly_metrics
    WHERE search_term_id = ${id}
    ORDER BY week_end_date
  `) as Array<Record<string, unknown>>;
  console.log(`  ${hist.length} rows`);
  for (const r of hist) {
    const date = String(r.week_end_date).slice(0, 10);
    const rank = (r.actual_rank as number).toLocaleString();
    const title = String(r.top_clicked_product_1_title ?? '').slice(0, 60);
    console.log(`  ${date}  rank=${rank.padStart(12)}  product1="${title}"`);
  }

  console.log('\n=== Now check staging for week 2026-04-04 — which RAW was it imported as? ===');
  // Look for any staging rows that mention essential oils in raw
  const staging = (await sql`
    SELECT week_end_date, search_term_raw, search_term_normalized, actual_rank, source_file_id
    FROM staging_weekly_metrics
    WHERE search_term_normalized = 'essential oils'
    LIMIT 20
  `) as Array<Record<string, unknown>>;
  console.log(`  ${staging.length} staging rows (post-import staging is usually empty)`);
  for (const s of staging) {
    console.log(`  ${String(s.week_end_date).slice(0, 10)}  raw="${s.search_term_raw}"  rank=${s.actual_rank}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
