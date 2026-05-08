import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';

async function main() {
  const sql = neon(process.env.DATABASE_URL!);
  const fileId = '9a9b8cdb-7235-4895-8e80-d0cd3a78ef71';

  console.log('\n=== 1. import_duplicate_search_terms for this file ===');
  const [c] = (await sql`
    SELECT COUNT(*)::int c, MAX(duplicate_count)::int max_dup,
           SUM(duplicate_count - 1)::int total_dropped
    FROM import_duplicate_search_terms
    WHERE uploaded_file_id = ${fileId}
  `) as Array<{ c: number; max_dup: number | null; total_dropped: number | null }>;
  console.log(`  ${c.c.toLocaleString()} duplicate groups detected`);
  console.log(`  max group size: ${c.max_dup ?? 0}`);
  console.log(`  total rows dropped (duplicates - 1): ${c.total_dropped ?? 0}`);

  console.log('\n  Sample groups (highest duplicate count first):');
  const samples = (await sql`
    SELECT search_term_normalized, duplicate_count, winning_rank, losing_ranks, raw_examples
    FROM import_duplicate_search_terms
    WHERE uploaded_file_id = ${fileId}
    ORDER BY duplicate_count DESC, winning_rank ASC
    LIMIT 10
  `) as Array<Record<string, unknown>>;
  for (const s of samples) {
    console.log(`    "${s.search_term_normalized}": ${s.duplicate_count}× (won: ${s.winning_rank}, lost: ${JSON.stringify(s.losing_ranks)})`);
    const examples = s.raw_examples as string[];
    examples.slice(0, 2).forEach((ex) => {
      const hex = Array.from(ex).slice(0, 30).map((c) => c.codePointAt(0)?.toString(16)).join(' ');
      console.log(`      raw: "${ex}" hex: ${hex}`);
    });
  }

  console.log('\n=== 2. "essential oils" rank for 5/02 in kwm ===');
  const [eo] = (await sql`
    SELECT k.actual_rank, k.top_clicked_product_1_title
    FROM keyword_weekly_metrics k
    JOIN search_terms st ON st.id = k.search_term_id
    WHERE st.search_term_normalized = 'essential oils'
      AND k.week_end_date = '2026-05-02'::date
  `) as Array<{ actual_rank: number; top_clicked_product_1_title: string }>;
  console.log(`  rank: ${eo?.actual_rank?.toLocaleString() ?? '(not found)'}`);
  console.log(`  product: ${(eo?.top_clicked_product_1_title ?? '').slice(0, 80)}`);
  console.log(`  prior smoke-test value was 961; should still be reasonable (low number)`);

  console.log('\n=== 3. search_terms.search_term_raw for "essential oils" ===');
  const [st] = (await sql`
    SELECT id, search_term_raw, length(search_term_raw) AS raw_len
    FROM search_terms
    WHERE search_term_normalized = 'essential oils'
  `) as Array<{ id: string; search_term_raw: string; raw_len: number }>;
  if (st) {
    const hex = Array.from(st.search_term_raw).map((c) => c.codePointAt(0)?.toString(16)).join(' ');
    console.log(`  raw: "${st.search_term_raw}"`);
    console.log(`  hex: ${hex}`);
    console.log(`  len: ${st.raw_len}`);
    console.log(`  was "￼essential oils" (15 chars including OBJ); should now be "essential oils" (14)`);
  }

  console.log('\n=== 4. live keyword_current_summary state ===');
  const [live] = (await sql`
    SELECT MAX(current_week_end_date) latest, COUNT(*)::int rows
    FROM keyword_current_summary
  `) as Array<{ latest: string; rows: number }>;
  console.log(`  latest week: ${String(live.latest).slice(0, 10)}`);
  console.log(`  total rows: ${live.rows.toLocaleString()}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
