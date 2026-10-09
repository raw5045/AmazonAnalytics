// scripts/buildTopAsinsWeek.ts
/**
 * Re-run the Products page's reverse-table build by hand (spec 2026-10-09 §4.1) — e.g. after the
 * import's own top_asins_build phase logged a failure. Rebuilds keyword_top_asins (each keyword's
 * top-3 clicked ASINs, streaks carried) from the week's kwm partition per
 * lib/topAsins/buildWeek.ts. Re-running the week that is already built is idempotent.
 *
 * Run: TOP_ASINS_WEEK=2026-10-03 node --env-file=.env.local --import tsx scripts/buildTopAsinsWeek.ts
 * Careful: .env.local's DATABASE_URL points at PRODUCTION — this swaps the live keyword_top_asins
 * table (readers never see a half-built week; the build takes a few minutes).
 *
 * Add TOP_ASINS_FORCE=1 to build a week older than the built week (never needed for a normal
 * import; any other TOP_ASINS_FORCE value is refused). A forced rewind carries nothing: EVERY
 * streak restarts at 1 and nothing of the newer build is kept. Readers see that older week until a
 * newer one is built, and streaks that began before it stay short until scripts/backfillTopAsins.ts
 * runs again.
 */
import { Pool } from 'pg';
import { buildTopAsinsWeek, TopAsinsBuildError } from '@/lib/topAsins/buildWeek';

// What a forced rewind does: printed before one runs, and again when an older week is refused.
const rewindWarning = (w: string): string =>
  [
    '',
    `!!! TOP_ASINS_FORCE=1: if week ${w} is older than the built week, this is a REWIND.`,
    '!!! A rewind carries NOTHING: every streak restarts at 1, nothing of the newer build is kept.',
    `!!! Streaks that began before ${w} stay short until scripts/backfillTopAsins.ts runs again.`,
    '',
  ].join('\n');

const week = process.env.TOP_ASINS_WEEK;
if (!week || !/^\d{4}-\d{2}-\d{2}$/.test(week)) {
  console.error('Refusing to run: set TOP_ASINS_WEEK=YYYY-MM-DD (the kwm week_end_date to build).');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('Refusing to run: DATABASE_URL is not set (pass --env-file=.env.local).');
  process.exit(1);
}
// Only the exact value 1 forces; anything else ("0", "true", empty) is refused, not ignored.
if (process.env.TOP_ASINS_FORCE !== undefined && process.env.TOP_ASINS_FORCE !== '1') {
  console.error('Refusing to run: TOP_ASINS_FORCE must be 1 (set TOP_ASINS_FORCE=1 or unset it).');
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
    console.warn(rewindWarning(week));
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
  if (e instanceof TopAsinsBuildError && e.code === 'top_asins_older_than_meta') {
    console.error(rewindWarning(week));
    console.error('TOP_ASINS_FORCE=1 rewinds (read the warning above)');
  }
  process.exit(1);
});
