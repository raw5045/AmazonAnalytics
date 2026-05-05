/**
 * Sanity-check the new loose-match flags after refresh.
 *
 * Confirms:
 *   - Both strict and loose columns are populated
 *   - Loose match rate is >= strict (a stricter check should never
 *     mark MORE matches than a looser check)
 *   - The "Creatine Gummies" + "Creatine Monohydrate Gummies" example
 *     now shows in_title=true under loose
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';

async function main() {
  const sql = neon(process.env.DATABASE_URL!);

  console.log('\n=== Population coverage ===');
  const [c] = (await sql`
    SELECT
      COUNT(*)::int total,
      COUNT(*) FILTER (WHERE keyword_in_title_1_loose_current IS NOT NULL)::int loose1_pop,
      COUNT(*) FILTER (WHERE keyword_in_title_1_current IS NOT NULL)::int strict1_pop,
      COUNT(*) FILTER (WHERE keyword_in_title_1_loose_current = true)::int loose1_true,
      COUNT(*) FILTER (WHERE keyword_in_title_1_current = true)::int strict1_true
    FROM keyword_current_summary
  `) as Array<Record<string, number>>;

  console.log(` total rows:               ${c.total.toLocaleString()}`);
  console.log(` loose flag populated:     ${c.loose1_pop.toLocaleString()} (${((c.loose1_pop/c.total)*100).toFixed(1)}%)`);
  console.log(` strict flag populated:    ${c.strict1_pop.toLocaleString()} (${((c.strict1_pop/c.total)*100).toFixed(1)}%)`);
  console.log(` loose=true rate:          ${c.loose1_true.toLocaleString()} (${((c.loose1_true/c.total)*100).toFixed(1)}%)`);
  console.log(` strict=true rate:         ${c.strict1_true.toLocaleString()} (${((c.strict1_true/c.total)*100).toFixed(1)}%)`);

  console.log('\n=== Loose ⊇ Strict invariant ===');
  // For any term where strict=true and title is non-null, loose should also be true.
  const [v] = (await sql`
    SELECT COUNT(*)::int violations
    FROM keyword_current_summary
    WHERE keyword_in_title_1_current = true
      AND keyword_in_title_1_loose_current = false
  `) as Array<{ violations: number }>;
  console.log(` rows where strict=true but loose=false: ${v.violations}  (should be 0 or near-0; punctuation edge cases may cause stragglers)`);

  console.log('\n=== Examples: loose=true but strict=false ===');
  const examples = (await sql`
    SELECT st.search_term_raw,
           kcs.top_clicked_product_1_title_current AS title,
           kcs.keyword_in_title_1_current AS strict,
           kcs.keyword_in_title_1_loose_current AS loose
    FROM keyword_current_summary kcs
    JOIN search_terms st ON st.id = kcs.search_term_id
    WHERE kcs.keyword_in_title_1_loose_current = true
      AND kcs.keyword_in_title_1_current = false
      AND kcs.current_rank < 1000
    LIMIT 10
  `) as Array<Record<string, unknown>>;
  for (const e of examples) {
    console.log(`  • "${e.search_term_raw}"`);
    console.log(`      title: ${String(e.title).slice(0, 100)}`);
    console.log(`      strict: ${e.strict} | loose: ${e.loose}`);
  }

  console.log('\n=== Specifically check "Creatine Gummies" pattern ===');
  const creatine = (await sql`
    SELECT st.search_term_raw,
           kcs.top_clicked_product_1_title_current AS title,
           kcs.keyword_in_title_1_current AS strict,
           kcs.keyword_in_title_1_loose_current AS loose
    FROM keyword_current_summary kcs
    JOIN search_terms st ON st.id = kcs.search_term_id
    WHERE st.search_term_raw ILIKE '%creatine%gumm%'
      AND st.search_term_raw NOT ILIKE '%creatine monohydrate gummies%'
    LIMIT 5
  `) as Array<Record<string, unknown>>;
  for (const e of creatine) {
    console.log(`  • "${e.search_term_raw}"`);
    console.log(`      title: ${String(e.title).slice(0, 100)}`);
    console.log(`      strict: ${e.strict} | loose: ${e.loose}`);
  }

  console.log('\n=== Match-count-loose distribution ===');
  const dist = (await sql`
    SELECT keyword_title_match_count_loose_current AS n, COUNT(*)::int c
    FROM keyword_current_summary
    GROUP BY keyword_title_match_count_loose_current
    ORDER BY keyword_title_match_count_loose_current NULLS FIRST
  `) as Array<{ n: number | null; c: number }>;
  for (const d of dist) {
    console.log(`  ${d.n === null ? '<NULL>' : d.n} matches: ${d.c.toLocaleString()}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
