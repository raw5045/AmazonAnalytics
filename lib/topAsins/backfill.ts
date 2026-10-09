// lib/topAsins/backfill.ts
/**
 * One-time streak backfill for the reverse table (spec 2026-10-09 §4.2): the pure statements and the runner behind
 * scripts/backfillTopAsins.ts. It leaves the state two consecutive builds (lib/topAsins/buildWeek.ts) would leave:
 * keyword_top_asins = the last week, keyword_top_asins_prev = the week before it, the meta row = the last week.
 *
 * The walk. Every week present in keyword_weekly_metrics (KWM_PARTITIONS), oldest first, goes through the INSERT a
 * build uses (the same slot selects, the same DISTINCT ON carry) into scratch tables, carrying each (keyword, ASIN)
 * pair's streak from the week before it:
 *   keyword_top_asins_bf       the week being built
 *   keyword_top_asins_bf_prev  the week before it, with a plain index on (search_term_id, asin) for the carry
 * A week is one transaction (settings, the build advisory lock, the INSERT) and, except for the last week, a second
 * one that rotates: _bf is copied into _bf_prev (then ANALYZEd, so the next carry plans from real statistics) and
 * emptied. The LAST week is not rotated, so the walk ends with _bf = the last week and _bf_prev = the week before
 * it, which is exactly what the swap-in reads: no third scratch table and no extra copy.
 *
 * The swap-in is one transaction and a build's rename swap, so readers are blocked only for its last statements,
 * never for the copy. In order: take the build lock; refuse to replace a build newer than the last week (an import
 * landed mid-run); rebuild keyword_top_asins_prev from _bf_prev (only builds read it, and the lock keeps them out);
 * build keyword_top_asins_next (LIKE keyword_top_asins INCLUDING ALL) from _bf; write the meta row; drop the scratch
 * tables; then, under lock_timeout = 120s (set only now, so it bounds the wait for the live table's lock behind
 * in-flight readers, never the copy or the wait behind a running build), swap: DROP the live table and promote _next
 * under the canonical names with the table comment. The live table is locked from its DROP to COMMIT, five
 * statements; a 55P03 rolls the whole swap-in back. ANALYZE follows the COMMIT on its own: a failure there is
 * reported on the result (analyzeError), never thrown, because the swap is done. Every transaction begins READ
 * COMMITTED explicitly, as a build's does (see inTransaction).
 *
 * Failure and restart. The live table is untouched until the swap-in, which is atomic: it commits whole or leaves
 * nothing behind (no _next, no half swap). Any other failure leaves the scratch tables for inspection, and a re-run
 * starts over (setup drops and recreates them), so a run is safe to repeat. Errors are logged by code only (a pg
 * error's code, else its name), never by message, and the original error is rethrown.
 *
 * `client` must be ONE dedicated connection (never a Pool, never inside a transaction). Builds (the import hook,
 * scripts/buildTopAsinsWeek.ts) take the same advisory lock, so one that starts mid-run queues between two weeks
 * instead of racing.
 */
import { kwmPartitionFor, slotSelect, TOP_ASINS_LOCK_KEY, TopAsinsBuildError, type Queryable, type SqlStatement } from './buildWeek';

/**
 * The kwm year partitions the backfill reads (data starts 2025-04-19, so 2024 holds none). A partition not listed here
 * is never read: add 'keyword_weekly_metrics_2027' when a 2027 week exists. The swap-in refuses to replace a live build
 * newer than the last week walked, which catches a run that forgot to.
 */
export const KWM_PARTITIONS: readonly string[] = ['keyword_weekly_metrics_2025', 'keyword_weekly_metrics_2026'];

const sql = (text: string): SqlStatement => ({ text, values: [] });

// Each transaction sets its own limits (the pool's session settings may not survive a pooler); the values a build uses.
const SET_TIMEOUT = "SET LOCAL statement_timeout = '1800s'";
const SET_WORK_MEM = "SET LOCAL work_mem = '256MB'";
/** Table-lock waits in the swap-in: the live table's DROP waits behind in-flight readers, and new readers queue behind it. */
const SET_LOCK_TIMEOUT = "SET LOCAL lock_timeout = '120s'";
const TAKE_LOCK = 'SELECT pg_advisory_xact_lock($1)';

// Statements a build also runs. They are repeated here so this module does not depend on buildWeek.ts's internals;
// backfill.test.ts pins each against the build's own statements, so neither can drift.
const META_WEEK = 'SELECT week_end_date::text AS week_end_date FROM keyword_top_asins_meta WHERE singleton';
const META_UPSERT = `INSERT INTO keyword_top_asins_meta (singleton, week_end_date, built_at, row_count) VALUES (true, $1::date, now(), $2::bigint)
             ON CONFLICT (singleton) DO UPDATE SET week_end_date = EXCLUDED.week_end_date, built_at = EXCLUDED.built_at, row_count = EXCLUDED.row_count`;
/** LIKE ... INCLUDING ALL copies no table comment, so the swap sets them (the first is migration 0051's text). */
const CURRENT_COMMENT = "COMMENT ON TABLE keyword_top_asins IS 'Current week''s top-3 clicked ASINs per keyword with consecutive-week streaks. Rebuilt per import (lib/topAsins/buildWeek.ts); backfilled once by scripts/backfillTopAsins.ts.'";
const PREV_COMMENT = "COMMENT ON TABLE keyword_top_asins_prev IS 'Previous build of keyword_top_asins: the streak carry source for a same-week rebuild.'";

/**
 * The distinct weeks of the listed partitions, ISO text, oldest first (one row per week, column `week`). DISTINCT runs on
 * the date column inside, so the text cast is applied to the handful of results instead of every row of the scan.
 */
export function weeksSql(): string {
  const branches = KWM_PARTITIONS.map((p) => `SELECT DISTINCT week_end_date FROM ${p}`).join('\n  UNION\n  ');
  return `SELECT week_end_date::text AS week
FROM (
  ${branches}
) w
ORDER BY 1`;
}

/** Refuses a week list the walk cannot trust: empty, malformed, outside the listed partitions, or not strictly ascending. */
export function assertBackfillWeeks(weeks: readonly string[]): void {
  if (weeks.length === 0) throw new TopAsinsBuildError('top_asins_no_rows', 'keyword_weekly_metrics holds no weeks to backfill');
  weeks.forEach((week, i) => {
    const partition = kwmPartitionFor(week); // throws top_asins_bad_date on a malformed week
    if (!KWM_PARTITIONS.includes(partition)) {
      throw new TopAsinsBuildError('top_asins_bad_date', `week ${week} lives in ${partition}, which the backfill does not read`);
    }
    if (i > 0 && week <= weeks[i - 1]) {
      throw new TopAsinsBuildError('top_asins_bad_date', `weeks must be strictly ascending (${weeks[i - 1]} then ${week})`);
    }
  });
}

/**
 * Drop and recreate the two scratch tables: the live table's columns and defaults, no primary key and no CHECKs (a
 * week's rows are unique by construction, and the swap-in's copy runs through the real constraints), plus the carry index.
 */
export function backfillSetupStatements(): SqlStatement[] {
  return [
    sql('DROP TABLE IF EXISTS keyword_top_asins_bf'),
    sql('DROP TABLE IF EXISTS keyword_top_asins_bf_prev'),
    sql('CREATE TABLE keyword_top_asins_bf (LIKE keyword_top_asins INCLUDING DEFAULTS)'),
    sql('CREATE TABLE keyword_top_asins_bf_prev (LIKE keyword_top_asins INCLUDING DEFAULTS)'),
    sql('CREATE INDEX keyword_top_asins_bf_prev_pair_idx ON keyword_top_asins_bf_prev (search_term_id, asin)'),
  ];
}

export interface BackfillWeekStatements { insert: SqlStatement }

/**
 * One week's INSERT: the build's (buildWeek.ts insertText) with the target and the carry source swapped for the
 * scratch pair. A plain LEFT JOIN against a de-duplicated copy of the pairs (DISTINCT ON, the higher streak wins)
 * the planner can hash; the first week joins an empty table, so every pair starts at 1.
 */
export function backfillWeekStatements(week: string): BackfillWeekStatements {
  const partition = kwmPartitionFor(week);
  const slots = `(${slotSelect(partition, 1)} UNION ALL ${slotSelect(partition, 2)} UNION ALL ${slotSelect(partition, 3)}) p`;
  return {
    insert: {
      text: `INSERT INTO keyword_top_asins_bf (search_term_id, asin, slot, click_share, conversion_share, weeks_in_top3, streak_started_week, week_end_date)
             SELECT p.search_term_id, p.asin, p.slot, p.click_share, p.conversion_share,
                    COALESCE(prev.weeks_in_top3, 0) + 1,
                    COALESCE(prev.streak_started_week, $1::date),
                    $1::date
             FROM ${slots}
             LEFT JOIN (
               SELECT DISTINCT ON (search_term_id, asin) search_term_id, asin, weeks_in_top3, streak_started_week
               FROM keyword_top_asins_bf_prev
               ORDER BY search_term_id, asin, weeks_in_top3 DESC
             ) prev ON prev.search_term_id = p.search_term_id AND prev.asin = p.asin`,
      values: [week],
    },
  };
}

/**
 * Between two weeks: the week just built becomes the carry source and the build table is emptied. The ANALYZE gives the
 * planner real statistics on the fresh copy (a never-analyzed table is estimated from defaults, and the carry's join
 * order depends on its size).
 */
export function rotateStatements(): SqlStatement[] {
  return [
    sql('TRUNCATE keyword_top_asins_bf_prev'),
    sql('INSERT INTO keyword_top_asins_bf_prev SELECT * FROM keyword_top_asins_bf'),
    sql('ANALYZE keyword_top_asins_bf_prev'),
    sql('TRUNCATE keyword_top_asins_bf'),
  ];
}

export interface BackfillFinalizeStatements {
  /** The meta row's week, read under the lock: the swap-in refuses to replace a newer build. */
  metaWeek: SqlStatement;
  /** keyword_top_asins_prev, rebuilt from the week before the last (_bf_prev): the four columns a same-week rebuild carries. */
  prev: SqlStatement[];
  /** The replacement, built beside the live table exactly as a build builds _next. */
  createNext: SqlStatement;
  /** Fills it from the LAST week (_bf); its row count is the meta row count. */
  fillNext: SqlStatement;
  /** The build's meta upsert for the last week and `rows` rows. */
  meta: (rows: number) => SqlStatement;
  /** The scratch tables, dropped before the swap so the live table's exclusive lock covers the swap alone. */
  cleanup: SqlStatement[];
  /** The build's same-week rename swap: the live table is locked from its DROP to COMMIT. */
  swap: SqlStatement[];
  /** After COMMIT, on its own. */
  analyze: SqlStatement;
}

export function finalizeStatements(lastWeek: string): BackfillFinalizeStatements {
  kwmPartitionFor(lastWeek); // rejects a malformed week
  return {
    metaWeek: sql(META_WEEK),
    prev: [
      sql('DROP TABLE IF EXISTS keyword_top_asins_prev'),
      sql('CREATE TABLE keyword_top_asins_prev AS SELECT search_term_id, asin, weeks_in_top3, streak_started_week FROM keyword_top_asins_bf_prev'),
      sql(PREV_COMMENT),
    ],
    createNext: sql('CREATE TABLE keyword_top_asins_next (LIKE keyword_top_asins INCLUDING ALL)'),
    fillNext: sql('INSERT INTO keyword_top_asins_next SELECT * FROM keyword_top_asins_bf'),
    meta: (rows) => ({ text: META_UPSERT, values: [lastWeek, rows] }),
    cleanup: [sql('DROP TABLE keyword_top_asins_bf'), sql('DROP TABLE keyword_top_asins_bf_prev')],
    swap: [
      sql('DROP TABLE keyword_top_asins'),
      sql('ALTER TABLE keyword_top_asins_next RENAME TO keyword_top_asins'),
      sql(CURRENT_COMMENT),
      sql('ALTER INDEX keyword_top_asins_next_asin_search_term_id_idx RENAME TO keyword_top_asins_asin_idx'),
      sql('ALTER TABLE keyword_top_asins RENAME CONSTRAINT keyword_top_asins_next_pkey TO keyword_top_asins_pkey'),
    ],
    analyze: sql('ANALYZE keyword_top_asins'),
  };
}

export interface BackfillOptions {
  /** One line per event (progress, failures, the result). Omitted: silent. Never carries a database error's message. */
  log?: (line: string) => void;
}
export interface BackfillResult {
  /** Weeks walked. */
  weeks: number;
  lastWeek: string;
  /** Rows now in keyword_top_asins (the last week's). */
  rows: number;
  /** Only when the ANALYZE after COMMIT threw: its pg code, else the error name ('unknown' if not an Error). */
  analyzeError?: string;
}

type Stage = 'weeks' | 'setup' | 'insert' | 'rotate' | 'finalize';

/** A pg error's code, else the error's name; never its message (log-safe). */
function errorCode(e: unknown): string {
  return typeof (e as { code?: unknown } | null | undefined)?.code === 'string' ? (e as { code: string }).code : e instanceof Error ? e.name : 'unknown';
}

const seconds = (since: number) => ((Date.now() - since) / 1000).toFixed(1);

/**
 * BEGIN ... COMMIT around `work`; on any failure a best-effort ROLLBACK, then the original error is rethrown. The
 * isolation level is explicit, as in a build: under REPEATABLE READ the lock's SELECT would take the snapshot before
 * the wait, and the swap-in's meta read after it would see a stale row.
 */
async function inTransaction<T>(client: Queryable, work: () => Promise<T>): Promise<T> {
  await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
  try {
    const out = await work();
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  }
}

export async function runBackfill(client: Queryable, opts: BackfillOptions = {}): Promise<BackfillResult> {
  if ('totalCount' in client) throw new TopAsinsBuildError('top_asins_bad_client', 'runBackfill needs one dedicated connection, not a Pool');
  const log = opts.log ?? (() => undefined);
  let stage: Stage = 'weeks';
  let at = ''; // " week=<w> (<i>/<n>)" while a week is in flight
  try {
    const found = await client.query(weeksSql());
    const weeks = (found.rows as { week: string }[]).map((r) => r.week);
    assertBackfillWeeks(weeks); // before anything is created
    const n = weeks.length;
    const lastWeek = weeks[n - 1];
    log(`backfill: ${n} weeks, ${weeks[0]} .. ${lastWeek}`);

    stage = 'setup';
    await inTransaction(client, async () => {
      for (const st of backfillSetupStatements()) await client.query(st.text);
    });

    for (let i = 0; i < n; i += 1) {
      const week = weeks[i];
      const started = Date.now();
      at = ` week=${week} (${i + 1}/${n})`;
      stage = 'insert';
      const { insert } = backfillWeekStatements(week);
      const rows = await inTransaction(client, async () => {
        await client.query(SET_TIMEOUT);
        await client.query(SET_WORK_MEM);
        await client.query(TAKE_LOCK, [TOP_ASINS_LOCK_KEY]); // builds queue here instead of racing the heavy statement
        const res = await client.query(insert.text, insert.values);
        const inserted = res.rowCount ?? 0;
        if (inserted === 0) throw new TopAsinsBuildError('top_asins_no_rows', `week ${week} produced no top-3 rows (not imported?)`);
        return inserted;
      });
      if (i < n - 1) {
        // The last week stays in _bf and the week before it in _bf_prev: the swap-in reads both.
        stage = 'rotate';
        await inTransaction(client, async () => {
          await client.query(SET_TIMEOUT);
          for (const st of rotateStatements()) await client.query(st.text);
        });
      }
      log(`week ${week} (${i + 1}/${n}): rows=${rows} in ${seconds(started)}s`);
    }

    stage = 'finalize';
    at = '';
    log(`finalizing: building keyword_top_asins_next from week ${lastWeek}, then swapping it in (a few minutes)`);
    const started = Date.now();
    const f = finalizeStatements(lastWeek);
    const rows = await inTransaction(client, async () => {
      await client.query(SET_TIMEOUT);
      await client.query(TAKE_LOCK, [TOP_ASINS_LOCK_KEY]); // a running build finishes first; the wait is bounded by the statement timeout
      const metaRow = await client.query(f.metaWeek.text);
      const builtWeek = (metaRow.rows[0] as { week_end_date: string | null } | undefined)?.week_end_date ?? null;
      if (builtWeek && builtWeek > lastWeek) {
        throw new TopAsinsBuildError('top_asins_older_than_meta', `the last week walked, ${lastWeek}, is older than the built week ${builtWeek}`);
      }
      for (const st of f.prev) await client.query(st.text);
      await client.query(f.createNext.text);
      const filled = await client.query(f.fillNext.text);
      const copied = filled.rowCount ?? 0;
      if (copied === 0) throw new TopAsinsBuildError('top_asins_no_rows', `week ${lastWeek} left no rows to swap in`);
      const upsert = f.meta(copied);
      await client.query(upsert.text, upsert.values);
      for (const st of f.cleanup) await client.query(st.text);
      // Only now: lock_timeout bounds the wait for the live table's lock (readers in flight), not the copy or the advisory-lock wait.
      await client.query(SET_LOCK_TIMEOUT);
      for (const st of f.swap) await client.query(st.text); // the live table is locked from here to COMMIT
      return copied;
    });
    log(`finalized: keyword_top_asins = week ${lastWeek} (${rows} rows), keyword_top_asins_prev = ${n > 1 ? `week ${weeks[n - 2]}` : 'empty (one week only)'} in ${seconds(started)}s`);

    let analyzeError: string | undefined;
    try {
      await client.query(f.analyze.text);
    } catch (e) {
      // Best-effort: the swap is committed; autovacuum's analyze covers a miss.
      analyzeError = errorCode(e);
      log(`analyze failed after COMMIT (the replacement is committed; autovacuum covers it): code=${analyzeError}`);
    }
    return { weeks: n, lastWeek, rows, ...(analyzeError ? { analyzeError } : {}) };
  } catch (e) {
    const kept = stage === 'insert' || stage === 'rotate' || stage === 'finalize' ? '; scratch tables kept (a re-run starts over)' : '';
    log(`backfill failed: stage=${stage}${at} code=${errorCode(e)}${kept}`);
    throw e;
  }
}
