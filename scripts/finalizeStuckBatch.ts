/**
 * For a batch that's stuck in 'importing' status because the orchestrator
 * ended without finishing all files (Inngest per-run execution limit),
 * mark any remaining 'pass' files as 'import_failed' with a clear reason
 * and re-finalize the batch status.
 *
 * Use case: 8-file batch where orchestrator imported 6/8 files cleanly
 * but stopped before scheduling the last 2 — leaves them in 'pass'
 * indefinitely.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';

async function main() {
  const sql = neon(process.env.DATABASE_URL!);

  // Most recent batch that's stuck in 'importing'
  const [batch] = (await sql`
    SELECT id, status FROM upload_batches
    WHERE status = 'importing'
    ORDER BY created_at DESC LIMIT 1
  `) as Array<{ id: string; status: string }>;
  if (!batch) {
    console.log('No batches stuck in importing status.');
    return;
  }
  console.log(`Found stuck batch ${batch.id.slice(0, 8)}`);

  // Find files in 'pass' status (orchestrator never reached them)
  const stranded = (await sql`
    SELECT id, original_filename, week_end_date
    FROM uploaded_files
    WHERE batch_id = ${batch.id}
      AND validation_status IN ('pass', 'pass_with_warnings')
  `) as Array<{ id: string; original_filename: string; week_end_date: string }>;

  console.log(`Found ${stranded.length} stranded file(s):`);
  for (const f of stranded) {
    const ws = f.week_end_date?.toString().slice(0, 10);
    console.log(`  - ${f.id.slice(0, 8)} | ${ws} | ${f.original_filename}`);
  }

  if (stranded.length > 0) {
    const ids = stranded.map((f) => f.id);
    await sql`
      UPDATE uploaded_files
      SET validation_status = 'import_failed',
          validation_errors_json = ${JSON.stringify({
            error: 'Orchestrator ended before reaching this file (Inngest function-run ceiling on long batches). Re-upload to retry.',
            outcome: 'orchestrator-stopped',
          })}::jsonb
      WHERE id = ANY(${ids}::uuid[])
    `;
    console.log(`Marked ${stranded.length} stranded file(s) as import_failed.`);
  }

  // Re-derive batch status from file states
  const summary = (await sql`
    SELECT validation_status, COUNT(*)::int c
    FROM uploaded_files
    WHERE batch_id = ${batch.id}
    GROUP BY validation_status
  `) as Array<{ validation_status: string; c: number }>;
  const counts = Object.fromEntries(summary.map((s) => [s.validation_status, s.c]));
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const imported = counts.imported ?? 0;
  const failed = (counts.import_failed ?? 0) + (counts.fail ?? 0);
  let newStatus: string;
  if (imported === total) newStatus = 'imported';
  else if (imported > 0 && failed > 0) newStatus = 'imported_partial';
  else newStatus = 'failed';

  await sql`
    UPDATE upload_batches
    SET status = ${newStatus}, completed_at = NOW()
    WHERE id = ${batch.id}
  `;
  console.log(`Batch ${batch.id.slice(0, 8)} -> ${newStatus} (${imported} imported, ${failed} failed, ${total} total)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
