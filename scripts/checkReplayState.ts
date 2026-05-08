import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

async function main() {
  const sql = neon(process.env.DATABASE_URL!);

  console.log('\n=== Replay state file ===');
  const stateFile = join(process.cwd(), '.replay-state.json');
  if (existsSync(stateFile)) {
    const state = JSON.parse(readFileSync(stateFile, 'utf8'));
    console.log(JSON.stringify(state, null, 2));
  } else {
    console.log('  no state file');
  }

  console.log('\n=== Files with import_started_at SET (lock acquired) ===');
  const stuck = (await sql`
    SELECT id, original_filename, week_end_date::text, import_phase, import_started_at, validation_status
    FROM uploaded_files
    WHERE import_started_at IS NOT NULL
    ORDER BY week_end_date
  `) as Array<Record<string, unknown>>;
  console.log(`  ${stuck.length} files have a lock set`);
  for (const f of stuck) {
    console.log(`    [${f.week_end_date}] ${f.original_filename} phase=${f.import_phase} validation_status=${f.validation_status}`);
  }

  console.log('\n=== Recently-replayed files (imported_at within last 4h) ===');
  const replayed = (await sql`
    SELECT week_end_date::text, original_filename, imported_at
    FROM uploaded_files
    WHERE validation_status = 'imported'
      AND imported_at > NOW() - INTERVAL '4 hours'
    ORDER BY week_end_date
  `) as Array<Record<string, unknown>>;
  console.log(`  ${replayed.length} files`);
  for (const f of replayed) {
    console.log(`    [${f.week_end_date}] ${f.original_filename}`);
  }

  console.log('\n=== Audit log entries from last 4 hours ===');
  const [audit] = (await sql`
    SELECT COUNT(*)::int c, COUNT(DISTINCT uploaded_file_id)::int files
    FROM import_duplicate_search_terms
    WHERE created_at > NOW() - INTERVAL '4 hours'
  `) as Array<{ c: number; files: number }>;
  console.log(`  ${audit.c.toLocaleString()} duplicate-group entries across ${audit.files} files`);
}
main().catch((e) => { console.error(e); process.exit(1); });
