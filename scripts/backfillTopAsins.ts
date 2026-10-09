// scripts/backfillTopAsins.ts
/**
 * One-time streak backfill for the Products reverse table (spec 2026-10-09 §4.2). Walks every week present in
 * keyword_weekly_metrics (77 weeks, 2025-04-19 to 2026-10-03 as of 2026-10-09) oldest first, carrying each
 * (keyword, ASIN) pair's streak from week to week in two scratch tables, then replaces keyword_top_asins with the
 * last week and leaves the week before it as keyword_top_asins_prev: the state two consecutive builds leave behind.
 * The scheme and every statement live in lib/topAsins/backfill.ts.
 *
 * Run (the owner's go only): BACKFILL_TOP_ASINS=yes node --env-file=.env.local --import tsx scripts/backfillTopAsins.ts
 * Careful: .env.local's DATABASE_URL points at PRODUCTION.
 *  - Quiet hour, and no import running: node --env-file=.env.local --import tsx scripts/checkActiveJobs.ts first.
 *    An import's top_asins_build phase and every transaction below take the same advisory lock, so a build that starts
 *    mid-run waits for the transaction in flight instead of racing. The last step refuses to replace a build NEWER than
 *    the last week it walked (top_asins_older_than_meta): a run an import overtook is simply repeated.
 *  - 77 weeks take roughly 2-3 hours, with one progress line per week. A week in the middle of the walk with no top-3
 *    rows is skipped with a log line, and its neighbours' streaks carry across it (as the live build carries across a
 *    gap); an empty LAST week stops the run (top_asins_no_rows).
 *  - Readers of the reverse table (the ASIN page's keyword list) keep working throughout. Nothing live is touched
 *    until the last step, and that step builds the replacement beside the live table and swaps it in by rename in ONE
 *    transaction, exactly as a build does: readers never see a partial table, and during the final swap they can queue
 *    for up to 120 s behind it (lock_timeout; if it fires the swap-in rolls back and the run fails with code 55P03).
 *  - One run at a time. Each run stamps its scratch tables, so starting a second run stops the first one with
 *    top_asins_run_conflict instead of letting both write.
 *  - Idempotent. A failed or interrupted run leaves its scratch tables (keyword_top_asins_bf, keyword_top_asins_bf_prev)
 *    for inspection; the next run drops and recreates them and starts over from the first week. The live table is
 *    untouched by a failure, so nothing needs cleaning up by hand. A completed run drops the scratch tables itself.
 *  - Run it before the push that ships the build phase, so the next import finds a previous build. If an import
 *    lands first, its week-1 streaks are replaced when this backfill runs afterwards.
 * A failure prints the error's name and pg code only, never its message.
 */
import { Pool } from 'pg';
import { runBackfill } from '@/lib/topAsins/backfill';

if (process.env.BACKFILL_TOP_ASINS !== 'yes') {
  console.error('Refusing to run: set BACKFILL_TOP_ASINS=yes (the owner\'s go; read the header of this file first).');
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
  // Dropped-socket guards: pg-pool re-emits an idle client's 'error' on the pool but unhooks its listener at
  // checkout, and an unhandled 'error' crashes the script; the failed query still rejects into the catch below.
  pool.on('error', () => undefined);
  const client = await pool.connect();
  try {
    client.on('error', () => undefined);
    const r = await runBackfill(client, { log: (line) => console.log(line) });
    const skipped = r.skipped ? `; skipped ${r.skipped.length} empty week${r.skipped.length === 1 ? '' : 's'} (${r.skipped.join(', ')})` : '';
    const analyze = r.analyzeError ? `; ANALYZE failed (${r.analyzeError}), autovacuum covers it` : '';
    console.log(`backfilled ${r.weeks} weeks: keyword_top_asins = week ${r.lastWeek} (${r.rows} rows)${skipped}${analyze}`);
  } finally {
    client.release();
    await pool.end();
  }
})().catch((e) => {
  console.error('failed:', e instanceof Error ? e.name : 'unknown', (e as { code?: string })?.code ?? '');
  process.exit(1);
});
