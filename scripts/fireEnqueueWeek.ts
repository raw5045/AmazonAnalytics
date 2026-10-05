// scripts/fireEnqueueWeek.ts
/**
 * Re-run the Keepa service's enqueue-week hook by hand (spec 2026-10-05 §6.1) — e.g. after the
 * import's own hook logged a failure. Idempotent upsert.
 *
 * Run: FIRE_ENQUEUE_WEEK=2026-10-03 node --env-file=.env.local --import tsx scripts/fireEnqueueWeek.ts
 * Add FIRE_ENQUEUE_FORCE=1 to enqueue a week older than the catalog's scope week (never needed for a normal import).
 */
import { Pool } from 'pg';
import { enqueueWeek } from '@/lib/keepa/enqueueWeek';

const week = process.env.FIRE_ENQUEUE_WEEK;
if (!week || !/^\d{4}-\d{2}-\d{2}$/.test(week)) {
  console.error('Refusing to run: set FIRE_ENQUEUE_WEEK=YYYY-MM-DD (the kwm week_end_date to enqueue).');
  process.exit(1);
}

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, statement_timeout: 1_800_000, keepAlive: true, keepAliveInitialDelayMillis: 10_000, connectionTimeoutMillis: 20_000 });
  // Dropped-socket guards: pg-pool re-emits an idle client's 'error' on the pool but unhooks its listener at checkout, and an unhandled 'error' crashes the script; the failed query still rejects into the catch.
  pool.on('error', () => undefined);
  const client = await pool.connect();
  client.on('error', () => undefined);
  try {
    const r = await enqueueWeek(client, week, { force: process.env.FIRE_ENQUEUE_FORCE === '1' });
    console.log(`enqueued week ${week}: inserted=${r.inserted} updated=${r.updated} retired=${r.retired} vacuumed=${r.vacuumed}${r.vacuumError ? ` vacuumError=${r.vacuumError}` : ''}`);
  } finally {
    client.release();
    await pool.end();
  }
})().catch((e) => {
  console.error('failed:', e instanceof Error ? e.name : 'unknown', (e as { code?: string })?.code ?? '');
  process.exit(1);
});
