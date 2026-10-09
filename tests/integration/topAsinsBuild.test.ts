// tests/integration/topAsinsBuild.test.ts
/**
 * The keyword->ASIN reverse-table build (lib/topAsins/buildWeek.ts) against the real schema, without
 * touching the real tables. It proves what the fake-client unit tests cannot:
 *  - the advance INSERT (partition name, ASIN regex, the three-slot UNION ALL, the DISTINCT ON streak
 *    carry) runs on this database and yields the rows the week's partition promises;
 *  - the carry arithmetic: a second build that carries from the first scratch table adds one week to
 *    every pair the two share, keeps its streak start, and starts a pair the first lacked at 1;
 *  - the object names the rename swap relies on (what LIKE ... INCLUDING ALL generates, what the live
 *    table is called today), and the swap's _prev statements (statement text only);
 *  - the _prev probe and the advisory-lock statement the build runs.
 *
 * Nothing persists. Every case runs inside BEGIN ... ROLLBACK on one dedicated connection. The two
 * scratch tables are TEMP (private to this session, gone with the rollback). The build's INSERT is the
 * only build statement that runs, aimed at them; its carry only READS the real keyword_top_asins. The
 * real tables, the meta row and the swap are never written.
 *
 * Locking, cancellation and timeouts (every transaction):
 *  - the FIRST statement after BEGIN is pg_try_advisory_xact_lock(TOP_ASINS_LOCK_KEY), the build's own
 *    lock: it must come back true and stays held until the ROLLBACK. A build or backfill that starts
 *    meanwhile queues at the lock instead of running on to its swap, where it would wait behind this
 *    transaction's read lock on keyword_top_asins and give up after its 120 s lock_timeout. One that
 *    already holds the lock fails the case at once;
 *  - SET LOCAL client_connection_check_interval = '10s': if the client process dies (Ctrl-C, kill), the
 *    server stops the statement it is executing within ~10 s instead of finishing it for nobody. A
 *    vitest timeout does NOT trigger this: the test fails, but the process and its connection live on,
 *    so the server keeps running the statement until it finishes or the statement timeout hits;
 *  - the 600 s statement timeout applies to each statement on its own (it is what bounds a statement
 *    that outlives its test); a case's test timeout (30 minutes for the scratch builds) bounds the sum
 *    of its statements as the test sees them, and stops nothing on the server.
 *
 * Preconditions (owner-run only, never in CI):
 *  - migration 0051 applied; the reverse-table backfill done for meaningful numbers (an empty
 *    keyword_top_asins still runs: the checks that need rows assert what they can and log a note);
 *  - no import running (the week's partition must be quiet). An import that reaches its build phase
 *    meanwhile waits at the advisory lock until the case ends, so prefer a quiet hour;
 *  - expect minutes on a cold Neon: each INSERT scans the week's partition three times and sorts ~8M
 *    carry rows, and the two scratch tables hold roughly 1-1.5 GB each (the compute's local disk)
 *    until the rollback. The first INSERT's time is printed: that is the build's INSERT on this
 *    database (TEMP tables write no WAL, so the real build costs at least as much).
 *
 * Run (owner's go, Git Bash):
 *   RUN_INTEGRATION=1 pnpm vitest run tests/integration/topAsinsBuild.test.ts tests/integration/productsQueries.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { buildTopAsinsStatements, kwmPartitionFor, TOP_ASINS_LOCK_KEY } from '@/lib/topAsins/buildWeek';

const RUN = !!process.env.RUN_INTEGRATION;
/** Per statement (see the header); even a cold Neon takes minutes for the scratch builds, not this long. */
const STATEMENT_TIMEOUT = '600s';
/** How often the server checks that the client is still there while it runs a statement. */
const CONNECTION_CHECK_INTERVAL = '10s';
const BUILD_TEST_TIMEOUT_MS = 30 * 60_000;
const QUICK_TEST_TIMEOUT_MS = 5 * 60_000;
const HOOK_TIMEOUT_MS = 2 * 60_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** The build's ASIN predicate (ASIN_RE in buildWeek.ts). If the two drift, the exact row-count check below fails. */
const ASIN_PATTERN = '^[A-Z0-9]{10}$';
/** Scratch tables (TEMP): the first build, the second build (carrying from the first), and a table for the naming rule. */
const SCRATCH = 'keyword_top_asins_itest';
const SCRATCH_B = 'keyword_top_asins_itest_b';
const NAMES_PROBE = 'keyword_top_asins_itest2';
/**
 * Keywords taken out of the first scratch table before the second build: first this many are removed
 * (the second build has nothing to carry for them), then this many others get a longer, older streak
 * (so "weeks + 1" and "keeps its streak start" are checked on values the build did not just write).
 */
const CARRY_SAMPLE_KEYWORDS = 3000;

/** The names LIKE ... INCLUDING ALL gives a copy called `table`: its primary key and its (asin, search_term_id) index. */
const generatedNames = (table: string) => ({ pkey: `${table}_pkey`, asinIndex: `${table}_asin_search_term_id_idx` });

/**
 * The build's INSERT text aimed at scratch tables: `target` replaces keyword_top_asins_next; with
 * `carrySource`, the carry's FROM keyword_top_asins is replaced too (without it, the carry still reads
 * the real table). Each replacement must hit exactly one place, so a drifted text fails loudly.
 */
function retarget(text: string, opts: { target: string; carrySource?: string }): string {
  const replaceOnce = (input: string, token: RegExp, to: string): string => {
    expect(input.match(token)?.length ?? 0, `${token} in the build's INSERT text`).toBe(1);
    return input.replace(token, to);
  };
  const aimed = replaceOnce(text, /\bkeyword_top_asins_next\b/g, opts.target);
  return opts.carrySource ? replaceOnce(aimed, /\bkeyword_top_asins\b/g, opts.carrySource) : aimed;
}

interface ScratchStats {
  n: number;
  bad_weeks: number;
  bad_streak: number;
  bad_slot: number;
  bad_week: number;
  bad_asin: number;
  carried: number;
  max_weeks: number;
}
interface CarryStats {
  in_both: number;
  only_second: number;
  bad_week: number;
  bad_weeks: number;
  bad_streak: number;
  bad_new: number;
}

describe.skipIf(!RUN)('Top-ASINs reverse-table build (integration)', () => {
  let pool: Pool;
  let client: PoolClient;
  /** keyword_current_summary_meta.current_week_end_date: the week the explorer shows, and the build's week here. */
  let currentWeek = '';
  /** keyword_top_asins_meta.week_end_date: null until the first build. */
  let metaWeek: string | null = null;
  let realTableEmpty = true;

  beforeAll(async () => {
    // keepAlive: the scratch builds are minutes of silence on the socket, as in the build's own callers.
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, keepAlive: true, keepAliveInitialDelayMillis: 10_000, connectionTimeoutMillis: 60_000 });
    pool.on('error', () => undefined);
    client = await pool.connect();
    client.on('error', () => undefined);
    const tables = await client.query<{ ok: boolean }>(
      "SELECT to_regclass('keyword_top_asins') IS NOT NULL AND to_regclass('keyword_top_asins_meta') IS NOT NULL AS ok",
    );
    if (!tables.rows[0]?.ok) throw new Error('migration 0051 is not applied (keyword_top_asins or keyword_top_asins_meta is missing)');
    const kcs = await client.query<{ week: string }>('SELECT current_week_end_date::text AS week FROM keyword_current_summary_meta WHERE singleton');
    if (!kcs.rows[0]) throw new Error('keyword_current_summary_meta has no row: the explorer week is unknown');
    currentWeek = kcs.rows[0].week;
    const meta = await client.query<{ week: string | null }>('SELECT week_end_date::text AS week FROM keyword_top_asins_meta WHERE singleton');
    metaWeek = meta.rows[0]?.week ?? null;
    const empty = await client.query<{ is_empty: boolean }>('SELECT NOT EXISTS (SELECT 1 FROM keyword_top_asins) AS is_empty');
    realTableEmpty = empty.rows[0]?.is_empty ?? true;
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    try {
      // Belt and braces: end any transaction a failed case left open (its TEMP tables go with it).
      await client?.query('ROLLBACK').catch(() => undefined);
    } finally {
      client?.release();
      await pool?.end();
    }
  }, HOOK_TIMEOUT_MS);

  /**
   * BEGIN ... ROLLBACK around `fn`: whatever it does, or however it fails, nothing persists. The first
   * statement takes the build's advisory lock (held to the ROLLBACK), before any read lock on the
   * real table exists; see the header.
   */
  async function inRolledBackTransaction(fn: () => Promise<void>): Promise<void> {
    await client.query('BEGIN');
    try {
      const lock = await client.query<{ got: boolean }>('SELECT pg_try_advisory_xact_lock($1) AS got', [TOP_ASINS_LOCK_KEY]);
      expect(lock.rows[0]?.got, 'a build or backfill holds the advisory lock right now: let it finish, then run this again').toBe(true);
      await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);
      await client.query(`SET LOCAL client_connection_check_interval = '${CONNECTION_CHECK_INTERVAL}'`);
      await fn();
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
    }
  }

  /** A table's index names (sorted) and constraints, as Postgres holds them. */
  async function objectNames(table: string) {
    const idx = await client.query<{ indexname: string }>('SELECT indexname FROM pg_indexes WHERE tablename = $1', [table]);
    const con = await client.query<{ conname: string; contype: string; def: string }>(
      'SELECT conname, contype, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = $1::regclass',
      [table],
    );
    return { indexes: idx.rows.map((r) => r.indexname).sort(), constraints: con.rows };
  }

  it('reads the explorer week and the reverse-table week', () => {
    expect(currentWeek, 'keyword_current_summary_meta.current_week_end_date').toMatch(DATE_RE);
    if (metaWeek === null) {
      console.log('[topAsinsBuild] keyword_top_asins_meta.week_end_date is null: the reverse table has not been built yet (run the backfill); the cases below assert what they can.');
      return;
    }
    expect(metaWeek, 'keyword_top_asins_meta.week_end_date').toMatch(DATE_RE);
    const relation = metaWeek === currentWeek ? 'the same week' : metaWeek < currentWeek ? 'behind the explorer, so the next import advances it' : 'AHEAD of the explorer';
    console.log(`[topAsinsBuild] explorer week ${currentWeek}; reverse table built for ${metaWeek} (${relation})`);
  });

  it(
    'the advance INSERT runs against the real schema into a scratch table, and a second build carries from the first',
    async () => {
      const advance = buildTopAsinsStatements(currentWeek);
      const partition = kwmPartitionFor(currentWeek);
      // First build: the build's own INSERT text, target renamed; its carry still READS the real keyword_top_asins.
      const firstInsert = retarget(advance.insert.text, { target: SCRATCH });
      // Second build: target renamed and the carry source pointed at the first scratch table.
      const secondInsert = retarget(advance.insert.text, { target: SCRATCH_B, carrySource: SCRATCH });
      expect(firstInsert, 'the first build still carries from the real table').toMatch(/\bFROM keyword_top_asins\s/);
      expect(secondInsert, 'the second build carries from the first scratch table').toMatch(new RegExp(`\\bFROM ${SCRATCH}\\s`));

      await inRolledBackTransaction(async () => {
        // The build's own setting: the carry sorts ~8M rows.
        await client.query("SET LOCAL work_mem = '256MB'");
        await client.query(`CREATE TEMP TABLE ${SCRATCH} (LIKE keyword_top_asins INCLUDING ALL)`);

        // What the week's partition promises: one row per well-formed ASIN in each slot.
        const counted = await client.query<{ n1: number; n2: number; n3: number }>(
          `SELECT count(*) FILTER (WHERE top_clicked_product_1_asin ~ $2)::int AS n1,
                  count(*) FILTER (WHERE top_clicked_product_2_asin ~ $2)::int AS n2,
                  count(*) FILTER (WHERE top_clicked_product_3_asin ~ $2)::int AS n3
           FROM ${partition} WHERE week_end_date = $1::date`,
          [currentWeek, ASIN_PATTERN],
        );
        const { n1, n2, n3 } = counted.rows[0];

        const startedFirst = performance.now();
        const first = await client.query(firstInsert, advance.insert.values);
        const firstSeconds = (performance.now() - startedFirst) / 1000;
        const firstRows = first.rowCount ?? 0;

        const statsResult = await client.query<ScratchStats>(
          `SELECT count(*)::int AS n,
                  count(*) FILTER (WHERE weeks_in_top3 < 1)::int AS bad_weeks,
                  count(*) FILTER (WHERE streak_started_week > week_end_date)::int AS bad_streak,
                  count(*) FILTER (WHERE slot NOT IN (1, 2, 3))::int AS bad_slot,
                  count(*) FILTER (WHERE week_end_date <> $1::date)::int AS bad_week,
                  count(*) FILTER (WHERE asin !~ $2)::int AS bad_asin,
                  count(*) FILTER (WHERE weeks_in_top3 > 1)::int AS carried,
                  coalesce(max(weeks_in_top3), 0)::int AS max_weeks
           FROM ${SCRATCH}`,
          [currentWeek, ASIN_PATTERN],
        );
        const stats = statsResult.rows[0];
        // When the live table is already built for this week, this advance counts the week a second time.
        const countsWeekAgain = metaWeek === currentWeek;
        console.log(
          `[topAsinsBuild] week ${currentWeek}: the advance INSERT put ${firstRows} rows into a TEMP scratch table in ${firstSeconds.toFixed(1)}s ` +
            `(valid ASINs per slot ${n1}/${n2}/${n3}; ${stats.carried} pairs carried a streak, longest ${stats.max_weeks} weeks` +
            `${countsWeekAgain ? ', one more than the live table: it already counts this week' : ''})`,
        );
        if (realTableEmpty) console.log('[topAsinsBuild] keyword_top_asins is empty: nothing to carry, so every pair starts at 1.');

        expect(firstRows, 'rows inserted into the scratch table').toBeGreaterThanOrEqual(1);
        // The LEFT JOIN carry neither adds nor drops rows, so the count is exactly the three slot counts (at most three per keyword).
        expect(firstRows, 'one row per well-formed ASIN in each slot of the week').toBe(n1 + n2 + n3);
        expect(stats.n, 'rows in the scratch table').toBe(firstRows);
        expect(stats.bad_weeks, 'rows with weeks_in_top3 < 1').toBe(0);
        expect(stats.bad_streak, 'rows with streak_started_week after the build week').toBe(0);
        expect(stats.bad_slot, 'rows with a slot outside 1..3').toBe(0);
        expect(stats.bad_week, 'rows whose week_end_date is not the build week').toBe(0);
        expect(stats.bad_asin, 'rows with a malformed ASIN').toBe(0);
        if (realTableEmpty) {
          expect(stats.carried, 'pairs that carried a streak from an empty table').toBe(0);
          expect(stats.max_weeks, 'longest streak from an empty table').toBe(1);
        } else {
          expect(stats.carried, 'pairs that carried a streak from the live table').toBeGreaterThan(0);
        }

        // Carry arithmetic, on this database's own data: build again, carrying from the first scratch table.
        // A fresh TEMP table has no statistics (the real one is analyzed after every build).
        await client.query(`ANALYZE ${SCRATCH}`);
        await client.query(`CREATE TEMP TABLE ${SCRATCH_B} (LIKE keyword_top_asins INCLUDING ALL)`);
        // Slot-1 rows are one per keyword (primary key (search_term_id, slot)), so this picks KEYWORDS, not rows.
        // After the DELETE its rows are gone, so the same subquery then picks the next keywords for the UPDATE.
        const sampleKeywords = `SELECT search_term_id FROM ${SCRATCH} WHERE slot = 1 LIMIT ${CARRY_SAMPLE_KEYWORDS}`;
        const gap = await client.query(`DELETE FROM ${SCRATCH} WHERE search_term_id IN (${sampleKeywords})`);
        const gapRows = gap.rowCount ?? 0;
        const aged = await client.query(
          `UPDATE ${SCRATCH} SET weeks_in_top3 = weeks_in_top3 + 4, streak_started_week = streak_started_week - 7
           WHERE search_term_id IN (${sampleKeywords})`,
        );
        const agedRows = aged.rowCount ?? 0;

        const startedSecond = performance.now();
        const second = await client.query(secondInsert, advance.insert.values);
        const secondSeconds = (performance.now() - startedSecond) / 1000;
        await client.query(`ANALYZE ${SCRATCH_B}`);
        expect(second.rowCount ?? 0, 'the second build has the same rows as the first (the carry only changes counters)').toBe(firstRows);

        const carryResult = await client.query<CarryStats>(
          `SELECT count(f.asin)::int AS in_both,
                  (count(*) - count(f.asin))::int AS only_second,
                  count(*) FILTER (WHERE b.week_end_date <> $1::date)::int AS bad_week,
                  count(*) FILTER (WHERE f.asin IS NOT NULL AND b.weeks_in_top3 <> f.weeks_in_top3 + 1)::int AS bad_weeks,
                  count(*) FILTER (WHERE f.asin IS NOT NULL AND b.streak_started_week <> f.streak_started_week)::int AS bad_streak,
                  count(*) FILTER (WHERE f.asin IS NULL AND (b.weeks_in_top3 <> 1 OR b.streak_started_week <> $1::date))::int AS bad_new
           FROM ${SCRATCH_B} b
           LEFT JOIN ${SCRATCH} f ON f.search_term_id = b.search_term_id AND f.asin = b.asin`,
          [currentWeek],
        );
        const carry = carryResult.rows[0];
        console.log(
          `[topAsinsBuild] second build (carry from the first scratch table: ${gapRows} rows of ${CARRY_SAMPLE_KEYWORDS} keywords removed, ${agedRows} rows of ${CARRY_SAMPLE_KEYWORDS} others given +4 weeks and a streak 7 days older) in ${secondSeconds.toFixed(1)}s: ` +
            `${carry.in_both} pairs in both, ${carry.only_second} only in the second`,
        );

        expect(carry.bad_week, 'second-build rows whose week_end_date is not the build week').toBe(0);
        expect(carry.bad_weeks, 'pairs in both builds: weeks_in_top3 must be the first build\'s + 1').toBe(0);
        expect(carry.bad_streak, 'pairs in both builds: streak_started_week must be the first build\'s').toBe(0);
        expect(carry.bad_new, 'pairs only in the second build: weeks_in_top3 = 1 and streak_started_week = the build week').toBe(0);
        // The second build has the first one's pairs, so the pairs it has alone are exactly the removed keywords' rows.
        expect(carry.only_second, 'pairs only in the second build: exactly the rows removed from the first').toBe(gapRows);
        expect(carry.in_both, 'pairs present in both builds').toBeGreaterThanOrEqual(firstRows - gapRows);
        // More slot-1 keywords than the removed ones, so some were left to age (so "keeps its streak start" is checked on values the build did not just write).
        if (n1 > CARRY_SAMPLE_KEYWORDS) expect(agedRows, 'rows given an older streak').toBeGreaterThan(0);
      });
    },
    BUILD_TEST_TIMEOUT_MS,
  );

  it(
    'LIKE ... INCLUDING ALL names a copy the way the swap expects, and the live table carries the canonical names',
    async () => {
      await inRolledBackTransaction(async () => {
        await client.query(`CREATE TEMP TABLE ${NAMES_PROBE} (LIKE keyword_top_asins INCLUDING ALL)`);
        const copy = await objectNames(NAMES_PROBE);
        const generated = generatedNames(NAMES_PROBE);
        expect(copy.indexes, 'indexes of the scratch copy').toEqual([generated.asinIndex, generated.pkey].sort());
        expect(copy.constraints.filter((c) => c.contype === 'p').map((c) => c.conname), 'primary key of the scratch copy').toEqual([generated.pkey]);
        const checks = copy.constraints.filter((c) => c.contype === 'c');
        expect(checks, 'CHECK constraints of the scratch copy').toHaveLength(2);
        expect(checks.some((c) => /\bslot\b/.test(c.def)), 'a CHECK on slot').toBe(true);
        expect(checks.some((c) => /\bweeks_in_top3\b/.test(c.def)), 'a CHECK on weeks_in_top3').toBe(true);

        // The names the advance swap renames FROM on the live table (to _prev), which must exist for the next build's swap to run.
        const live = await objectNames('keyword_top_asins');
        expect(live.indexes, 'indexes of keyword_top_asins').toEqual(expect.arrayContaining(['keyword_top_asins_pkey', 'keyword_top_asins_asin_idx']));
        expect(live.constraints.map((c) => c.conname), 'constraints of keyword_top_asins').toContain('keyword_top_asins_pkey');
      });
    },
    QUICK_TEST_TIMEOUT_MS,
  );

  it('the advance swap retires the current table to _prev and renames _next by the generated names (statement text only, never executed)', () => {
    const swap = buildTopAsinsStatements(currentWeek).swap.map((s) => s.text);
    // Retire: drop the old _prev, then the current table (and its index and primary key) becomes _prev.
    const dropPrev = swap.indexOf('DROP TABLE IF EXISTS keyword_top_asins_prev');
    expect(dropPrev, 'the swap drops the old _prev').toBeGreaterThanOrEqual(0);
    expect(swap.indexOf('ALTER TABLE keyword_top_asins RENAME TO keyword_top_asins_prev'), 'the swap renames the current table to _prev, after dropping the old one').toBeGreaterThan(dropPrev);
    expect(swap).toContain('ALTER INDEX keyword_top_asins_asin_idx RENAME TO keyword_top_asins_prev_asin_idx');
    expect(swap).toContain('ALTER TABLE keyword_top_asins_prev RENAME CONSTRAINT keyword_top_asins_pkey TO keyword_top_asins_prev_pkey');
    // Promote: the literals are the naming rule (proved above on a scratch copy) applied to keyword_top_asins_next.
    const next = generatedNames('keyword_top_asins_next');
    expect(swap).toContain('ALTER TABLE keyword_top_asins_next RENAME TO keyword_top_asins');
    expect(swap).toContain(`ALTER INDEX ${next.asinIndex} RENAME TO keyword_top_asins_asin_idx`);
    expect(swap).toContain(`ALTER TABLE keyword_top_asins RENAME CONSTRAINT ${next.pkey} TO keyword_top_asins_pkey`);
  });

  it(
    "the _prev probe and the build's own lock statement run inside the transaction",
    async () => {
      await inRolledBackTransaction(async () => {
        // The build's own probe (PREV_PROBE in buildWeek.ts): null or not, it must run.
        const probe = await client.query<{ present: boolean }>("SELECT to_regclass('keyword_top_asins_prev') IS NOT NULL AS present");
        expect(typeof probe.rows[0]?.present, 'to_regclass probe').toBe('boolean');
        console.log(`[topAsinsBuild] keyword_top_asins_prev ${probe.rows[0].present ? 'exists' : 'does not exist yet (the first build creates it)'}`);

        // The statement the build itself runs. This transaction already holds the lock (its first statement), so it returns at once.
        await client.query('SELECT pg_advisory_xact_lock($1)', [TOP_ASINS_LOCK_KEY]);
      });
    },
    QUICK_TEST_TIMEOUT_MS,
  );
});
