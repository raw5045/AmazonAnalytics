import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';

async function main() {
  const sql = neon(process.env.DATABASE_URL!);

  console.log('\n=== Row count ===');
  const [t] = (await sql`SELECT COUNT(*)::int c FROM keyword_current_summary`) as Array<{ c: number }>;
  console.log(' rows:', t.c.toLocaleString());

  console.log('\n=== New click/conversion share population ===');
  const [s] = (await sql`
    SELECT
      COUNT(*) FILTER (WHERE top_clicked_product_1_click_share_current IS NOT NULL)::int has_click,
      COUNT(*) FILTER (WHERE top_clicked_product_1_conversion_share_current IS NOT NULL)::int has_conv,
      COUNT(*)::int total
    FROM keyword_current_summary
  `) as Array<{ has_click: number; has_conv: number; total: number }>;
  console.log(`  click_share populated: ${s.has_click.toLocaleString()} / ${s.total.toLocaleString()} (${((s.has_click/s.total)*100).toFixed(1)}%)`);
  console.log(`  conv_share populated:  ${s.has_conv.toLocaleString()} / ${s.total.toLocaleString()} (${((s.has_conv/s.total)*100).toFixed(1)}%)`);

  console.log('\n=== Sample row with shares ===');
  const [sample] = (await sql`
    SELECT st.search_term_raw,
           kcs.current_rank,
           kcs.top_clicked_product_1_title_current,
           kcs.top_clicked_product_1_click_share_current,
           kcs.top_clicked_product_1_conversion_share_current
    FROM keyword_current_summary kcs
    JOIN search_terms st ON st.id = kcs.search_term_id
    WHERE kcs.top_clicked_product_1_click_share_current IS NOT NULL
      AND kcs.current_rank < 1000
    LIMIT 1
  `) as Array<Record<string, unknown>>;
  console.log(JSON.stringify(sample, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
