/**
 * Clear a file's import lock fields so a fresh import attempt can
 * acquire the lock without waiting for the 60-min orphan window.
 *
 * Use after a failed import attempt that left the lock state set
 * (e.g., crashed before reaching stopHeartbeat).
 *
 * Usage: pnpm tsx scripts/resetFileLock.ts <week-end-date>
 *   pnpm tsx scripts/resetFileLock.ts 2026-05-02
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';

async function main() {
  const week = process.argv[2];
  if (!week) {
    console.error('Usage: pnpm tsx scripts/resetFileLock.ts <YYYY-MM-DD>');
    process.exit(1);
  }
  const sql = neon(process.env.DATABASE_URL!);
  const before = (await sql`
    SELECT id, original_filename, import_phase, import_started_at, import_heartbeat_at
    FROM uploaded_files
    WHERE week_end_date = ${week}::date
    ORDER BY created_at DESC
  `) as Array<Record<string, unknown>>;
  console.log('Before:', before);

  await sql`
    UPDATE uploaded_files
    SET import_started_at = NULL,
        import_heartbeat_at = NULL,
        import_worker_boot_id = NULL,
        import_phase = NULL
    WHERE week_end_date = ${week}::date
  `;

  const after = (await sql`
    SELECT id, original_filename, import_phase, import_started_at, import_heartbeat_at
    FROM uploaded_files
    WHERE week_end_date = ${week}::date
    ORDER BY created_at DESC
  `) as Array<Record<string, unknown>>;
  console.log('After:', after);
}
main().catch((e) => { console.error(e); process.exit(1); });
