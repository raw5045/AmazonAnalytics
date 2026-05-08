/**
 * Fast Neon connectivity check. Fails after 10s if compute is unreachable.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';

async function main() {
  const sql = neon(process.env.DATABASE_URL!);
  const t = Date.now();
  try {
    const r = (await Promise.race([
      sql`SELECT 1 AS ok`,
      new Promise((_, rej) => setTimeout(() => rej(new Error('120s timeout')), 120_000)),
    ])) as Array<{ ok: number }>;
    console.log(`✓ Neon reachable in ${Date.now() - t}ms`);
    console.log('  ', r);
  } catch (e) {
    console.log(`✗ Neon unreachable after ${Date.now() - t}ms`);
    console.log('  ', e instanceof Error ? e.message : String(e));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
