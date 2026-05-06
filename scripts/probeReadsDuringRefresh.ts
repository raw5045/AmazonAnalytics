/**
 * Continuously probe SELECTs against keyword_current_summary while
 * a refresh runs. Reports per-second latency. If the new stage-and-swap
 * pattern works, latency should be flat throughout the refresh, with
 * a single ~10-100 ms blip at the swap moment.
 *
 * (Under the OLD code, latency would block for ~3 min near the end
 * during the TRUNCATE+INSERT lock window.)
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';

async function main() {
  const sql = neon(process.env.DATABASE_URL!);
  console.log('Probing keyword_current_summary every 2s...');
  console.log('Press Ctrl+C to stop\n');
  while (true) {
    const t = Date.now();
    try {
      const r = (await sql`SELECT COUNT(*)::int c FROM keyword_current_summary WHERE current_rank < 1000`) as Array<{ c: number }>;
      const ms = Date.now() - t;
      const flag = ms > 1000 ? '  ⚠️ slow' : '';
      console.log(`${new Date().toISOString().slice(11, 19)}  rows: ${r[0].c.toLocaleString().padStart(6)}  | ${ms.toString().padStart(5)}ms${flag}`);
    } catch (e) {
      const ms = Date.now() - t;
      console.log(`${new Date().toISOString().slice(11, 19)}  ERROR after ${ms}ms: ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
