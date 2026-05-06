import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';

async function main() {
  const sql = neon(process.env.DATABASE_URL!);
  const cols = (await sql`SELECT COUNT(*)::int c FROM information_schema.columns WHERE table_name = 'keyword_current_summary_stage'`) as Array<{c:number}>;
  const idx = (await sql`SELECT COUNT(*)::int c FROM pg_indexes WHERE tablename = 'keyword_current_summary_stage'`) as Array<{c:number}>;
  const rows = (await sql`SELECT COUNT(*)::int c FROM keyword_current_summary_stage`) as Array<{c:number}>;
  console.log('cols:', cols[0].c, ' indexes:', idx[0].c, ' rows:', rows[0].c);
}
main().catch(e => { console.error(e); process.exit(1); });
