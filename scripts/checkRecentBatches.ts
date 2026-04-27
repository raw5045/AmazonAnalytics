import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';

async function main() {
  const sql = neon(process.env.DATABASE_URL!);

  console.log('\n=== MOST RECENT BATCH ===');
  const [batch] = (await sql`
    SELECT id, status, completed_at, created_at
    FROM upload_batches
    ORDER BY created_at DESC
    LIMIT 1
  `) as Array<{ id: string; status: string; completed_at: string | null; created_at: string }>;
  if (!batch) {
    console.log('(none)');
    return;
  }
  console.log(` ${batch.id.slice(0, 8)} | ${batch.status} | created ${batch.created_at}`);
  console.log(` completed_at: ${batch.completed_at}`);

  console.log('\n=== FILES IN THIS BATCH ===');
  const files = (await sql`
    SELECT id, original_filename, validation_status, row_count_raw, row_count_loaded,
           import_phase, import_worker_boot_id, import_started_at, import_heartbeat_at,
           imported_at, validation_errors_json
    FROM uploaded_files
    WHERE batch_id = ${batch.id}
    ORDER BY week_end_date
  `) as Array<{
    id: string;
    original_filename: string;
    validation_status: string;
    row_count_raw: number | null;
    row_count_loaded: number | null;
    import_phase: string | null;
    import_worker_boot_id: string | null;
    import_started_at: string | null;
    import_heartbeat_at: string | null;
    imported_at: string | null;
    validation_errors_json: unknown;
  }>;

  for (const f of files) {
    console.log(`\n ${f.id.slice(0, 8)} | ${f.original_filename}`);
    console.log(`   status: ${f.validation_status}`);
    console.log(`   raw / loaded: ${f.row_count_raw?.toLocaleString() ?? 'null'} / ${f.row_count_loaded?.toLocaleString() ?? 'null'}`);
    console.log(`   imported_at: ${f.imported_at ?? 'null'}`);
    console.log(`   last phase: ${f.import_phase ?? 'null'}`);
    console.log(`   started_at: ${f.import_started_at ?? 'null'} | heartbeat_at: ${f.import_heartbeat_at ?? 'null'}`);
    if (f.validation_errors_json) {
      console.log(`   error: ${JSON.stringify(f.validation_errors_json)}`);
    }
  }

  console.log('\n=== KWM ROWS PER FILE IN THIS BATCH ===');
  const fileIds = files.map((f) => f.id);
  if (fileIds.length > 0) {
    const kwm = (await sql`
      SELECT source_file_id, COUNT(*)::int c
      FROM keyword_weekly_metrics
      WHERE source_file_id = ANY(${fileIds}::uuid[])
      GROUP BY source_file_id
    `) as Array<{ source_file_id: string; c: number }>;
    const byId = new Map(kwm.map((k) => [k.source_file_id, k.c]));
    for (const f of files) {
      const c = byId.get(f.id) ?? 0;
      console.log(` ${f.id.slice(0, 8)} | ${c.toLocaleString()} rows`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
