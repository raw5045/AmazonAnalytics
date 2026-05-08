import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';

async function main() {
  const sql = neon(process.env.DATABASE_URL!);

  console.log('\n=== Total uploaded_files (all statuses) ===');
  const [a] = (await sql`SELECT COUNT(*)::int c FROM uploaded_files`) as Array<{ c: number }>;
  console.log(`  ${a.c}`);

  console.log('\n=== uploaded_files where validation_status = imported ===');
  const [b] = (await sql`SELECT COUNT(*)::int c FROM uploaded_files WHERE validation_status = 'imported'`) as Array<{ c: number }>;
  console.log(`  ${b.c}  ← what the replay script processes`);

  console.log('\n=== Distinct week_end_dates among imported files ===');
  const [c] = (await sql`SELECT COUNT(DISTINCT week_end_date)::int c FROM uploaded_files WHERE validation_status = 'imported' AND week_end_date IS NOT NULL`) as Array<{ c: number }>;
  console.log(`  ${c.c}  ← unique weeks of data`);

  console.log('\n=== Weeks with multiple imported uploaded_files rows ===');
  const dups = (await sql`
    SELECT week_end_date::text, COUNT(*)::int c
    FROM uploaded_files
    WHERE validation_status = 'imported'
      AND week_end_date IS NOT NULL
    GROUP BY week_end_date
    HAVING COUNT(*) > 1
    ORDER BY week_end_date
  `) as Array<{ week_end_date: string; c: number }>;
  console.log(`  ${dups.length} weeks have duplicate uploaded_files rows:`);
  for (const d of dups) console.log(`    ${d.week_end_date}: ${d.c} rows`);

  console.log('\n=== Detailed look at the duplicate-row weeks ===');
  if (dups.length > 0) {
    const weeks = dups.map((d) => d.week_end_date);
    const detail = (await sql`
      SELECT week_end_date::text week, original_filename, validation_status, is_replacement, replaces_file_id, created_at, imported_at
      FROM uploaded_files
      WHERE week_end_date::text = ANY(${weeks})
      ORDER BY week_end_date, created_at
    `) as Array<Record<string, unknown>>;
    for (const r of detail) {
      console.log(`  [${r.week}] ${r.original_filename}  status=${r.validation_status}  is_replacement=${r.is_replacement}  replaces=${r.replaces_file_id ? 'yes' : 'no'}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
