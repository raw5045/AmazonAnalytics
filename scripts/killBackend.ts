/**
 * Send pg_terminate_backend to a specific Postgres backend PID.
 * Use to clean up orphaned/long queries that are blocking other work.
 *
 * Usage: pnpm tsx scripts/killBackend.ts <pid>
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';

async function main() {
  const pid = parseInt(process.argv[2], 10);
  if (!Number.isFinite(pid)) {
    console.error('Usage: pnpm tsx scripts/killBackend.ts <pid>');
    process.exit(1);
  }
  const sql = neon(process.env.DATABASE_URL!);
  console.log(`Sending pg_terminate_backend to pid ${pid}...`);
  const result = (await sql`SELECT pg_terminate_backend(${pid}) as ok`) as Array<{ ok: boolean }>;
  console.log(`Result: ${result[0]?.ok}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
