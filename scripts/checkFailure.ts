/**
 * Repurposed: fix metadata for files/batches where the orchestrator marked
 * them failed/orphaned but the underlying detached Promise actually
 * succeeded (race condition before the orchestrator hardening commit).
 *
 * Specifically: clear stale validation_errors_json from files now in
 * 'imported' status, and re-finalize batches whose only-file is imported.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';

async function main() {
  const sql = neon(process.env.DATABASE_URL!);

  // Find files marked imported that still have a stale error blob
  const stale = (await sql`
    SELECT id, batch_id, original_filename, validation_errors_json
    FROM uploaded_files
    WHERE validation_status = 'imported'
      AND validation_errors_json IS NOT NULL
  `) as Array<{ id: string; batch_id: string; original_filename: string; validation_errors_json: unknown }>;

  console.log(`Found ${stale.length} imported file(s) with stale error blobs:`);
  for (const f of stale) {
    console.log(` - ${f.id.slice(0, 8)} | ${f.original_filename} | batch=${f.batch_id.slice(0, 8)}`);
  }

  if (stale.length > 0) {
    const ids = stale.map((f) => f.id);
    await sql`UPDATE uploaded_files SET validation_errors_json = NULL WHERE id = ANY(${ids}::uuid[])`;
    console.log('Cleared stale errors.');
  }

  // ALSO find batches in 'imported_partial' / 'failed' / 'importing' state
  // whose files have all reached terminal states. The orchestrator may
  // have tallied a stale 'failed' count, OR the orchestrator function
  // ended without reaching finalize-batch (e.g., Inngest per-function
  // execution time limit on long batches with many polling steps).
  const misfinalized = (await sql`
    SELECT b.id
    FROM upload_batches b
    WHERE b.status IN ('imported_partial', 'failed', 'importing')
      AND NOT EXISTS (
        SELECT 1 FROM uploaded_files uf
        WHERE uf.batch_id = b.id
          AND uf.validation_status NOT IN ('imported', 'fail', 'import_failed')
      )
      AND EXISTS (
        SELECT 1 FROM uploaded_files uf
        WHERE uf.batch_id = b.id
          AND uf.validation_status = 'imported'
      )
  `) as Array<{ id: string }>;

  // For each affected batch, re-evaluate batch status from its files
  const batchIds = Array.from(new Set([
    ...stale.map((f) => f.batch_id),
    ...misfinalized.map((b) => b.id),
  ]));
  for (const batchId of batchIds) {
    const summary = (await sql`
      SELECT validation_status, COUNT(*)::int c
      FROM uploaded_files
      WHERE batch_id = ${batchId}
      GROUP BY validation_status
    `) as Array<{ validation_status: string; c: number }>;
    const counts = Object.fromEntries(summary.map((s) => [s.validation_status, s.c]));
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const imported = counts.imported ?? 0;
    const failed = counts.import_failed ?? 0;
    let newStatus: string;
    if (imported === total) newStatus = 'imported';
    else if (imported > 0 && failed > 0) newStatus = 'imported_partial';
    else if (failed === total) newStatus = 'failed';
    else newStatus = 'imported_partial'; // mixed pending/pass/etc; close enough for now
    await sql`UPDATE upload_batches SET status = ${newStatus}, completed_at = NOW() WHERE id = ${batchId}`;
    console.log(`Batch ${batchId.slice(0, 8)} -> ${newStatus} (${imported} imported, ${failed} failed, ${total} total)`);
  }
}

main().catch(console.error);
