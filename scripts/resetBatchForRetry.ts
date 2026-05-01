/**
 * Reset a partially-imported batch back to 'clean' so the user can
 * re-click Import to process the remaining files. The orchestrator's
 * fetch-files step filters by validation_status IN ('pass',
 * 'pass_with_warnings'), so already-imported files are skipped — only
 * the stranded ones get processed on the retry.
 *
 * Use case: 4-file batch where orchestrator imported 3/4 and stopped
 * before reaching the 4th. Saves a re-upload by reusing the existing
 * uploaded_files row + R2 object for the unimported file.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';

async function main() {
  const sql = neon(process.env.DATABASE_URL!);

  const [batch] = (await sql`
    SELECT id, status FROM upload_batches
    WHERE status = 'importing'
    ORDER BY created_at DESC LIMIT 1
  `) as Array<{ id: string; status: string }>;
  if (!batch) {
    console.log('No batches stuck in importing status.');
    return;
  }
  console.log(`Found stuck batch ${batch.id.slice(0, 8)} (status=${batch.status})`);

  const stranded = (await sql`
    SELECT original_filename, week_end_date
    FROM uploaded_files
    WHERE batch_id = ${batch.id}
      AND validation_status IN ('pass', 'pass_with_warnings')
    ORDER BY week_end_date
  `) as Array<{ original_filename: string; week_end_date: string }>;
  console.log(`Files that will be re-attempted on next Import click (${stranded.length}):`);
  for (const f of stranded) {
    console.log(`  - ${f.week_end_date?.toString().slice(0, 10)} | ${f.original_filename}`);
  }

  // Reset batch status to 'clean' (a valid pre-import state) and clear
  // completed_at so the UI doesn't show a stale completion timestamp.
  await sql`
    UPDATE upload_batches
    SET status = 'clean', completed_at = NULL
    WHERE id = ${batch.id}
  `;
  console.log(`\nBatch ${batch.id.slice(0, 8)} -> clean. Click 'Import valid files' to retry stranded files.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
