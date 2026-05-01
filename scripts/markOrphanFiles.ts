/**
 * Mark stuck 'pass' / 'pass_with_warnings' files as 'import_failed'
 * when their week is already represented in reporting_weeks via a
 * different source file. These are orphan duplicates from previous
 * batches where the same week was uploaded multiple times.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';

async function main() {
  const sql = neon(process.env.DATABASE_URL!);

  const stuck = (await sql`
    SELECT uf.id, uf.original_filename, uf.week_end_date, uf.batch_id
    FROM uploaded_files uf
    WHERE uf.validation_status IN ('pass', 'pass_with_warnings')
  `) as Array<{ id: string; original_filename: string; week_end_date: string; batch_id: string }>;

  if (stuck.length === 0) {
    console.log('No stuck files to clean up.');
    return;
  }

  for (const f of stuck) {
    // Check if this week already has data in kwm via a different source
    const [coverage] = (await sql`
      SELECT source_file_id, is_complete
      FROM reporting_weeks
      WHERE week_end_date = ${f.week_end_date}::date
    `) as Array<{ source_file_id: string; is_complete: boolean } | undefined>;

    if (coverage && coverage.is_complete && coverage.source_file_id !== f.id) {
      // Week is already imported via different source. This file is a duplicate.
      await sql`
        UPDATE uploaded_files
        SET validation_status = 'import_failed',
            validation_errors_json = ${JSON.stringify({
              error: 'Duplicate of an already-imported week — week is represented by a different uploaded_file',
              activeSourceFileId: coverage.source_file_id,
              outcome: 'duplicate-skipped',
            })}::jsonb
        WHERE id = ${f.id}
      `;
      const ws = f.week_end_date?.toString().slice(0, 10);
      console.log(` ${f.id.slice(0, 8)} | ${ws} | ${f.original_filename} -> import_failed (dupe; week already covered by ${coverage.source_file_id.slice(0, 8)})`);
    } else {
      console.log(` ${f.id.slice(0, 8)} | ${f.original_filename} -> KEEP (no other coverage for this week)`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
