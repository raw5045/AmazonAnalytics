// scripts/buildTopAsinsWeek.ts
/**
 * Re-run the Products page's reverse-table build by hand (spec 2026-10-09 §4.1) — e.g. after the
 * import's own top_asins_build phase logged a failure, or for a re-imported week. Rebuilds
 * keyword_top_asins (each keyword's top-3 clicked ASINs, streaks carried) from the week's kwm
 * partition per lib/topAsins/buildWeek.ts. Re-running the week that is already built is idempotent.
 *
 * Run: TOP_ASINS_WEEK=2026-10-03 node --env-file=.env.local --import tsx scripts/buildTopAsinsWeek.ts
 * Careful: .env.local's DATABASE_URL points at PRODUCTION — this swaps the live keyword_top_asins
 * table (readers never see a half-built week; the build takes a few minutes).
 *
 * Add TOP_ASINS_FORCE=1 to build a week older than the built week (never needed for a normal import).
 * A forced rewind carries nothing: EVERY streak restarts at 1, and the weeks after it must be rebuilt
 * forward, oldest first, to restore them (the newer build it replaces survives only as the _prev table).
 */
import { Pool } from 'pg';
import { buildTopAsinsWeek } from '@/lib/topAsins/buildWeek';

const week = process.env.TOP_ASINS_WEEK;
if (!week || !/^\d{4}-\d{2}-\d{2}$/.test(week)) {
  console.error('Refusing to run: set TOP_ASINS_WEEK=YYYY-MM-DD (the kwm week_end_date to build).');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('Refusing to run: DATABASE_URL is not set (pass --env-file=.env.local).');
  process.exit(1);
}
const force = process.env.TOP_ASINS_FORCE === '1';

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
  if (force) {
    console.warn(
      [
        '',
        `!!! TOP_ASINS_FORCE=1 — if week ${week} is older than the built week, this is a REWIND.`,
        '!!! A forced rewind carries NOTHING from the previous build: every streak restarts at 1.',
        `!!! The weeks after ${week} must then be rebuilt FORWARD, oldest first, to restore them.`,
        '',
      ].join('\n'),
    );
  }
  console.log(`building week ${week} (lock wait + build + analyze may take minutes)`);
  const client = await pool.connect();
  try {
    client.on('error', () => undefined);
    const r = await buildTopAsinsWeek(client, week, { force });
    console.log(
      `built week ${week}: rows=${r.rows} previous=${r.previousWeek ?? 'none'} carried=${r.carriedFrom}${r.analyzeError ? ` analyzeError=${r.analyzeError}` : ''}`,
    );
  } finally {
    client.release();
    await pool.end();
  }
})().catch((e) => {
  console.error(
    'failed:',
    e instanceof Error ? e.name : 'unknown',
    (e as { code?: string })?.code ?? '',
  );
  process.exit(1);
});
