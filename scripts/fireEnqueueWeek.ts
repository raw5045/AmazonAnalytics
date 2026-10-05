// scripts/fireEnqueueWeek.ts
/**
 * Re-run the Keepa service's enqueue-week hook by hand (spec 2026-10-05 §6.1) — e.g. after the
 * import's own hook logged a failure. Idempotent upsert.
 *
 * Run: FIRE_ENQUEUE_WEEK=2026-10-03 node --env-file=.env.local --import tsx scripts/fireEnqueueWeek.ts
 * Careful: .env.local's DATABASE_URL points at PRODUCTION — this rewrites the live catalog the Keepa
 * service works from.
 *
 * Add FIRE_ENQUEUE_FORCE=1 to enqueue a week older than the catalog's scope week (never needed for a normal import).
 * A forced run rewinds the live scope to that week: ASINs only in the newer week leave scope (flagged out,
 * not deleted) until the newer week is enqueued again.
 */
import { Pool } from 'pg';
import { enqueueWeek } from '@/lib/keepa/enqueueWeek';

const week = process.env.FIRE_ENQUEUE_WEEK;
if (!week || !/^\d{4}-\d{2}-\d{2}$/.test(week)) {
  console.error('Refusing to run: set FIRE_ENQUEUE_WEEK=YYYY-MM-DD (the kwm week_end_date to enqueue).');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('Refusing to run: DATABASE_URL is not set (pass --env-file=.env.local).');
  process.exit(1);
}

(async () => {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    statement_timeout: 1_800_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    connectionTimeoutMillis: 20_000,
  });
  // Dropped-socket guards: pg-pool re-emits an idle client's 'error' on the
  // pool but unhooks its listener at checkout, and an unhandled 'error'
  // crashes the script; the failed query still rejects into the catch.
  pool.on('error', () => undefined);
  console.log(`enqueueing week ${week} (lock wait + upsert + vacuum may take minutes)`);
  const client = await pool.connect();
  try {
    client.on('error', () => undefined);
    const r = await enqueueWeek(client, week, { force: process.env.FIRE_ENQUEUE_FORCE === '1' });
    console.log(
      `enqueued week ${week}: inserted=${r.inserted} updated=${r.updated} retired=${r.retired} vacuumed=${r.vacuumed}${r.vacuumError ? ` vacuumError=${r.vacuumError}` : ''}`,
    );
  } finally {
    client.release();
    await pool.end();
  }
})().catch((e) => {
  console.error('failed:', e instanceof Error ? e.name : 'unknown', (e as { code?: string })?.code ?? '');
  process.exit(1);
});
