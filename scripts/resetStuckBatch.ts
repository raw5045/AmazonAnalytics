/**
 * Reset a batch row that's stuck in 'importing' status because the
 * orchestrator died mid-run. Changes status to 'clean' (a valid pre-import
 * state), which lets the user click "Import" again. The re-triggered
 * orchestrator will pick up only the files that are still in 'pass' or
 * 'pass_with_warnings' status — already-imported files are filtered out
 * by the fetch-files step.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';

async function main() {
  const batchId = process.argv[2];
  if (!batchId) {
    console.error('Usage: pnpm tsx scripts/resetStuckBatch.ts <batchId>');
    process.exit(1);
  }

  const sql = neon(process.env.DATABASE_URL!);

  const [before] = (await sql`SELECT status, completed_at FROM upload_batches WHERE id = ${batchId}`) as Array<{
    status: string;
    completed_at: string | null;
  }>;
  if (!before) {
    console.error('Batch not found.');
    process.exit(1);
  }
  console.log(`Batch ${batchId.slice(0, 8)} was: ${before.status}`);

  if (before.status !== 'importing') {
    console.error(`Refusing to reset: status is "${before.status}", not "importing".`);
    process.exit(1);
  }

  // Clear any stale import_started_at locks on files in this batch too.
  const lockClearResult = (await sql`
    UPDATE uploaded_files
    SET import_started_at = NULL
    WHERE batch_id = ${batchId} AND import_started_at IS NOT NULL
    RETURNING id
  `) as Array<{ id: string }>;
  console.log(`Cleared ${lockClearResult.length} stale import_started_at lock(s).`);

  await sql`UPDATE upload_batches SET status = 'clean', completed_at = NULL WHERE id = ${batchId}`;
  console.log(`Batch ${batchId.slice(0, 8)} now: clean (ready for Import click).`);

  // Print remaining unimported files so the user knows what's ahead
  const pending = (await sql`
    SELECT week_end_date, validation_status
    FROM uploaded_files
    WHERE batch_id = ${batchId}
      AND validation_status IN ('pass', 'pass_with_warnings')
    ORDER BY week_end_date
  `) as Array<{ week_end_date: string; validation_status: string }>;
  console.log(`\nFiles that will be picked up on re-import (${pending.length}):`);
  for (const p of pending) {
    console.log(` - ${p.week_end_date?.toString().slice(0, 10)} | ${p.validation_status}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
