// lib/topAsins/backfill.ts
/**
 * One-time streak backfill for the reverse table (spec 2026-10-09 §4.2): the pure statements and the runner behind
 * scripts/backfillTopAsins.ts. It leaves the state two consecutive builds (lib/topAsins/buildWeek.ts) would leave:
 * keyword_top_asins = the last week, keyword_top_asins_prev = the week before it, the meta row = the last week.
 *
 * The walk. Every week present in keyword_weekly_metrics (weeksSql: a loose index scan, milliseconds), oldest first,
 * goes through the INSERT a build uses (the same slot selects, the same DISTINCT ON carry) into scratch tables,
 * carrying each (keyword, ASIN) pair's streak from the week before it:
 *   keyword_top_asins_bf       the week being built
 *   keyword_top_asins_bf_prev  the previous week walked, with a plain index on (search_term_id, asin) for the carry
 * A week is one transaction (settings, the build advisory lock, the run check, the INSERT) and, except for the last
 * week, a second one that rotates by rename, not by copy: DROP _bf_prev, rename _bf to _bf_prev, index and ANALYZE it
 * (the planner sizes the next carry from real statistics), create a fresh empty _bf. The LAST week is not rotated, so
 * the walk ends with _bf = the last week and _bf_prev = the week before it, which is exactly what the swap-in reads:
 * no third scratch table.
 *
 * A week that inserts no rows is skipped, not fatal, unless it is the last week (the live build refuses to swap zero
 * rows, and the table must end on a real week). It is not rotated, so the next week carries from the previous week
 * walked, exactly as the live build carries across a gap (spec §3.3).
 *
 * One run at a time. Setup, every week, every rotate and the swap-in take the build advisory lock, and setup stamps
 * _bf with a table comment holding this run's token (re-stamped on each fresh _bf). Every insert, every rotate and the
 * swap-in read the stamp back under the lock and throw top_asins_run_conflict when it differs: a second concurrent
 * run, whose setup replaced the scratch tables, stops the older one instead of letting it install the wrong streaks.
 *
 * The swap-in is one transaction and a build's rename swap, so readers are blocked only for its last statements,
 * never for the copy. In order: take the build lock; check the run stamp; refuse to replace a build newer than the
 * last week (an import landed mid-run); rebuild keyword_top_asins_prev from _bf_prev (SELECT *, all eight columns, as
 * a build-made _prev has; only builds read it, and the lock keeps them out); build keyword_top_asins_next
 * (LIKE keyword_top_asins INCLUDING ALL) from _bf; write the meta row; drop the scratch tables; then, under
 * lock_timeout = 120s (set only now, so it bounds the wait for the live table's lock behind in-flight readers, never
 * the copy or the wait behind a running build), swap: DROP the live table and promote _next under the canonical names
 * with the table comment. The live table is locked from its DROP to COMMIT, five statements; a 55P03 rolls the whole
 * swap-in back. ANALYZE follows the COMMIT on its own: a failure there is reported on the result (analyzeError), never
 * thrown, because the swap is done. Every transaction begins READ COMMITTED explicitly, as a build's does (see
 * inTransaction).
 *
 * Failure and restart. The live table is untouched until the swap-in, which is atomic: it commits whole or leaves
 * nothing behind (no _next, no half swap). Any other failure leaves the scratch tables for inspection, and a re-run
 * starts over (setup drops and recreates them), so a run is safe to repeat. Errors are logged by code only (a pg
 * error's code, else its name), never by message, and the original error is rethrown.
 *
 * `client` must be ONE dedicated connection (never a Pool, never inside a transaction). Builds (the import hook,
 * scripts/buildTopAsinsWeek.ts) take the same advisory lock, so one that starts mid-run queues between two
 * transactions of the walk instead of racing.
 */
import { randomBytes } from 'node:crypto';
import { kwmPartitionFor, slotSelect, TOP_ASINS_LOCK_KEY, TopAsinsBuildError, type Queryable, type SqlStatement } from './buildWeek';

const sql = (text: string): SqlStatement => ({ text, values: [] });

// Each transaction sets its own limits (the pool's session settings may not survive a pooler); the values a build uses.
const SET_TIMEOUT = "SET LOCAL statement_timeout = '1800s'";
const SET_WORK_MEM = "SET LOCAL work_mem = '256MB'";
/** Table-lock waits in the swap-in: the live table's DROP waits behind in-flight readers, and new readers queue behind it. */
const SET_LOCK_TIMEOUT = "SET LOCAL lock_timeout = '120s'";
const TAKE_LOCK = 'SELECT pg_advisory_xact_lock($1)';

// Statements a build also runs. They are repeated here so this module does not depend on buildWeek.ts's internals;
// backfill.test.ts pins each against the build's own statements (and records a build run for the ones it keeps
// inline), so neither can drift.
const META_WEEK = 'SELECT week_end_date::text AS week_end_date FROM keyword_top_asins_meta WHERE singleton';
const META_UPSERT = `INSERT INTO keyword_top_asins_meta (singleton, week_end_date, built_at, row_count) VALUES (true, $1::date, now(), $2::bigint)
             ON CONFLICT (singleton) DO UPDATE SET week_end_date = EXCLUDED.week_end_date, built_at = EXCLUDED.built_at, row_count = EXCLUDED.row_count`;
/** LIKE ... INCLUDING ALL copies no table comment, so the swap sets them (the first is migration 0051's text). */
const CURRENT_COMMENT = "COMMENT ON TABLE keyword_top_asins IS 'Current week''s top-3 clicked ASINs per keyword with consecutive-week streaks. Rebuilt per import (lib/topAsins/buildWeek.ts); backfilled once by scripts/backfillTopAsins.ts.'";
const PREV_COMMENT = "COMMENT ON TABLE keyword_top_asins_prev IS 'Previous build of keyword_top_asins: the streak carry source for a same-week rebuild.'";

/**
 * Every distinct week of keyword_weekly_metrics, ISO text, oldest first (one row per week, column `week`). A loose
 * index scan on the parent table (its primary key leads with week_end_date): one min() probe per week, milliseconds,
 * instead of a DISTINCT over every row of every partition. The partition of each week comes from kwmPartitionFor.
 */
export function weeksSql(): string {
  return `WITH RECURSIVE w AS (
  SELECT min(week_end_date) AS d FROM keyword_weekly_metrics
  UNION ALL
  SELECT (SELECT min(week_end_date) FROM keyword_weekly_metrics WHERE week_end_date > w.d) FROM w WHERE w.d IS NOT NULL
)
SELECT d::text AS week FROM w WHERE d IS NOT NULL ORDER BY d`;
}

/** Refuses a week list the walk cannot trust: empty, malformed, or not strictly ascending. */
export function assertBackfillWeeks(weeks: readonly string[]): void {
  if (weeks.length === 0) throw new TopAsinsBuildError('top_asins_no_rows', 'keyword_weekly_metrics holds no weeks to backfill');
  weeks.forEach((week, i) => {
    kwmPartitionFor(week); // throws top_asins_bad_date on a malformed week
    if (i > 0 && week <= weeks[i - 1]) {
      throw new TopAsinsBuildError('top_asins_bad_date', `weeks must be strictly ascending (${weeks[i - 1]} then ${week})`);
    }
  });
}

// ---- the run token: which run owns the scratch tables ----

const TOKEN_RE = /^[0-9A-Za-z:.-]{8,64}$/;

/** An ISO timestamp and a random suffix: unique per run, and safe to put in a SQL literal. */
export function newRunToken(): string {
  return `${new Date().toISOString()}-${randomBytes(4).toString('hex')}`;
}

/** The comment a run keeps on keyword_top_asins_bf. The token goes into a literal (COMMENT takes no parameters), so it is checked. */
export function stampText(token: string): string {
  if (!TOKEN_RE.test(token)) throw new TypeError('a backfill run token is 8-64 characters of [0-9A-Za-z:.-]');
  return `backfill run ${token}`;
}
export function stampSql(token: string): SqlStatement {
  return sql(`COMMENT ON TABLE keyword_top_asins_bf IS '${stampText(token)}'`);
}
/** NULL when _bf is missing or unstamped, so a dropped table reads as a conflict, not as an error of its own. */
export function stampReadSql(): SqlStatement {
  return sql("SELECT obj_description(to_regclass('keyword_top_asins_bf'), 'pg_class') AS stamp");
}

// ---- the walk ----

const CREATE_BF = 'CREATE TABLE keyword_top_asins_bf (LIKE keyword_top_asins INCLUDING DEFAULTS)';
const CARRY_INDEX = 'CREATE INDEX keyword_top_asins_bf_prev_pair_idx ON keyword_top_asins_bf_prev (search_term_id, asin)';

/**
 * Drop and recreate the two scratch tables: the live table's columns and defaults, no primary key and no CHECKs (a
 * week's rows are unique by construction, and the swap-in's copy runs through the real constraints), the carry index
 * on _bf_prev, and the run's stamp on _bf.
 */
export function backfillSetupStatements(token: string): SqlStatement[] {
  return [
    sql('DROP TABLE IF EXISTS keyword_top_asins_bf'),
    sql('DROP TABLE IF EXISTS keyword_top_asins_bf_prev'),
    sql(CREATE_BF),
    sql('CREATE TABLE keyword_top_asins_bf_prev (LIKE keyword_top_asins INCLUDING DEFAULTS)'),
    sql(CARRY_INDEX),
    stampSql(token),
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
 * Between two weeks, by rename (no copy of ~8M rows): the old carry source is dropped (its index with it), the week
 * just built becomes the carry source, gets the carry index (a bulk build) and fresh statistics (a never-analyzed
 * table is estimated from defaults, and the carry's join order depends on its size), and a fresh empty _bf is
 * created and stamped again (the renamed table takes its comment, the stamp, along).
 */
export function rotateStatements(token: string): SqlStatement[] {
  return [
    sql('DROP TABLE IF EXISTS keyword_top_asins_bf_prev'),
    sql('ALTER TABLE keyword_top_asins_bf RENAME TO keyword_top_asins_bf_prev'),
    sql(CARRY_INDEX),
    sql('ANALYZE keyword_top_asins_bf_prev'),
    sql(CREATE_BF),
    stampSql(token),
  ];
}

export interface BackfillFinalizeStatements {
  /** The meta row's week, read under the lock: the swap-in refuses to replace a newer build. */
  metaWeek: SqlStatement;
  /** keyword_top_asins_prev, rebuilt from the previous week walked (_bf_prev), all eight columns as a build-made _prev has. */
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
      sql('CREATE TABLE keyword_top_asins_prev AS SELECT * FROM keyword_top_asins_bf_prev'),
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
  /** Weeks listed (the span of the walk), skipped ones included. */
  weeks: number;
  lastWeek: string;
  /** Rows now in keyword_top_asins (the last week's). */
  rows: number;
  /** Only when a mid-walk week had no top-3 rows and was skipped: those weeks, oldest first. */
  skipped?: string[];
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
 * the wait, and the stamp and meta reads after it would see stale rows.
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

/** Under the lock: the scratch tables must still be this run's (a later run's setup replaces them). */
async function assertOwnRun(client: Queryable, token: string): Promise<void> {
  const res = await client.query(stampReadSql().text);
  const stamp = (res.rows[0] as { stamp: string | null } | undefined)?.stamp ?? null;
  if (stamp !== stampText(token)) {
    throw new TopAsinsBuildError('top_asins_run_conflict', 'the scratch tables are not this run\'s: another backfill run replaced them');
  }
}

export async function runBackfill(client: Queryable, opts: BackfillOptions = {}): Promise<BackfillResult> {
  if ('totalCount' in client) throw new TopAsinsBuildError('top_asins_bad_client', 'runBackfill needs one dedicated connection, not a Pool');
  const log = opts.log ?? (() => undefined);
  const token = newRunToken();
  let stage: Stage = 'weeks';
  let at = ''; // " week=<w> (<i>/<n>)" while a week is in flight
  try {
    log('listing weeks...');
    const found = await client.query(weeksSql());
    const weeks = (found.rows as { week: string }[]).map((r) => r.week);
    assertBackfillWeeks(weeks); // before anything is created
    const n = weeks.length;
    const lastWeek = weeks[n - 1];
    log(`backfill: ${n} weeks, ${weeks[0]} .. ${lastWeek}`);

    stage = 'setup';
    await inTransaction(client, async () => {
      await client.query(SET_TIMEOUT);
      await client.query(TAKE_LOCK, [TOP_ASINS_LOCK_KEY]); // a running build finishes first; a run in flight finishes its transaction
      for (const st of backfillSetupStatements(token)) await client.query(st.text);
    });

    let carried: string | null = null; // the week _bf_prev holds: the previous week walked
    const skipped: string[] = [];
    for (let i = 0; i < n; i += 1) {
      const week = weeks[i];
      const isLast = i === n - 1;
      const started = Date.now();
      at = ` week=${week} (${i + 1}/${n})`;
      stage = 'insert';
      const { insert } = backfillWeekStatements(week);
      let rows: number;
      try {
        rows = await inTransaction(client, async () => {
          await client.query(SET_TIMEOUT);
          await client.query(SET_WORK_MEM);
          await client.query(TAKE_LOCK, [TOP_ASINS_LOCK_KEY]); // builds queue here instead of racing the heavy statement
          await assertOwnRun(client, token);
          const res = await client.query(insert.text, insert.values);
          const inserted = res.rowCount ?? 0;
          if (inserted === 0) throw new TopAsinsBuildError('top_asins_no_rows', `week ${week} produced no top-3 rows (not imported?)`);
          return inserted;
        });
      } catch (e) {
        if (!isLast && e instanceof TopAsinsBuildError && e.code === 'top_asins_no_rows') {
          // Not rotated: _bf is still empty and _bf_prev still holds the previous week walked, which the next week carries from.
          skipped.push(week);
          log(`week ${week}: no top-3 rows, skipped (streaks carry across it)`);
          continue;
        }
        throw e;
      }
      if (!isLast) {
        // The last week stays in _bf and the week before it in _bf_prev: the swap-in reads both.
        stage = 'rotate';
        await inTransaction(client, async () => {
          await client.query(SET_TIMEOUT);
          await client.query(TAKE_LOCK, [TOP_ASINS_LOCK_KEY]);
          await assertOwnRun(client, token);
          for (const st of rotateStatements(token)) await client.query(st.text);
        });
        carried = week;
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
      await assertOwnRun(client, token);
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
    log(`finalized: keyword_top_asins = week ${lastWeek} (${rows} rows), keyword_top_asins_prev = ${carried ? `week ${carried}` : 'empty (no earlier week walked)'} in ${seconds(started)}s`);

    let analyzeError: string | undefined;
    try {
      await client.query(f.analyze.text);
    } catch (e) {
      // Best-effort: the swap is committed; autovacuum's analyze covers a miss.
      analyzeError = errorCode(e);
      log(`analyze failed after COMMIT (the replacement is committed; autovacuum covers it): code=${analyzeError}`);
    }
    return { weeks: n, lastWeek, rows, ...(skipped.length ? { skipped } : {}), ...(analyzeError ? { analyzeError } : {}) };
  } catch (e) {
    const kept = stage === 'insert' || stage === 'rotate' || stage === 'finalize' ? '; scratch tables kept (a re-run starts over)' : '';
    log(`backfill failed: stage=${stage}${at} code=${errorCode(e)}${kept}`);
    throw e;
  }
}
