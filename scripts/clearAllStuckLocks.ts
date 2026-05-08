/**
 * Clear import_started_at + import_heartbeat_at + import_phase on every
 * file whose lock is currently set. Used when a replay run crashed
 * mid-flight and left files with non-null import_started_at, which
 * blocks them from being re-acquired (until the 60-min orphan window
 * expires).
 *
 * Safe to run while no real imports are in progress. The replay script
 * is single-threaded so this is fine before kicking off a fresh run.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';

async function main() {
  const sql = neon(process.env.DATABASE_URL!);
  const before = (await sql`
    SELECT COUNT(*)::int c FROM uploaded_files WHERE import_started_at IS NOT NULL
  `) as Array<{ c: number }>;
  console.log(`Before: ${before[0].c} files have a lock set`);

  await sql`
    UPDATE uploaded_files
    SET import_started_at = NULL,
        import_heartbeat_at = NULL,
        import_worker_boot_id = NULL,
        import_phase = NULL
    WHERE import_started_at IS NOT NULL
  `;

  const after = (await sql`
    SELECT COUNT(*)::int c FROM uploaded_files WHERE import_started_at IS NOT NULL
  `) as Array<{ c: number }>;
  console.log(`After: ${after[0].c} files have a lock set`);
}
main().catch((e) => { console.error(e); process.exit(1); });
