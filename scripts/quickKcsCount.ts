import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';

async function main() {
  const sql = neon(process.env.DATABASE_URL!);
  const [r] = (await sql`SELECT COUNT(*)::int c FROM keyword_current_summary`) as Array<{ c: number }>;
  console.log('rows:', r.c.toLocaleString());
}
main().catch((e) => { console.error(e); process.exit(1); });
