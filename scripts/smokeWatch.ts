/**
 * Smoke-test watcher for the post-fix batch import.
 *
 * Emits to stdout ONLY when something worth notifying happens:
 *   ALERT:   staging-duplication (> 3M rows for a single file)
 *   ALERT:   imported-but-empty (status=imported, 0 rows in kwm for source_file_id)
 *   ALERT:   import-failed (any file in import_failed status)
 *   STATUS:  batch terminal (imported / imported_partial / failed)
 *   DONE:    batch complete, emit final summary
 *
 * Stays silent during normal progress — user watches the live batch page UI
 * for that. We emit only red flags and the final outcome.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';

async function main() {
  const sql = neon(process.env.DATABASE_URL!);

  // Pick the batch under active observation: any currently-importing batch,
  // else the most recent batch (covers just-completed terminal states so we
  // emit DONE once).
  const [batch] = (await sql`
    SELECT id, status, created_at, completed_at
    FROM upload_batches
    ORDER BY
      CASE WHEN status IN ('uploaded','validating','importing') THEN 0 ELSE 1 END,
      created_at DESC
    LIMIT 1
  `) as Array<{ id: string; status: string; created_at: string; completed_at: string | null }>;

  if (!batch) {
    console.log('ALERT: no batches at all in upload_batches');
    return;
  }

  const files = (await sql`
    SELECT id, original_filename, week_end_date, validation_status, row_count_raw, row_count_loaded
    FROM uploaded_files
    WHERE batch_id = ${batch.id}
    ORDER BY week_end_date
  `) as Array<{
    id: string;
    original_filename: string;
    week_end_date: string;
    validation_status: string;
    row_count_raw: number | null;
    row_count_loaded: number | null;
  }>;

  // Check staging duplication
  const staging = (await sql`
    SELECT uploaded_file_id, COUNT(*)::int c
    FROM staging_weekly_metrics
    WHERE uploaded_file_id = ANY(${files.map((f) => f.id)}::uuid[])
    GROUP BY uploaded_file_id
  `) as Array<{ uploaded_file_id: string; c: number }>;
  const stagingByFile = new Map(staging.map((s) => [s.uploaded_file_id, s.c]));

  for (const f of files) {
    const rawCount = f.row_count_raw ?? 0;
    const stgCount = stagingByFile.get(f.id) ?? 0;
    // Red flag: staging count > 1.2x raw count (allowing for minor inflation)
    if (rawCount > 0 && stgCount > rawCount * 1.2) {
      console.log(`ALERT: staging-duplication file=${f.id.slice(0, 8)} (${f.original_filename}) raw=${rawCount.toLocaleString()} staging=${stgCount.toLocaleString()} ratio=${(stgCount / rawCount).toFixed(2)}x`);
    }
  }

  // Check kwm per source_file_id — flag imported files with 0 rows
  const kwmCounts = (await sql`
    SELECT source_file_id, COUNT(*)::int c
    FROM keyword_weekly_metrics
    WHERE source_file_id = ANY(${files.map((f) => f.id)}::uuid[])
    GROUP BY source_file_id
  `) as Array<{ source_file_id: string; c: number }>;
  const kwmByFile = new Map(kwmCounts.map((k) => [k.source_file_id, k.c]));

  for (const f of files) {
    if (f.validation_status === 'imported') {
      const kwmCount = kwmByFile.get(f.id) ?? 0;
      if (kwmCount === 0) {
        console.log(`ALERT: imported-but-empty file=${f.id.slice(0, 8)} (${f.original_filename}) status=imported but 0 rows in kwm`);
      }
    }
    if (f.validation_status === 'import_failed') {
      console.log(`ALERT: import-failed file=${f.id.slice(0, 8)} (${f.original_filename})`);
    }
  }

  // Batch terminal state?
  if (['imported', 'imported_partial', 'failed'].includes(batch.status)) {
    const statusCounts: Record<string, number> = {};
    for (const f of files) {
      statusCounts[f.validation_status] = (statusCounts[f.validation_status] ?? 0) + 1;
    }
    const totalKwm = Array.from(kwmByFile.values()).reduce((a, b) => a + b, 0);
    console.log(`DONE: batch=${batch.id.slice(0, 8)} status=${batch.status} files=${JSON.stringify(statusCounts)} kwm_rows=${totalKwm.toLocaleString()}`);
  }
}

main().catch((e) => {
  console.log(`ALERT: smoke-watch error: ${e instanceof Error ? e.message : String(e)}`);
});
