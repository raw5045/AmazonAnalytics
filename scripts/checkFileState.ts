/**
 * Inspect the most recent file's full state including the captured error,
 * phase progression, and worker boot ID. Used to diagnose post-mortem
 * what happened to a failed import.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';

async function main() {
  const sql = neon(process.env.DATABASE_URL!);

  console.log('\n=== MOST RECENT FILE ===');
  const [file] = (await sql`
    SELECT id, batch_id, original_filename, validation_status, validation_errors_json,
           import_started_at, import_heartbeat_at, import_phase, import_worker_boot_id,
           row_count_raw, row_count_loaded, imported_at, created_at
    FROM uploaded_files
    ORDER BY created_at DESC
    LIMIT 1
  `) as Array<{
    id: string;
    batch_id: string;
    original_filename: string;
    validation_status: string;
    validation_errors_json: unknown;
    import_started_at: string | null;
    import_heartbeat_at: string | null;
    import_phase: string | null;
    import_worker_boot_id: string | null;
    row_count_raw: number | null;
    row_count_loaded: number | null;
    imported_at: string | null;
    created_at: string;
  }>;
  if (!file) {
    console.log(' (no files found)');
    return;
  }

  console.log(` ${file.id.slice(0, 8)} | ${file.original_filename}`);
  console.log(`  batch: ${file.batch_id.slice(0, 8)}`);
  console.log(`  status: ${file.validation_status}`);
  console.log(`  raw rows: ${file.row_count_raw?.toLocaleString() ?? 'null'}`);
  console.log(`  loaded rows: ${file.row_count_loaded?.toLocaleString() ?? 'null'}`);
  console.log(`  started_at: ${file.import_started_at ?? 'null'}`);
  console.log(`  heartbeat_at: ${file.import_heartbeat_at ?? 'null'}`);
  console.log(`  imported_at: ${file.imported_at ?? 'null'}`);
  console.log(`  last phase: ${file.import_phase ?? 'null'}`);
  console.log(`  worker boot_id: ${file.import_worker_boot_id ?? 'null'}`);
  console.log(`\n  validation_errors_json:`);
  console.log(JSON.stringify(file.validation_errors_json, null, 4));

  console.log('\n=== PHASE TIMINGS for this file ===');
  const phases = (await sql`
    SELECT phase, started_at, ended_at, duration_ms, rows_affected
    FROM import_phase_timings
    WHERE uploaded_file_id = ${file.id}
    ORDER BY started_at
  `) as Array<{
    phase: string;
    started_at: string;
    ended_at: string;
    duration_ms: number;
    rows_affected: number | null;
  }>;
  if (phases.length === 0) console.log(' (no timings logged)');
  for (const p of phases) {
    const sec = (Number(p.duration_ms) / 1000).toFixed(2);
    console.log(` ${p.phase.padEnd(28)} | ${sec.padStart(8)}s | rows=${p.rows_affected ?? '-'}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
