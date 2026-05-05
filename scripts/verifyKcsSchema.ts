import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';

async function main() {
  const sql = neon(process.env.DATABASE_URL!);

  console.log('\n=== New columns ===');
  const cols = (await sql`
    SELECT column_name, data_type, numeric_precision, numeric_scale
    FROM information_schema.columns
    WHERE table_name = 'keyword_current_summary'
      AND column_name IN ('top_clicked_product_1_click_share_current', 'top_clicked_product_1_conversion_share_current')
    ORDER BY column_name
  `) as Array<Record<string, unknown>>;
  for (const c of cols) console.log(' ', JSON.stringify(c));

  console.log('\n=== Jump indexes ===');
  const idx = (await sql`
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE tablename = 'keyword_current_summary'
      AND indexname LIKE 'kcs_jump_%'
    ORDER BY indexname
  `) as Array<{ indexname: string; indexdef: string }>;
  for (const i of idx) console.log(`  ${i.indexname}\n    ${i.indexdef}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
