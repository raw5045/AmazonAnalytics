// lib/topAsins/buildWeek.ts
/**
 * Build one week's keyword→ASIN reverse table (spec 2026-10-09 §3.2–§4.1).
 *
 * One INSERT from the week's kwm partition (three slots, well-formed ASINs only) into a fresh
 * keyword_top_asins_next, carrying each (keyword, ASIN) pair's streak from the previous build, then
 * a rename swap (table comments included) and the meta row, all in one transaction. ANALYZE runs
 * after COMMIT on its own: a failure there is reported on the result (analyzeError), never thrown,
 * because the swap is done.
 *
 * Builds serialize. The transaction (explicitly READ COMMITTED: under REPEATABLE READ the meta read
 * would see a snapshot from before the lock wait) takes the exclusive advisory lock TOP_ASINS_LOCK_KEY
 * before it reads the meta row, so two builds (the import hook and a manual script) queue instead of
 * racing, and the second one sees what the first committed: the same week twice is a same-week
 * rebuild, not a double count. The wait is bounded by the 30-minute statement timeout; the backfill
 * takes the same key. work_mem is raised for the transaction because the carry sorts ~8M rows. The
 * swap runs under a 120 s lock_timeout: a long-running reader of keyword_top_asins holds ACCESS SHARE,
 * and the DROP/RENAME would queue every new reader behind it; a 55P03 rolls back like any failure
 * and the import goes on with the old table.
 *
 * Two tables hold builds: keyword_top_asins (the current week; what readers see) and
 * keyword_top_asins_prev (the build the current one replaced; kept so a week can be rebuilt).
 * Migration 0051 creates only the first; the first build creates the second by renaming.
 *  - Advance (no build recorded, or a week newer than the meta week): carry from the current
 *    table; the swap retires the old _prev, renames current → _prev and _next → current. The
 *    previous week is the last BUILT week, whatever its date: a gap week breaks nothing.
 *  - Same-week rebuild (a re-imported week, a manual re-run): the current table already counts
 *    this week, so carrying from it would add the week twice. Carry from _prev (the week before)
 *    instead, or from nothing when _prev is missing (every pair then starts at 1; carrying from the
 *    current table minus its week would be exact for pairs present in both versions, but the simple
 *    rule is kept), and swap by dropping the stale current table, leaving _prev alone. Idempotent.
 *  - A week older than the meta week is refused unless forced. A forced rewind carries nothing:
 *    every streak restarts at 1, and the weeks after it must be rebuilt forward. Its swap drops
 *    both the newer current table and _prev, since a _prev left over would be a build NEWER than
 *    the rewound week; with no _prev, re-running the rewound week carries from nothing too.
 * The carry joins a de-duplicated copy of the carry table (DISTINCT ON) with a plain LEFT JOIN the
 * planner can hash; a per-row LATERAL ... LIMIT 1 could only run as ~8M index probes.
 *
 * Guards: a Pool is refused; a week older than the meta week is refused unless forced; zero rows
 * never swap. `client` must be ONE dedicated connection (never a Pool, never inside a transaction).
 * Callers: the import phase (inngest/functions/importFile.ts), scripts/buildTopAsinsWeek.ts and
 * the backfill (scripts/backfillTopAsins.ts, which drives the same statements week by week).
 */
export interface SqlStatement { text: string; values: unknown[] }
export interface Queryable { query(text: string, values?: unknown[]): Promise<{ rowCount: number | null; rows: unknown[] }> }
export interface TopAsinsBuildStatements {
  createNext: SqlStatement;
  insert: SqlStatement;
  swap: SqlStatement[];
  /** The meta upsert for a build that inserted `rows` rows: its values are [week, rows]. */
  meta: (rows: number) => SqlStatement;
}
/** Where a build's streaks are carried from: the current build, the retained previous build, or nothing (every pair starts at 1). */
export type TopAsinsCarryFrom = 'current' | 'prev' | 'none';
/**
 * How a build relates to the tables it replaces; the swap follows from it.
 *  - advance: carry from the current build and keep it as _prev (the older _prev is retired);
 *  - same-week rebuild: carry from _prev or from nothing, drop the stale current table, leave _prev alone
 *    (carrying from the stale table would count the week twice);
 *  - forced rewind: carry nothing and drop both the newer current table and _prev (a _prev left over would
 *    be a build newer than the week rebuilt).
 */
export type TopAsinsBuildPlan =
  | { carryFrom: 'current'; sameWeek: false }
  | { carryFrom: 'prev' | 'none'; sameWeek: true }
  | { carryFrom: 'none'; sameWeek: false; rewind: true };
export interface TopAsinsBuildResult {
  rows: number;
  /** The meta week this build found under the lock (null on the first build); equal to the week for a same-week rebuild. */
  previousWeek: string | null;
  carriedFrom: TopAsinsCarryFrom;
  /** Only when the ANALYZE after COMMIT threw: its pg code, else the error name ('unknown' if not an Error). */
  analyzeError?: string;
}
/** `top_asins_run_conflict` is the backfill's (lib/topAsins/backfill.ts): another run replaced its scratch tables. */
export type TopAsinsBuildErrorCode = 'top_asins_bad_date' | 'top_asins_bad_client' | 'top_asins_older_than_meta' | 'top_asins_no_rows' | 'top_asins_run_conflict';
export class TopAsinsBuildError extends Error {
  constructor(public readonly code: TopAsinsBuildErrorCode, message: string) { super(message); this.name = 'TopAsinsBuildError'; }
}

/** Transaction-scoped advisory lock key that serializes builds (and the backfill). Distinct from the Keepa ENQUEUE_LOCK_KEY. */
export const TOP_ASINS_LOCK_KEY = 20261009;

const ASIN_RE = "'^[A-Z0-9]{10}$'";
/** The tables a carry reads (carrying from nothing reads none). */
const CARRY_TABLE = { current: 'keyword_top_asins', prev: 'keyword_top_asins_prev' } as const;
const PREV_PROBE = "SELECT to_regclass('keyword_top_asins_prev') IS NOT NULL AS present";
/** LIKE ... INCLUDING COMMENTS copies no table comment, so the swap sets them (the first is migration 0051's text). */
const CURRENT_COMMENT = "COMMENT ON TABLE keyword_top_asins IS 'Current week''s top-3 clicked ASINs per keyword with consecutive-week streaks. Rebuilt per import (lib/topAsins/buildWeek.ts); backfilled once by scripts/backfillTopAsins.ts.'";
const PREV_COMMENT = "COMMENT ON TABLE keyword_top_asins_prev IS 'Previous build of keyword_top_asins: the streak carry source for a same-week rebuild.'";
const sql = (text: string): SqlStatement => ({ text, values: [] });

export function kwmPartitionFor(week: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(week)) throw new TopAsinsBuildError('top_asins_bad_date', 'week must be YYYY-MM-DD');
  return `keyword_weekly_metrics_${week.slice(0, 4)}`;
}

/** The three slot selects over one week of the partition. */
export function slotSelect(partition: string, slot: 1 | 2 | 3): string {
  return `SELECT search_term_id, top_clicked_product_${slot}_asin AS asin, ${slot}::smallint AS slot,
                 top_clicked_product_${slot}_click_share AS click_share, top_clicked_product_${slot}_conversion_share AS conversion_share
          FROM ${partition}
          WHERE week_end_date = $1::date AND top_clicked_product_${slot}_asin ~ ${ASIN_RE}`;
}

/**
 * The week's INSERT. Carrying from a table: a plain LEFT JOIN against its (keyword, ASIN) pairs, de-duplicated
 * so an ASIN in two slots of one keyword cannot multiply rows (the higher streak wins). Carrying from nothing:
 * no join, every pair starts at 1 on this week.
 */
function insertText(partition: string, carryFrom: TopAsinsCarryFrom): string {
  const head = `INSERT INTO keyword_top_asins_next (search_term_id, asin, slot, click_share, conversion_share, weeks_in_top3, streak_started_week, week_end_date)
             SELECT p.search_term_id, p.asin, p.slot, p.click_share, p.conversion_share,`;
  const slots = `(${slotSelect(partition, 1)} UNION ALL ${slotSelect(partition, 2)} UNION ALL ${slotSelect(partition, 3)}) p`;
  if (carryFrom === 'none') {
    return `${head}
                    1,
                    $1::date,
                    $1::date
             FROM ${slots}`;
  }
  return `${head}
                    COALESCE(prev.weeks_in_top3, 0) + 1,
                    COALESCE(prev.streak_started_week, $1::date),
                    $1::date
             FROM ${slots}
             LEFT JOIN (
               SELECT DISTINCT ON (search_term_id, asin) search_term_id, asin, weeks_in_top3, streak_started_week
               FROM ${CARRY_TABLE[carryFrom]}
               ORDER BY search_term_id, asin, weeks_in_top3 DESC
             ) prev ON prev.search_term_id = p.search_term_id AND prev.asin = p.asin`;
}

/**
 * The rename swap. LIKE ... INCLUDING ALL names the copy's primary key `<table>_pkey` and its other index
 * `<table>_<columns>_idx`, so _next's are the two literals below; they are renamed to the canonical names
 * (RENAME CONSTRAINT on a primary key renames its index too). Each table gets its comment (a renamed table
 * would otherwise carry the other's).
 *  - advance: retires the old _prev, then renames the current table and its two names to _prev, which frees
 *    the canonical names for _next;
 *  - same-week rebuild: drops the stale current table and leaves _prev alone;
 *  - forced rewind: drops _prev as well, so no build newer than the rewound week survives.
 */
function swapStatements(plan: TopAsinsBuildPlan): SqlStatement[] {
  const promoteNext = [
    sql('ALTER TABLE keyword_top_asins_next RENAME TO keyword_top_asins'),
    sql(CURRENT_COMMENT),
    sql('ALTER INDEX keyword_top_asins_next_asin_search_term_id_idx RENAME TO keyword_top_asins_asin_idx'),
    sql('ALTER TABLE keyword_top_asins RENAME CONSTRAINT keyword_top_asins_next_pkey TO keyword_top_asins_pkey'),
  ];
  if ('rewind' in plan) return [sql('DROP TABLE IF EXISTS keyword_top_asins_prev'), sql('DROP TABLE keyword_top_asins'), ...promoteNext];
  if (plan.sameWeek) return [sql('DROP TABLE keyword_top_asins'), ...promoteNext];
  return [
    sql('DROP TABLE IF EXISTS keyword_top_asins_prev'),
    sql('ALTER TABLE keyword_top_asins RENAME TO keyword_top_asins_prev'),
    sql('ALTER INDEX keyword_top_asins_asin_idx RENAME TO keyword_top_asins_prev_asin_idx'),
    sql('ALTER TABLE keyword_top_asins_prev RENAME CONSTRAINT keyword_top_asins_pkey TO keyword_top_asins_prev_pkey'),
    sql(PREV_COMMENT),
    ...promoteNext,
  ];
}

export function buildTopAsinsStatements(week: string, plan: TopAsinsBuildPlan = { carryFrom: 'current', sameWeek: false }): TopAsinsBuildStatements {
  const partition = kwmPartitionFor(week);
  return {
    createNext: sql('CREATE TABLE keyword_top_asins_next (LIKE keyword_top_asins INCLUDING ALL)'),
    insert: { text: insertText(partition, plan.carryFrom), values: [week] },
    swap: swapStatements(plan),
    meta: (rows) => ({
      text: `INSERT INTO keyword_top_asins_meta (singleton, week_end_date, built_at, row_count) VALUES (true, $1::date, now(), $2::bigint)
             ON CONFLICT (singleton) DO UPDATE SET week_end_date = EXCLUDED.week_end_date, built_at = EXCLUDED.built_at, row_count = EXCLUDED.row_count`,
      values: [week, rows],
    }),
  };
}

/** A pg error's code, else the error's name; never its message (log-safe). */
function errorCode(e: unknown): string {
  return typeof (e as { code?: unknown } | null | undefined)?.code === 'string' ? (e as { code: string }).code : e instanceof Error ? e.name : 'unknown';
}

/** How this build relates to the committed state. Runs under the lock, inside the transaction. */
async function choosePlan(client: Queryable, week: string, previousWeek: string | null): Promise<TopAsinsBuildPlan> {
  if (previousWeek && previousWeek > week) return { carryFrom: 'none', sameWeek: false, rewind: true }; // a forced rewind: every streak restarts at 1, no _prev survives
  if (previousWeek !== week) return { carryFrom: 'current', sameWeek: false }; // an advance
  // The current table already counts this week: carry from the retained build before it, if there is one.
  const probe = await client.query(PREV_PROBE);
  const prevPresent = (probe.rows[0] as { present: boolean } | undefined)?.present === true;
  return { carryFrom: prevPresent ? 'prev' : 'none', sameWeek: true };
}

/** BEGIN … COMMIT: lock, read what is committed, pick the plan, build into _next, swap, record. */
async function buildInTransaction(client: Queryable, week: string, force: boolean): Promise<Omit<TopAsinsBuildResult, 'analyzeError'>> {
  // Explicit: under REPEATABLE READ the meta read below would see a snapshot taken before the lock wait.
  await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
  try {
    // The pool's settings may not survive the pooler; set them for this transaction (the lock wait is bounded by the timeout).
    await client.query("SET LOCAL statement_timeout = '1800s'");
    await client.query("SET LOCAL work_mem = '256MB'");
    // Builds queue here, so the meta row below is the one the build before this one committed.
    await client.query('SELECT pg_advisory_xact_lock($1)', [TOP_ASINS_LOCK_KEY]);
    const meta = await client.query('SELECT week_end_date::text AS week_end_date FROM keyword_top_asins_meta WHERE singleton');
    const previousWeek = ((meta.rows[0] as { week_end_date: string | null } | undefined)?.week_end_date) ?? null;
    if (previousWeek && previousWeek > week && !force) {
      throw new TopAsinsBuildError('top_asins_older_than_meta', `week ${week} is older than the built week ${previousWeek}`);
    }
    const plan = await choosePlan(client, week, previousWeek);
    const s = buildTopAsinsStatements(week, plan);
    await client.query(s.createNext.text);
    const ins = await client.query(s.insert.text, s.insert.values);
    const rows = ins.rowCount ?? 0;
    if (rows === 0) throw new TopAsinsBuildError('top_asins_no_rows', `week ${week} produced no top-3 rows (not imported?)`);
    // A long-running reader holds ACCESS SHARE on the current table, and the swap's DROP/RENAME would queue every new
    // reader behind it. Give up after 120 s instead: a 55P03 rolls back like any failure and the import goes on with the old table.
    await client.query("SET LOCAL lock_timeout = '120s'");
    for (const st of s.swap) await client.query(st.text);
    const record = s.meta(rows);
    await client.query(record.text, record.values);
    await client.query('COMMIT');
    return { rows, previousWeek, carriedFrom: plan.carryFrom };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  }
}

export async function buildTopAsinsWeek(client: Queryable, week: string, opts: { force?: boolean } = {}): Promise<TopAsinsBuildResult> {
  if ('totalCount' in client) throw new TopAsinsBuildError('top_asins_bad_client', 'buildTopAsinsWeek needs one dedicated connection, not a Pool');
  kwmPartitionFor(week); // reject a malformed week before opening a transaction
  const built = await buildInTransaction(client, week, opts.force === true);
  let analyzeError: string | undefined;
  try {
    await client.query('ANALYZE keyword_top_asins');
  } catch (e) {
    // Best-effort: the swap is committed; autovacuum's analyze covers a miss.
    analyzeError = errorCode(e);
  }
  return { ...built, ...(analyzeError ? { analyzeError } : {}) };
}
