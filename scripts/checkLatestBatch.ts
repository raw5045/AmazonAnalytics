import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';

async function main() {
  const sql = neon(process.env.DATABASE_URL!);

  console.log('\n=== Most recent batch ===');
  const [b] = (await sql`
    SELECT id, batch_type, status, total_files, passed_files, failed_files, created_at
    FROM upload_batches
    ORDER BY created_at DESC
    LIMIT 1
  `) as Array<Record<string, unknown>>;
  console.log(JSON.stringify(b, null, 2));

  console.log('\n=== Files in this batch ===');
  const files = (await sql`
    SELECT id, original_filename, validation_status, import_phase,
           import_started_at, import_heartbeat_at, NOW() - import_heartbeat_at AS heartbeat_age
    FROM uploaded_files
    WHERE batch_id = ${b.id}
    ORDER BY created_at
  `) as Array<Record<string, unknown>>;
  for (const f of files) {
    console.log(`  ${f.original_filename}`);
    console.log(`    status: ${f.validation_status}, phase: ${f.import_phase}`);
    console.log(`    last heartbeat: ${f.import_heartbeat_at} (age ${f.heartbeat_age})`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
