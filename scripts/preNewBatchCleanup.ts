/**
 * Pre-recovery cleanup for the parallel-import damage:
 *
 *  1. Clear stale staging rows (no worker running, safe to TRUNCATE).
 *  2. Mark the parallel-bug victim (Dec 20: status=imported but kwm=0)
 *     as 'import_failed' with an explanatory note. Otherwise its row
 *     misleadingly says imported with 3.6M rows loaded.
 *  3. Delete the misleading reporting_weeks entry for Dec 20 (points
 *     at a file with no underlying kwm data).
 *  4. Flip batch 285f592c from 'importing' to 'imported_partial' so
 *     it's not stuck and the UI shows a terminal state.
 *
 * After this, user can upload a new batch with the 4 broken/pending
 * weeks (Dec 20, Jan 10, 17, 24) and import normally with the new
 * code.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';

const BATCH_ID = '285f592c'; // prefix; we'll resolve to full
const DEC20_FILE_ID = 'd28e8a8a'; // status=imported but kwm=0

async function main() {
  const sql = neon(process.env.DATABASE_URL!);

  // Resolve full IDs
  const [batch] = (await sql`
    SELECT id FROM upload_batches WHERE id::text LIKE ${BATCH_ID + '%'}
  `) as Array<{ id: string }>;
  if (!batch) throw new Error(`batch ${BATCH_ID} not found`);

  const [dec20] = (await sql`
    SELECT id, week_end_date, validation_status, row_count_loaded
    FROM uploaded_files WHERE id::text LIKE ${DEC20_FILE_ID + '%'}
  `) as Array<{ id: string; week_end_date: string; validation_status: string; row_count_loaded: number | null }>;
  if (!dec20) throw new Error(`file ${DEC20_FILE_ID} not found`);

  console.log(`\nBatch: ${batch.id}`);
  console.log(`Dec 20 file: ${dec20.id} | status=${dec20.validation_status} | loaded=${dec20.row_count_loaded}`);

  // 1. TRUNCATE staging (no worker running)
  console.log('\n[1/4] TRUNCATE staging_weekly_metrics...');
  const [stgBefore] = (await sql`SELECT COUNT(*)::bigint c FROM staging_weekly_metrics`) as Array<{ c: string }>;
  console.log(` rows before: ${Number(stgBefore.c).toLocaleString()}`);
  await sql`TRUNCATE TABLE staging_weekly_metrics`;
  const [stgAfter] = (await sql`SELECT COUNT(*)::bigint c FROM staging_weekly_metrics`) as Array<{ c: string }>;
  console.log(` rows after: ${Number(stgAfter.c).toLocaleString()} ✓`);

  // 2. Mark Dec 20 file as import_failed with explanation
  console.log('\n[2/4] Mark Dec 20 file as import_failed...');
  await sql`
    UPDATE uploaded_files
    SET validation_status = 'import_failed',
        validation_errors_json = ${JSON.stringify({
          error:
            'Parallel-import bug victim: COPY ran but TRUNCATE from another concurrent file wiped staging before INSERT INTO kwm. row_count_loaded reflects the COPY count, not actual rows in kwm.',
          actualKwmRows: 0,
          fixCommit: 'be3432d',
        })}::jsonb,
        row_count_loaded = NULL,
        import_started_at = NULL,
        import_heartbeat_at = NULL
    WHERE id = ${dec20.id}
  `;
  console.log(' ✓');

  // 3. Delete misleading reporting_weeks row for Dec 20
  console.log('\n[3/4] Delete misleading reporting_weeks for Dec 20...');
  const result = (await sql`
    DELETE FROM reporting_weeks
    WHERE source_file_id = ${dec20.id}
    RETURNING week_end_date
  `) as Array<{ week_end_date: string }>;
  console.log(` ${result.length} reporting_weeks row(s) deleted`);

  // 4. Flip batch to imported_partial
  console.log('\n[4/4] Update batch status to imported_partial...');
  await sql`
    UPDATE upload_batches
    SET status = 'imported_partial', completed_at = NOW()
    WHERE id = ${batch.id}
  `;
  console.log(' ✓');

  console.log('\n=== READY FOR NEW BATCH ===');
  console.log(' Upload Dec 20, Jan 10, Jan 17, Jan 24 as a fresh 4-file bulk batch.');
  console.log(' Old batch 285f592c is now finalized as imported_partial (4 imported, 4 failed).');
}

main().catch((e) => { console.error(e); process.exit(1); });
