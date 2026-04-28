import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';

async function main() {
  const sql = neon(process.env.DATABASE_URL!);
  const files = (await sql`
    SELECT id, original_filename, validation_status, row_count_raw,
           import_started_at, import_heartbeat_at, file_checksum, storage_key,
           week_end_date, created_at
    FROM uploaded_files
    WHERE batch_id = '2da29e7c-8e78-412e-a4df-d1fb7e34e513'
    ORDER BY week_end_date
  `) as Array<{
    id: string;
    original_filename: string;
    validation_status: string;
    row_count_raw: number | null;
    import_started_at: string | null;
    import_heartbeat_at: string | null;
    file_checksum: string | null;
    storage_key: string;
    week_end_date: string;
    created_at: string;
  }>;
  for (const f of files) {
    console.log(`\n--- ${f.id.slice(0, 8)} | ${f.original_filename} ---`);
    console.log(`  status: ${f.validation_status}`);
    console.log(`  week: ${f.week_end_date}`);
    console.log(`  rows: ${f.row_count_raw?.toLocaleString() ?? 'null'}`);
    console.log(`  started_at: ${f.import_started_at ?? 'null'}`);
    console.log(`  heartbeat_at: ${f.import_heartbeat_at ?? 'null'}`);
    console.log(`  checksum: ${f.file_checksum ?? 'null'}`);
    console.log(`  storage_key: ${f.storage_key}`);
  }

  // Also get all batches' files for comparison
  console.log('\n\n=== HISTORICAL Feb 07 attempts (all batches) ===');
  const allFeb7 = (await sql`
    SELECT id, batch_id, validation_status, row_count_raw, file_checksum, created_at
    FROM uploaded_files
    WHERE original_filename LIKE '%2026_02_07%'
    ORDER BY created_at DESC
  `) as Array<{
    id: string;
    batch_id: string;
    validation_status: string;
    row_count_raw: number | null;
    file_checksum: string | null;
    created_at: string;
  }>;
  for (const f of allFeb7) {
    console.log(` ${f.id.slice(0, 8)} | batch=${f.batch_id.slice(0, 8)} | ${f.validation_status} | rows=${f.row_count_raw?.toLocaleString() ?? 'null'} | ck=${f.file_checksum?.slice(0, 12) ?? 'null'} | ${f.created_at}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
