import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';

async function main() {
  const sql = neon(process.env.DATABASE_URL!);
  const [k] = (await sql`SELECT COUNT(*)::int c FROM keyword_weekly_metrics`) as Array<{ c: number }>;
  const [s] = (await sql`SELECT COUNT(*)::int c FROM search_terms`) as Array<{ c: number }>;
  const [stg] = (await sql`SELECT COUNT(*)::int c FROM staging_weekly_metrics`) as Array<{ c: number }>;
  const [weeks] = (await sql`SELECT COUNT(*)::int c FROM reporting_weeks`) as Array<{ c: number }>;
  const [latestImport] = (await sql`SELECT validation_status, original_filename, row_count_loaded, imported_at FROM uploaded_files ORDER BY created_at DESC LIMIT 1`) as Array<{ validation_status: string; original_filename: string; row_count_loaded: number | null; imported_at: string | null }>;
  const [latestBatch] = (await sql`SELECT status, completed_at FROM upload_batches ORDER BY created_at DESC LIMIT 1`) as Array<{ status: string; completed_at: string | null }>;
  console.log(new Date().toISOString().slice(11, 19), '|',
    'kwm:', k.c.toLocaleString(),
    '| staging:', stg.c.toLocaleString(),
    '| search_terms:', s.c.toLocaleString(),
    '| weeks:', weeks.c,
    '| latest file:', latestImport?.validation_status,
    '| batch:', latestBatch?.status,
  );
}
main().catch((e) => { console.error(e); process.exit(1); });
