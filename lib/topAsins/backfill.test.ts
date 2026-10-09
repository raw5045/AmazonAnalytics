// lib/topAsins/backfill.test.ts
import { describe, it, expect } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { keywordTopAsins, keywordWeeklyMetrics } from '@/db/schema';
import { buildTopAsinsStatements, buildTopAsinsWeek, TOP_ASINS_LOCK_KEY, TopAsinsBuildError, type Queryable } from './buildWeek';
import {
  assertBackfillWeeks,
  backfillSetupStatements,
  backfillWeekStatements,
  finalizeStatements,
  newRunToken,
  rotateStatements,
  runBackfill,
  stampReadSql,
  stampSql,
  stampText,
  weeksSql,
} from './backfill';

const dbCols = (t: Parameters<typeof getTableColumns>[0]) => new Set(Object.values(getTableColumns(t)).map((c) => c.name));
/** A statement's text with its whitespace collapsed (the builders' templates are indented). */
const norm = (s: string) => s.trim().replace(/\s+/g, ' ');
const WEEK = '2026-10-03';
const WEEKS = ['2026-09-19', '2026-09-26', '2026-10-03'];
const TOKEN = '2026-10-09T17:05:03.123Z-0a1b2c3d';
/** The live table's bare name (not _next, _prev, _bf or _meta). */
const LIVE = /\bkeyword_top_asins\b/;
/** Anything that reaches the live side: the live table, _prev, _next or the meta row (the scratch pair is _bf and _bf_prev). */
const touchesLiveSide = (t: string) => LIVE.test(t.replace('LIKE keyword_top_asins ', '')) || /keyword_top_asins_(?:prev|next|meta)\b/.test(t);

// The statements the runner wraps around the builders. They are the build's own: 'the statements shared with the build' pins them.
const BEGIN = 'BEGIN ISOLATION LEVEL READ COMMITTED';
const BEGIN_TAG = 'BEGIN ISOLATION LEVEL'; // its first three words
const SET_TIMEOUT = "SET LOCAL statement_timeout = '1800s'";
const SET_WORK_MEM = "SET LOCAL work_mem = '256MB'";
const SET_MAINTENANCE_WORK_MEM = "SET LOCAL maintenance_work_mem = '256MB'";
const SET_LOCK_TIMEOUT = "SET LOCAL lock_timeout = '120s'";
const LOCK = 'SELECT pg_advisory_xact_lock($1)';
const META_QUERY = 'SELECT week_end_date::text AS week_end_date FROM keyword_top_asins_meta WHERE singleton';
const STAMP_READ = "SELECT obj_description(to_regclass('keyword_top_asins_bf'), 'pg_class') AS stamp";
const WEEKS_QUERY = norm(weeksSql());

/** The build's own swap statements for a plan (the backfill's swap and comments must stay in step with them). */
const buildSwapOf = (plan: Parameters<typeof buildTopAsinsStatements>[1]) => buildTopAsinsStatements(WEEK, plan).swap.map((s) => norm(s.text));

describe('weeksSql', () => {
  it('is a loose index scan on the parent table: one min() probe per week, not a DISTINCT over the partitions', () => {
    expect(norm(weeksSql())).toBe(
      'WITH RECURSIVE w AS ( SELECT min(week_end_date) AS d FROM keyword_weekly_metrics UNION ALL SELECT (SELECT min(week_end_date) FROM keyword_weekly_metrics WHERE week_end_date > w.d) FROM w WHERE w.d IS NOT NULL ) SELECT d::text AS week FROM w WHERE d IS NOT NULL ORDER BY d',
    );
    expect(weeksSql()).not.toMatch(/keyword_weekly_metrics_\d{4}|DISTINCT/); // the parent table: every partition, including later years
    expect(dbCols(keywordWeeklyMetrics).has('week_end_date')).toBe(true);
  });
});

describe('the run token', () => {
  it('newRunToken is an ISO timestamp and a random suffix, different on every call', () => {
    const a = newRunToken();
    expect(a).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z-[0-9a-f]{8}$/);
    expect(newRunToken()).not.toBe(a);
  });
  it('is stamped on keyword_top_asins_bf as a table comment, and read back with to_regclass so a missing table reads as NULL', () => {
    expect(stampText(TOKEN)).toBe(`backfill run ${TOKEN}`);
    expect(norm(stampSql(TOKEN).text)).toBe(`COMMENT ON TABLE keyword_top_asins_bf IS 'backfill run ${TOKEN}'`);
    expect(norm(stampReadSql().text)).toBe(STAMP_READ);
  });
  it('refuses a token that is not a plain literal (COMMENT takes no parameters, so it is interpolated)', () => {
    for (const bad of ["x'; DROP TABLE y; --", '', 'short', 'has space in it', 'a'.repeat(65), "abc'defghi"]) {
      expect(() => stampText(bad)).toThrow(TypeError);
      expect(() => stampSql(bad)).toThrow(TypeError);
    }
  });
});

describe('backfillSetupStatements', () => {
  const setup = backfillSetupStatements(TOKEN).map((s) => norm(s.text));
  it('drops, then recreates, the two scratch tables shaped like the live table (defaults only: no key, no checks), indexes the carry source and stamps _bf with the run', () => {
    expect(setup).toEqual([
      'DROP TABLE IF EXISTS keyword_top_asins_bf',
      'DROP TABLE IF EXISTS keyword_top_asins_bf_prev',
      'CREATE TABLE keyword_top_asins_bf (LIKE keyword_top_asins INCLUDING DEFAULTS)',
      'CREATE TABLE keyword_top_asins_bf_prev (LIKE keyword_top_asins INCLUDING DEFAULTS)',
      'CREATE INDEX keyword_top_asins_bf_prev_pair_idx ON keyword_top_asins_bf_prev (search_term_id, asin)',
      `COMMENT ON TABLE keyword_top_asins_bf IS 'backfill run ${TOKEN}'`,
    ]);
  });
  it('never writes the live table (it is only the LIKE source) and binds no values', () => {
    for (const st of backfillSetupStatements(TOKEN)) {
      expect(st.values).toEqual([]);
      expect(norm(st.text).replace('LIKE keyword_top_asins ', '')).not.toMatch(LIVE);
    }
  });
  it('indexes real columns', () => {
    const cols = setup[4].slice(setup[4].indexOf('(') + 1, setup[4].indexOf(')')).split(',').map((c) => c.trim());
    expect(cols).toEqual(['search_term_id', 'asin']);
    expect(cols.filter((c) => !dbCols(keywordTopAsins).has(c))).toEqual([]);
  });
});

describe('backfillWeekStatements', () => {
  const { insert } = backfillWeekStatements(WEEK);
  it("is the build's INSERT with two names swapped: it writes keyword_top_asins_bf and carries from keyword_top_asins_bf_prev", () => {
    const build = norm(buildTopAsinsStatements(WEEK).insert.text); // the advance plan: carries from the live table
    const expected = build
      .replace('INSERT INTO keyword_top_asins_next', 'INSERT INTO keyword_top_asins_bf')
      .replace('FROM keyword_top_asins ORDER BY', 'FROM keyword_top_asins_bf_prev ORDER BY');
    expect(expected).not.toBe(build);
    expect(expected).toContain('FROM keyword_top_asins_bf_prev ORDER BY');
    expect(norm(insert.text)).toBe(expected);
  });
  it('reads the week from its year partition: three slots, well-formed ASINs only; values are [week]', () => {
    expect(insert.text).toContain('FROM keyword_weekly_metrics_2026');
    expect(insert.text.match(/top_clicked_product_[123]_asin ~ '\^\[A-Z0-9\]\{10\}\$'/g)).toHaveLength(3);
    expect(insert.values).toEqual([WEEK]);
    const dec = backfillWeekStatements('2025-12-27').insert.text;
    expect(dec).toContain('FROM keyword_weekly_metrics_2025');
    expect(dec).not.toContain('keyword_weekly_metrics_2026');
    expect(backfillWeekStatements('2026-01-03').insert.text).toContain('FROM keyword_weekly_metrics_2026');
    expect(backfillWeekStatements('2027-01-02').insert.text).toContain('FROM keyword_weekly_metrics_2027');
  });
  it('carries through DISTINCT ON + a plain LEFT JOIN (hash-joinable), prev + 1 else 1 starting this week', () => {
    expect(insert.text).toMatch(/LEFT JOIN \(\s*SELECT DISTINCT ON \(search_term_id, asin\) search_term_id, asin, weeks_in_top3, streak_started_week\s+FROM keyword_top_asins_bf_prev\s+ORDER BY search_term_id, asin, weeks_in_top3 DESC/);
    expect(insert.text).toContain(') prev ON prev.search_term_id = p.search_term_id AND prev.asin = p.asin');
    expect(insert.text).toContain('COALESCE(prev.weeks_in_top3, 0) + 1');
    expect(insert.text).toContain('COALESCE(prev.streak_started_week, $1::date)');
    expect(insert.text).not.toContain('LATERAL');
    expect(insert.text).not.toContain('LIMIT');
  });
  it('never reads or writes the live table: only the scratch pair', () => {
    expect(insert.text).not.toMatch(LIVE);
    expect(insert.text).not.toContain('keyword_top_asins_next');
  });
  it('names only real columns', () => {
    const kwmCols = new Set([...insert.text.matchAll(/\b(top_clicked_product_[123]_(?:asin|click_share|conversion_share)|search_term_id|week_end_date)\b/g)].map((m) => m[1]));
    expect(kwmCols.size).toBe(11);
    expect([...kwmCols].filter((c) => !dbCols(keywordWeeklyMetrics).has(c))).toEqual([]);
    const insertCols = insert.text.slice(insert.text.indexOf('(') + 1, insert.text.indexOf(')')).split(',').map((c) => c.trim());
    expect(insertCols).toHaveLength(8);
    expect(insertCols.filter((c) => !dbCols(keywordTopAsins).has(c))).toEqual([]);
  });
  it('rejects a malformed week (the partition name is interpolated into SQL)', () => {
    expect(() => backfillWeekStatements('2026/10/03')).toThrow(TopAsinsBuildError);
    expect(() => backfillWeekStatements("2026-10-03'; DROP TABLE x")).toThrowError(expect.objectContaining({ code: 'top_asins_bad_date' }));
  });
});

describe('rotateStatements', () => {
  const rotate = rotateStatements(TOKEN).map((s) => norm(s.text));
  it('rotates by rename, not by copy: drop the old carry source, rename _bf to _bf_prev, index and analyze it, create a fresh _bf and stamp it again', () => {
    expect(rotate).toEqual([
      'DROP TABLE IF EXISTS keyword_top_asins_bf_prev',
      'ALTER TABLE keyword_top_asins_bf RENAME TO keyword_top_asins_bf_prev',
      'CREATE INDEX keyword_top_asins_bf_prev_pair_idx ON keyword_top_asins_bf_prev (search_term_id, asin)',
      'ANALYZE keyword_top_asins_bf_prev',
      'CREATE TABLE keyword_top_asins_bf (LIKE keyword_top_asins INCLUDING DEFAULTS)',
      `COMMENT ON TABLE keyword_top_asins_bf IS 'backfill run ${TOKEN}'`,
    ]);
  });
  it('copies no rows, and builds the same carry index and empty _bf that setup does', () => {
    expect(rotate.filter((t) => /^(INSERT|TRUNCATE)/.test(t))).toEqual([]);
    const setup = backfillSetupStatements(TOKEN).map((s) => norm(s.text));
    expect(rotate[2]).toBe(setup[4]);
    expect(rotate[4]).toBe(setup[2]);
    expect(rotate[5]).toBe(setup[5]);
  });
  it('never touches the live table', () => {
    for (const st of rotateStatements(TOKEN)) expect(norm(st.text).replace('LIKE keyword_top_asins ', '')).not.toMatch(LIVE);
  });
});

describe('finalizeStatements', () => {
  const f = finalizeStatements(WEEK);
  it('reads the meta week with the same statement a build uses', () => {
    expect(f.metaWeek.text).toBe(META_QUERY);
  });
  it('builds the replacement beside the live table, like a build, and fills it from the LAST week (still in _bf: the last week is never rotated)', () => {
    expect(norm(f.createNext.text)).toBe(norm(buildTopAsinsStatements(WEEK).createNext.text));
    expect(norm(f.createNext.text)).toBe('CREATE TABLE keyword_top_asins_next (LIKE keyword_top_asins INCLUDING ALL)');
    expect(norm(f.fillNext.text)).toBe('INSERT INTO keyword_top_asins_next SELECT * FROM keyword_top_asins_bf');
  });
  it('keeps the previous week walked as keyword_top_asins_prev: the old one dropped, the new one SELECT * from _bf_prev (all eight columns, like a build-made _prev), with the comment a build gives it', () => {
    const buildComment = buildSwapOf(undefined).find((t) => t.startsWith('COMMENT ON TABLE keyword_top_asins_prev'));
    expect(buildComment).toBeDefined();
    expect(f.prev.map((s) => norm(s.text))).toEqual([
      'DROP TABLE IF EXISTS keyword_top_asins_prev',
      'CREATE TABLE keyword_top_asins_prev AS SELECT * FROM keyword_top_asins_bf_prev',
      buildComment,
    ]);
  });
  it("swaps like a build's same-week rebuild: drop the live table, promote _next under the canonical names, with the table comment", () => {
    expect(f.swap.map((s) => norm(s.text))).toEqual(buildSwapOf({ carryFrom: 'none', sameWeek: true }));
    expect(f.swap.map((s) => norm(s.text))[0]).toBe('DROP TABLE keyword_top_asins');
    expect(f.swap).toHaveLength(5);
  });
  it("writes the build's own meta upsert: the last week and the copied row count, bound at run time", () => {
    const built = buildTopAsinsStatements(WEEK).meta(7);
    expect(norm(f.meta(7).text)).toBe(norm(built.text));
    expect(f.meta(7).values).toEqual(built.values);
    expect(f.meta(7).values).toEqual([WEEK, 7]);
    expect(f.meta(8).values).toEqual([WEEK, 8]);
  });
  it('drops both scratch tables, and analyzes the live table (after COMMIT, on its own)', () => {
    expect(f.cleanup.map((s) => s.text)).toEqual(['DROP TABLE keyword_top_asins_bf', 'DROP TABLE keyword_top_asins_bf_prev']);
    expect(f.analyze.text).toBe('ANALYZE keyword_top_asins');
  });
  it('names the live table only in the swap (and the LIKE source): the exclusive lock window is the swap alone', () => {
    for (const st of [f.metaWeek, ...f.prev, f.createNext, f.fillNext, f.meta(7), ...f.cleanup]) {
      expect(norm(st.text).replace('LIKE keyword_top_asins ', '').replace(/COMMENT ON TABLE keyword_top_asins_prev IS '[^']*'/, '')).not.toMatch(LIVE);
    }
  });
  it('rejects a malformed week', () => {
    expect(() => finalizeStatements('2026/10/03')).toThrow(TopAsinsBuildError);
    expect(() => finalizeStatements("2026-10-03'; DROP TABLE x")).toThrowError(expect.objectContaining({ code: 'top_asins_bad_date' }));
  });
});

describe('assertBackfillWeeks', () => {
  it('accepts ascending distinct weeks in any year that has a partition (no partition list to extend)', () => {
    expect(() => assertBackfillWeeks(['2025-04-19', '2025-12-27', '2026-01-03', '2026-10-03'])).not.toThrow();
    expect(() => assertBackfillWeeks(['2026-12-26', '2027-01-02'])).not.toThrow();
    expect(() => assertBackfillWeeks([WEEK])).not.toThrow();
  });
  it('accepts weeks that are not consecutive (a missing import week is a gap, not an error)', () => {
    expect(() => assertBackfillWeeks(['2025-04-19', '2025-06-14', '2026-01-03'])).not.toThrow();
  });
  it('refuses an empty list with top_asins_no_rows', () => {
    expect(() => assertBackfillWeeks([])).toThrowError(expect.objectContaining({ code: 'top_asins_no_rows' }));
  });
  it('refuses a descending, repeated or malformed list with top_asins_bad_date', () => {
    for (const bad of [['2026-09-26', '2026-09-19'], ['2026-09-19', '2026-09-19'], ['2026-09-19', '10/03/2026'], ['2026-09-19', "2026-09-26'; DROP TABLE x"]]) {
      expect(() => assertBackfillWeeks(bad)).toThrowError(expect.objectContaining({ code: 'top_asins_bad_date' }));
    }
    expect(() => assertBackfillWeeks([null as unknown as string])).toThrowError(expect.objectContaining({ code: 'top_asins_bad_date' }));
  });
});

// ---- the runner, against a fake client (nothing here connects to a database) ----

type Answer = { rowCount: number | null; rows: unknown[] } | { throws: unknown };
type Responder = (text: string, values: unknown[]) => Answer | undefined;
const answer = (rowCount: number | null, rows: unknown[] = []): Answer => ({ rowCount, rows });

/** Records every statement's whitespace-collapsed text and bound values; `respond` answers by text. */
function fakeClient(respond: Responder): Queryable & { texts: string[]; args: unknown[][] } {
  const texts: string[] = [];
  const args: unknown[][] = [];
  return {
    texts,
    args,
    async query(text: string, values?: unknown[]) {
      const t = norm(text);
      texts.push(t);
      args.push(values ?? []);
      const hit = respond(t, values ?? []);
      if (hit && 'throws' in hit) throw hit.throws;
      return hit ?? { rowCount: 0, rows: [] };
    },
  };
}

describe('the statements shared with the build are the build\'s', () => {
  /** Runs the real build against a recording client (an advance of the week) and returns what it executed. */
  async function recordedBuild() {
    const texts: string[] = [];
    const args: unknown[][] = [];
    const client: Queryable = {
      async query(text: string, values?: unknown[]) {
        const t = norm(text);
        texts.push(t);
        args.push(values ?? []);
        if (t === META_QUERY) return { rowCount: 1, rows: [{ week_end_date: '2026-09-26' }] };
        if (t.startsWith('INSERT INTO keyword_top_asins_next')) return { rowCount: 5, rows: [] };
        return { rowCount: 0, rows: [] };
      },
    };
    await buildTopAsinsWeek(client, WEEK);
    return { texts, args };
  }
  it('the isolation level, the settings, the advisory lock (and its key), the lock_timeout and the meta-week read are the ones a build runs', async () => {
    const { texts, args } = await recordedBuild();
    for (const shared of [BEGIN, SET_TIMEOUT, SET_WORK_MEM, LOCK, SET_LOCK_TIMEOUT, META_QUERY]) expect(texts).toContain(shared);
    expect(args[texts.indexOf(LOCK)]).toEqual([TOP_ASINS_LOCK_KEY]);
    expect(texts).toContain(norm(finalizeStatements(WEEK).metaWeek.text));
  });
});

const ROWS: Record<string, number> = { '2026-09-19': 5, '2026-09-26': 6, '2026-10-03': 7 };

interface World {
  /** Rows each week's INSERT reports; a week absent from the map reports one row. */
  rows?: Record<string, number>;
  metaWeek?: string | null;
  /** From the Nth read of the run stamp on, another run owns the scratch tables (`stamp`: its stamp, or null for no table). */
  takeover?: { at: number; stamp: string | null };
}
/** A database that answers every statement sensibly, keeping the run stamp that setup and rotate write. */
function healthy(weeks: string[], world: World = {}): Responder {
  const rowsByWeek = world.rows ?? ROWS;
  let stamp: string | null = null;
  let stampReads = 0;
  return (text, values) => {
    if (text === WEEKS_QUERY) return answer(weeks.length, weeks.map((week) => ({ week })));
    if (text === META_QUERY) return answer(1, [{ week_end_date: world.metaWeek ?? null }]);
    const comment = text.match(/^COMMENT ON TABLE keyword_top_asins_bf IS '(.*)'$/);
    if (comment) stamp = comment[1];
    if (text === STAMP_READ) {
      stampReads += 1;
      return answer(1, [{ stamp: world.takeover && stampReads >= world.takeover.at ? world.takeover.stamp : stamp }]);
    }
    if (text.startsWith('INSERT INTO keyword_top_asins_bf (')) return answer(rowsByWeek[String(values[0])] ?? 1);
    if (text.startsWith('INSERT INTO keyword_top_asins_next SELECT')) return answer(rowsByWeek[weeks[weeks.length - 1]] ?? 1);
    return undefined;
  };
}
const failWhen = (base: Responder, pred: (text: string, values: unknown[]) => boolean, error: unknown): Responder =>
  (text, values) => (pred(text, values) ? { throws: error } : base(text, values));
/** The run's token, read from the stamp the recorded setup wrote. */
const tokenOf = (texts: string[]): string => {
  const m = texts.map((t) => t.match(/^COMMENT ON TABLE keyword_top_asins_bf IS 'backfill run (.+)'$/)).find((x) => x);
  if (!m) throw new Error('no stamp among the recorded statements');
  return m[1];
};

/** A statement's first three words (the weeks query, the meta read and the stamp read get names). */
const tag = (t: string) => (t === WEEKS_QUERY ? 'WEEKS' : t === META_QUERY ? 'META_READ' : t === STAMP_READ ? 'STAMP_READ' : t.split(' ').slice(0, 3).join(' '));
const SETUP_TX_TAGS = [BEGIN_TAG, 'SET LOCAL statement_timeout', LOCK, 'DROP TABLE IF', 'DROP TABLE IF', 'CREATE TABLE keyword_top_asins_bf', 'CREATE TABLE keyword_top_asins_bf_prev', 'CREATE INDEX keyword_top_asins_bf_prev_pair_idx', 'COMMENT ON TABLE', 'COMMIT'];
const INSERT_TX_TAGS = [BEGIN_TAG, 'SET LOCAL statement_timeout', 'SET LOCAL work_mem', LOCK, 'STAMP_READ', 'INSERT INTO keyword_top_asins_bf', 'COMMIT'];
/** A week with no rows: the same transaction, rolled back. */
const EMPTY_WEEK_TX_TAGS = [...INSERT_TX_TAGS.slice(0, -1), 'ROLLBACK'];
const ROTATE_TX_TAGS = [BEGIN_TAG, 'SET LOCAL statement_timeout', 'SET LOCAL maintenance_work_mem', LOCK, 'STAMP_READ', 'DROP TABLE IF', 'ALTER TABLE keyword_top_asins_bf', 'CREATE INDEX keyword_top_asins_bf_prev_pair_idx', 'ANALYZE keyword_top_asins_bf_prev', 'CREATE TABLE keyword_top_asins_bf', 'COMMENT ON TABLE', 'COMMIT'];
const FINALIZE_TX_TAGS = [
  BEGIN_TAG,
  'SET LOCAL statement_timeout',
  LOCK, // a running build finishes first
  'STAMP_READ', // the scratch tables must still be this run's
  'META_READ', // the meta week, read under the lock
  'DROP TABLE IF', // the old _prev
  'CREATE TABLE keyword_top_asins_prev', // from the previous week walked
  'COMMENT ON TABLE',
  'CREATE TABLE keyword_top_asins_next', // the replacement, beside the live table
  'INSERT INTO keyword_top_asins_next',
  'INSERT INTO keyword_top_asins_meta',
  'DROP TABLE keyword_top_asins_bf',
  'DROP TABLE keyword_top_asins_bf_prev',
  'SET LOCAL lock_timeout', // only now: it bounds the live table's lock wait, not the copy or the wait behind a build
  'DROP TABLE keyword_top_asins', // the swap: the live table is locked from here to COMMIT
  'ALTER TABLE keyword_top_asins_next',
  'COMMENT ON TABLE',
  'ALTER INDEX keyword_top_asins_next_asin_search_term_id_idx',
  'ALTER TABLE keyword_top_asins',
  'COMMIT',
];

describe('runBackfill', () => {
  it('refuses a Pool: one dedicated connection only', async () => {
    const pool = Object.assign(fakeClient(healthy(WEEKS)), { totalCount: 1 });
    await expect(runBackfill(pool)).rejects.toMatchObject({ code: 'top_asins_bad_client' });
    expect(pool.texts).toEqual([]);
  });

  it('throws top_asins_no_rows when kwm holds no weeks, before creating anything', async () => {
    const c = fakeClient(healthy([]));
    await expect(runBackfill(c)).rejects.toMatchObject({ code: 'top_asins_no_rows' });
    expect(c.texts).toEqual([WEEKS_QUERY]);
  });

  it('refuses a bad week list (descending here) before creating anything', async () => {
    const c = fakeClient(healthy(['2026-09-26', '2026-09-19']));
    await expect(runBackfill(c)).rejects.toMatchObject({ code: 'top_asins_bad_date' });
    expect(c.texts).toEqual([WEEKS_QUERY]);
  });

  it('walks three weeks: locked, stamped setup; per week one locked insert transaction then one locked rotate (none after the last week); then the locked swap-in', async () => {
    const c = fakeClient(healthy(WEEKS));
    const logs: string[] = [];
    const result = await runBackfill(c, { log: (l) => logs.push(l) });
    expect(result).toEqual({ weeks: 3, lastWeek: WEEK, rows: 7 });

    expect(c.texts.map(tag)).toEqual([
      'WEEKS',
      ...SETUP_TX_TAGS,
      ...INSERT_TX_TAGS, ...ROTATE_TX_TAGS, // 2026-09-19
      ...INSERT_TX_TAGS, ...ROTATE_TX_TAGS, // 2026-09-26
      ...INSERT_TX_TAGS, // 2026-10-03: the last week stays in keyword_top_asins_bf
      ...FINALIZE_TX_TAGS,
      'ANALYZE keyword_top_asins',
    ]);

    // The exact statements are the builders': the runner adds only transaction control, settings, the lock and the run check.
    const token = tokenOf(c.texts);
    expect(token).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z-[0-9a-f]{8}$/);
    const f = finalizeStatements(WEEK);
    const insertTx = (w: string) => [BEGIN, SET_TIMEOUT, SET_WORK_MEM, LOCK, STAMP_READ, norm(backfillWeekStatements(w).insert.text), 'COMMIT'];
    const rotateTx = [BEGIN, SET_TIMEOUT, SET_MAINTENANCE_WORK_MEM, LOCK, STAMP_READ, ...rotateStatements(token).map((s) => norm(s.text)), 'COMMIT'];
    expect(c.texts).toEqual([
      WEEKS_QUERY,
      BEGIN, SET_TIMEOUT, LOCK, ...backfillSetupStatements(token).map((s) => norm(s.text)), 'COMMIT',
      ...insertTx(WEEKS[0]), ...rotateTx,
      ...insertTx(WEEKS[1]), ...rotateTx,
      ...insertTx(WEEKS[2]),
      BEGIN, SET_TIMEOUT, LOCK, STAMP_READ, META_QUERY,
      ...[...f.prev, f.createNext, f.fillNext, f.meta(7), ...f.cleanup].map((s) => norm(s.text)),
      SET_LOCK_TIMEOUT,
      ...f.swap.map((s) => norm(s.text)),
      'COMMIT',
      norm(f.analyze.text),
    ]);

    // Bound values: the lock key on every locked transaction (setup, three weeks, two rotates, the swap-in), [week] on each insert, the meta row [last week, copied rows].
    const at = (pred: (t: string) => boolean) => c.texts.flatMap((t, i) => (pred(t) ? [i] : []));
    const locks = at((t) => t === LOCK);
    expect(locks).toHaveLength(7);
    for (const i of locks) expect(c.args[i]).toEqual([TOP_ASINS_LOCK_KEY]);
    expect(at((t) => t.startsWith('INSERT INTO keyword_top_asins_bf (')).map((i) => c.args[i])).toEqual(WEEKS.map((w) => [w]));
    expect(c.args[at((t) => t.startsWith('INSERT INTO keyword_top_asins_meta'))[0]]).toEqual([WEEK, 7]);

    // Nothing live is touched before the swap-in transaction (the live table stays as it was for the whole walk) ...
    const finalizeBegin = c.texts.lastIndexOf(BEGIN);
    expect(c.texts.slice(0, finalizeBegin).filter(touchesLiveSide)).toEqual([]);
    // ... and inside it the live table is named only by the swap, the last statements before COMMIT (the exclusive lock lasts that long),
    // with lock_timeout set right before them and nowhere earlier (it must not bound the copy or the wait behind a build).
    const finalizeTx = c.texts.slice(finalizeBegin, c.texts.lastIndexOf('COMMIT') + 1);
    expect(finalizeTx.filter((t) => t === 'DROP TABLE keyword_top_asins')).toHaveLength(1);
    const dropAt = finalizeTx.indexOf('DROP TABLE keyword_top_asins');
    expect(finalizeTx.slice(dropAt)).toEqual([...f.swap.map((s) => norm(s.text)), 'COMMIT']);
    expect(finalizeTx.filter((t) => t === SET_LOCK_TIMEOUT)).toEqual([SET_LOCK_TIMEOUT]);
    expect(finalizeTx[dropAt - 1]).toBe(SET_LOCK_TIMEOUT);
    expect(finalizeTx.indexOf(LOCK)).toBeLessThan(dropAt); // the advisory lock is taken before any of it

    expect(logs).toEqual([
      'listing weeks...',
      'backfill: 3 weeks, 2026-09-19 .. 2026-10-03',
      expect.stringMatching(/^week 2026-09-19 \(1\/3\): rows=5 in \d+\.\ds$/),
      expect.stringMatching(/^week 2026-09-26 \(2\/3\): rows=6 in \d+\.\ds$/),
      expect.stringMatching(/^week 2026-10-03 \(3\/3\): rows=7 in \d+\.\ds$/),
      'finalizing: building keyword_top_asins_next from week 2026-10-03, then swapping it in (a few minutes)',
      expect.stringMatching(/^finalized: keyword_top_asins = week 2026-10-03 \(7 rows\), keyword_top_asins_prev = week 2026-09-26 in \d+\.\ds$/),
    ]);
  });

  it('each run stamps its own token', async () => {
    const a = fakeClient(healthy(WEEKS));
    const b = fakeClient(healthy(WEEKS));
    await runBackfill(a);
    await runBackfill(b);
    expect(tokenOf(a.texts)).not.toBe(tokenOf(b.texts));
  });

  it('works without a log callback', async () => {
    await expect(runBackfill(fakeClient(healthy(WEEKS)))).resolves.toMatchObject({ weeks: 3, rows: 7 });
  });

  for (const meta of [null, '2026-09-26', WEEK]) {
    it(`swaps in over a live build that is not newer than the last week (meta week ${meta ?? 'none'})`, async () => {
      await expect(runBackfill(fakeClient(healthy(WEEKS, { metaWeek: meta })))).resolves.toMatchObject({ weeks: 3, lastWeek: WEEK });
    });
  }

  it('reports an ANALYZE failure after COMMIT on the result and the log, never thrown, never its message', async () => {
    const boom = Object.assign(new Error('SECRET-PAYLOAD'), { code: '57014' });
    const c = fakeClient(failWhen(healthy(WEEKS), (t) => t === 'ANALYZE keyword_top_asins', boom));
    const logs: string[] = [];
    await expect(runBackfill(c, { log: (l) => logs.push(l) })).resolves.toEqual({ weeks: 3, lastWeek: WEEK, rows: 7, analyzeError: '57014' });
    expect(c.texts.slice(-2)).toEqual(['COMMIT', 'ANALYZE keyword_top_asins']);
    expect(c.texts).not.toContain('ROLLBACK');
    expect(logs[logs.length - 1]).toBe('analyze failed after COMMIT (the replacement is committed; autovacuum covers it): code=57014');
    expect(logs.join('\n')).not.toContain('SECRET-PAYLOAD');
  });
});

describe('runBackfill: weeks with no top-3 rows', () => {
  const W4 = ['2026-09-12', '2026-09-19', '2026-09-26', '2026-10-03'];

  it('a mid-walk week with no rows is skipped, not fatal: no rotate, the log says so, the next week carries across it', async () => {
    const c = fakeClient(healthy(W4, { rows: { '2026-09-12': 4, '2026-09-19': 0, '2026-09-26': 6, '2026-10-03': 7 } }));
    const logs: string[] = [];
    const result = await runBackfill(c, { log: (l) => logs.push(l) });
    expect(result).toEqual({ weeks: 4, lastWeek: '2026-10-03', rows: 7, skipped: ['2026-09-19'] });
    expect(c.texts.map(tag)).toEqual([
      'WEEKS',
      ...SETUP_TX_TAGS,
      ...INSERT_TX_TAGS, ...ROTATE_TX_TAGS, // 2026-09-12
      ...EMPTY_WEEK_TX_TAGS, // 2026-09-19: rolled back, and no rotate after it
      ...INSERT_TX_TAGS, ...ROTATE_TX_TAGS, // 2026-09-26 carries from 2026-09-12
      ...INSERT_TX_TAGS, // 2026-10-03
      ...FINALIZE_TX_TAGS,
      'ANALYZE keyword_top_asins',
    ]);
    expect(logs).toContain('week 2026-09-19: no top-3 rows, skipped (streaks carry across it)');
    expect(logs.filter((l) => l.startsWith('week 2026-09-19'))).toHaveLength(1); // no progress line for it
    // _prev ends as the previous week walked (2026-09-26), not the week before the last in the list.
    expect(logs[logs.length - 1]).toMatch(/keyword_top_asins_prev = week 2026-09-26 in /);
  });

  it('skips several, and the first week too', async () => {
    const c = fakeClient(healthy(W4, { rows: { '2026-09-12': 0, '2026-09-19': 0, '2026-09-26': 6, '2026-10-03': 7 } }));
    const logs: string[] = [];
    await expect(runBackfill(c, { log: (l) => logs.push(l) })).resolves.toEqual({ weeks: 4, lastWeek: '2026-10-03', rows: 7, skipped: ['2026-09-12', '2026-09-19'] });
    expect(logs).toContain('week 2026-09-12: no top-3 rows, skipped (streaks carry across it)');
    expect(logs).toContain('week 2026-09-19: no top-3 rows, skipped (streaks carry across it)');
    expect(c.texts.filter((t) => t.startsWith('ALTER TABLE keyword_top_asins_bf RENAME'))).toHaveLength(1); // only 2026-09-26 rotates
  });

  it('the LAST week with no rows is still a hard stop (top_asins_no_rows): rolled back, nothing swapped in', async () => {
    const c = fakeClient(healthy(W4, { rows: { '2026-09-12': 4, '2026-09-19': 5, '2026-09-26': 6, '2026-10-03': 0 } }));
    const logs: string[] = [];
    await expect(runBackfill(c, { log: (l) => logs.push(l) })).rejects.toMatchObject({ code: 'top_asins_no_rows' });
    expect(c.texts[c.texts.length - 1]).toBe('ROLLBACK');
    expect(c.texts.slice(c.texts.indexOf('COMMIT') + 1).filter(touchesLiveSide)).toEqual([]);
    expect(logs[logs.length - 1]).toBe('backfill failed: stage=insert week=2026-10-03 (4/4) code=top_asins_no_rows; scratch tables kept (a re-run starts over)');
    expect(logs.filter((l) => l.includes('skipped'))).toEqual([]);
  });

  it('a single week with no rows is the last week: a hard stop', async () => {
    const c = fakeClient(healthy([WEEK], { rows: { [WEEK]: 0 } }));
    await expect(runBackfill(c)).rejects.toMatchObject({ code: 'top_asins_no_rows' });
  });
});

describe('runBackfill: another run on the same scratch tables', () => {
  const OTHER = 'backfill run 2026-10-09T18:00:00.000Z-feedbeef';
  async function run(world: World) {
    const c = fakeClient(healthy(WEEKS, world));
    const logs: string[] = [];
    const outcome = await runBackfill(c, { log: (l) => logs.push(l) }).then(() => null, (e: unknown) => e);
    return { c, logs, outcome };
  }
  const OWNED = '; another run owns the scratch tables; let it finish';

  // Stamp reads in a three-week run: insert 1, rotate 1, insert 2, rotate 2, insert 3, swap-in.
  it('stops at the first insert when the stamp is not its own: nothing is written', async () => {
    const { c, logs, outcome } = await run({ takeover: { at: 1, stamp: OTHER } });
    expect(outcome).toMatchObject({ code: 'top_asins_run_conflict' });
    expect(outcome).toBeInstanceOf(TopAsinsBuildError);
    expect(c.texts.slice(c.texts.lastIndexOf(BEGIN))).toEqual([BEGIN, SET_TIMEOUT, SET_WORK_MEM, LOCK, STAMP_READ, 'ROLLBACK']);
    expect(logs[logs.length - 1]).toBe(`backfill failed: stage=insert week=2026-09-19 (1/3) code=top_asins_run_conflict${OWNED}`);
  });

  it('stops at a rotate before it renames anything (it would shuffle the other run\'s tables)', async () => {
    const { c, logs, outcome } = await run({ takeover: { at: 2, stamp: OTHER } });
    expect(outcome).toMatchObject({ code: 'top_asins_run_conflict' });
    expect(c.texts.slice(c.texts.lastIndexOf(BEGIN))).toEqual([BEGIN, SET_TIMEOUT, SET_MAINTENANCE_WORK_MEM, LOCK, STAMP_READ, 'ROLLBACK']);
    expect(c.texts.filter((t) => t.startsWith('ALTER TABLE'))).toEqual([]);
    expect(logs[logs.length - 1]).toBe(`backfill failed: stage=rotate week=2026-09-19 (1/3) code=top_asins_run_conflict${OWNED}`);
  });

  it('stops at the swap-in before it reads the meta row or touches the live side (it would install the other run\'s streaks)', async () => {
    const { c, logs, outcome } = await run({ takeover: { at: 6, stamp: OTHER } });
    expect(outcome).toMatchObject({ code: 'top_asins_run_conflict' });
    expect(c.texts.slice(c.texts.lastIndexOf(BEGIN))).toEqual([BEGIN, SET_TIMEOUT, LOCK, STAMP_READ, 'ROLLBACK']);
    expect(logs[logs.length - 1]).toBe(`backfill failed: stage=finalize code=top_asins_run_conflict${OWNED}`);
  });

  it('a dropped _bf (no table, so no stamp) reads as a conflict too, not as an error of its own', async () => {
    const { outcome } = await run({ takeover: { at: 3, stamp: null } });
    expect(outcome).toMatchObject({ code: 'top_asins_run_conflict' });
  });
});

describe('runBackfill: where each week ends up', () => {
  /**
   * Tracks which week each table holds, and each table's comment, by parsing the runner's statements. A statement on a
   * table that does not exist throws like the database would, a renamed table takes its comment along, and a statement
   * the model does not know fails the test, so a dropped, missing or unexpected statement cannot pass quietly.
   */
  function tableModel(rowsByWeek: Record<string, number> = {}) {
    const tables = new Map<string, string | null>([
      ['keyword_top_asins', 'before-backfill'],
      ['keyword_top_asins_prev', 'older'],
    ]);
    const comments = new Map<string, string>();
    const carries: (string | null)[] = []; // what keyword_top_asins_bf_prev held at each walked week's insert
    let metaWeek: string | null = null;
    const held = (name: string): string | null => {
      if (!tables.has(name)) throw Object.assign(new Error(`relation "${name}" does not exist`), { code: '42P01' });
      return tables.get(name) ?? null;
    };
    const taken = (name: string) => {
      if (tables.has(name)) throw Object.assign(new Error(`relation "${name}" already exists`), { code: '42P07' });
    };
    const drop = (name: string) => {
      tables.delete(name);
      comments.delete(name);
    };
    const rules: [RegExp, (m: RegExpMatchArray, values: unknown[]) => Answer | undefined][] = [
      [/^CREATE TABLE (\w+) \(LIKE keyword_top_asins INCLUDING (?:DEFAULTS|ALL)\)$/, (m) => { taken(m[1]); tables.set(m[1], null); return undefined; }],
      [/^CREATE INDEX \w+ ON (\w+) /, (m) => { held(m[1]); return undefined; }],
      [/^DROP TABLE IF EXISTS (\w+)$/, (m) => { drop(m[1]); return undefined; }],
      [/^DROP TABLE (\w+)$/, (m) => { held(m[1]); drop(m[1]); return undefined; }],
      [/^ANALYZE (\w+)$/, (m) => { held(m[1]); return undefined; }],
      [/^ALTER TABLE (\w+) RENAME TO (\w+)$/, (m) => {
        const label = held(m[1]);
        taken(m[2]);
        const comment = comments.get(m[1]);
        drop(m[1]);
        tables.set(m[2], label);
        if (comment !== undefined) comments.set(m[2], comment);
        return undefined;
      }],
      [/^ALTER TABLE (\w+) RENAME CONSTRAINT /, (m) => { held(m[1]); return undefined; }],
      [/^ALTER INDEX \w+ RENAME TO \w+$/, () => undefined],
      [/^COMMENT ON TABLE (\w+) IS '(.*)'$/, (m) => { held(m[1]); comments.set(m[1], m[2]); return undefined; }],
      [/^INSERT INTO keyword_top_asins_bf \(/, (_m, v) => {
        const rows = rowsByWeek[String(v[0])] ?? 1;
        if (rows > 0) {
          carries.push(held('keyword_top_asins_bf_prev'));
          held('keyword_top_asins_bf');
          tables.set('keyword_top_asins_bf', String(v[0]));
        }
        return answer(rows);
      }],
      [/^INSERT INTO (\w+) SELECT \* FROM (\w+)$/, (m) => { held(m[1]); tables.set(m[1], held(m[2])); return answer(1); }],
      [/^CREATE TABLE (\w+) AS SELECT \* FROM (\w+)$/, (m) => { taken(m[1]); tables.set(m[1], held(m[2])); return undefined; }],
      [/^INSERT INTO keyword_top_asins_meta /, (_m, v) => { metaWeek = String(v[0]); return undefined; }],
    ];
    const control = (t: string) => t === BEGIN || t === 'COMMIT' || t === 'ROLLBACK' || t.startsWith('SET LOCAL ') || t === LOCK;
    const respond = (weeks: string[]): Responder => (text, values) => {
      if (text === WEEKS_QUERY) return answer(weeks.length, weeks.map((week) => ({ week })));
      if (text === META_QUERY) return answer(1, [{ week_end_date: null }]);
      if (text === STAMP_READ) return answer(1, [{ stamp: tables.has('keyword_top_asins_bf') ? comments.get('keyword_top_asins_bf') ?? null : null }]);
      if (control(text)) return undefined;
      for (const [re, apply] of rules) {
        const m = text.match(re);
        if (m) return apply(m, values);
      }
      throw new Error(`the table model does not know: ${text.slice(0, 90)}`);
    };
    return { tables, comments, carries, respond, metaWeek: () => metaWeek };
  }
  /** n consecutive Saturdays from 2025-04-19; n = 77 ends on 2026-10-03, across both partitions. */
  const saturdays = (n: number) => Array.from({ length: n }, (_, i) => new Date(Date.UTC(2025, 3, 19 + 7 * i)).toISOString().slice(0, 10));

  it('the 77 weeks of the spec end on 2026-10-03', () => {
    expect(saturdays(77)[76]).toBe('2026-10-03');
  });

  for (const n of [1, 2, 3, 77]) {
    it(`${n} week${n === 1 ? '' : 's'}: each week carries from the one before it, the live table ends on the last, _prev on the one before, no scratch or _next left`, async () => {
      const weeks = saturdays(n);
      const m = tableModel();
      await expect(runBackfill(fakeClient(m.respond(weeks)))).resolves.toMatchObject({ weeks: n, lastWeek: weeks[n - 1] });
      expect(m.carries).toEqual([null, ...weeks.slice(0, -1)]); // the first week carries from nothing
      expect(m.tables.get('keyword_top_asins')).toBe(weeks[n - 1]);
      expect(m.tables.get('keyword_top_asins_prev')).toBe(n > 1 ? weeks[n - 2] : null);
      expect([...m.tables.keys()].sort()).toEqual(['keyword_top_asins', 'keyword_top_asins_prev']);
      expect([...m.comments.keys()].sort()).toEqual(['keyword_top_asins', 'keyword_top_asins_prev']); // the swap's table comments only ...
      expect([...m.comments.values()].filter((c) => c.startsWith('backfill run'))).toEqual([]); // ... the run stamps went with the scratch tables
      expect(m.metaWeek()).toBe(weeks[n - 1]);
    });
  }

  it('weeks that are not consecutive (a missing import week) carry from the previous week walked, whatever the gap', async () => {
    const weeks = ['2025-04-19', '2025-06-14', '2025-12-27', '2026-01-17', '2026-10-03'];
    const m = tableModel();
    await expect(runBackfill(fakeClient(m.respond(weeks)))).resolves.toMatchObject({ weeks: 5, lastWeek: '2026-10-03' });
    expect(m.carries).toEqual([null, '2025-04-19', '2025-06-14', '2025-12-27', '2026-01-17']);
    expect(m.tables.get('keyword_top_asins')).toBe('2026-10-03');
    expect(m.tables.get('keyword_top_asins_prev')).toBe('2026-01-17');
  });

  it('a skipped mid-walk week: the weeks after it carry from the last week walked, and _prev is that week', async () => {
    const weeks = saturdays(5);
    const m = tableModel({ [weeks[1]]: 0, [weeks[3]]: 0 });
    await expect(runBackfill(fakeClient(m.respond(weeks)))).resolves.toEqual({ weeks: 5, lastWeek: weeks[4], rows: 1, skipped: [weeks[1], weeks[3]] });
    expect(m.carries).toEqual([null, weeks[0], weeks[2]]); // weeks[0] walked, [1] skipped, [2] carries from [0], [3] skipped, [4] carries from [2]
    expect(m.tables.get('keyword_top_asins')).toBe(weeks[4]);
    expect(m.tables.get('keyword_top_asins_prev')).toBe(weeks[2]);
    expect([...m.tables.keys()].sort()).toEqual(['keyword_top_asins', 'keyword_top_asins_prev']);
  });

  it('when every week before the last is empty, the last week carries from nothing and _prev is empty', async () => {
    const weeks = saturdays(3);
    const m = tableModel({ [weeks[0]]: 0, [weeks[1]]: 0 });
    const logs: string[] = [];
    await expect(runBackfill(fakeClient(m.respond(weeks)), { log: (l) => logs.push(l) })).resolves.toMatchObject({ weeks: 3, skipped: [weeks[0], weeks[1]] });
    expect(m.carries).toEqual([null]);
    expect(m.tables.get('keyword_top_asins')).toBe(weeks[2]);
    expect(m.tables.get('keyword_top_asins_prev')).toBeNull();
    expect(logs[logs.length - 1]).toMatch(/keyword_top_asins_prev = empty \(no earlier week walked\) in /);
  });

  it('a single week never rotates', async () => {
    const c = fakeClient(healthy([WEEK], { rows: ROWS }));
    await runBackfill(c);
    expect(c.texts.filter((t) => t.startsWith('ALTER TABLE keyword_top_asins_bf RENAME') || t.startsWith('TRUNCATE'))).toEqual([]);
  });
});

describe('runBackfill: failures (coded log lines, original error rethrown, scratch tables kept, live table untouched)', () => {
  const boom = Object.assign(new Error('relation "secret_table" holds SECRET-PAYLOAD'), { code: '57014' });
  async function run(respond: Responder) {
    const c = fakeClient(respond);
    const logs: string[] = [];
    const outcome = await runBackfill(c, { log: (l) => logs.push(l) }).then(() => null, (e: unknown) => e);
    return { c, logs, outcome };
  }
  const afterSetup = (texts: string[]) => texts.slice(texts.indexOf('COMMIT') + 1);
  const KEPT = '; scratch tables kept (a re-run starts over)';
  const lastTx = (texts: string[]) => texts.slice(texts.lastIndexOf(BEGIN));

  it('a failing weeks query fails at stage=weeks with nothing created', async () => {
    const { c, logs, outcome } = await run(failWhen(healthy(WEEKS), (t) => t === WEEKS_QUERY, boom));
    expect(outcome).toBe(boom);
    expect(c.texts).toEqual([WEEKS_QUERY]);
    expect(logs).toEqual(['listing weeks...', 'backfill failed: stage=weeks code=57014']);
  });

  it('a failing setup rolls back and fails at stage=setup', async () => {
    const { c, logs, outcome } = await run(failWhen(healthy(WEEKS), (t) => t.startsWith('CREATE TABLE keyword_top_asins_bf_prev'), boom));
    expect(outcome).toBe(boom);
    expect(c.texts[c.texts.length - 1]).toBe('ROLLBACK');
    expect(logs).toEqual(['listing weeks...', 'backfill: 3 weeks, 2026-09-19 .. 2026-10-03', 'backfill failed: stage=setup code=57014']);
  });

  it('a failing insert (week 2) rolls back, rethrows the original error, and logs only its code', async () => {
    const { c, logs, outcome } = await run(failWhen(healthy(WEEKS), (t, v) => t.startsWith('INSERT INTO keyword_top_asins_bf (') && v[0] === WEEKS[1], boom));
    expect(outcome).toBe(boom);
    expect(c.texts[c.texts.length - 1]).toBe('ROLLBACK');
    expect(c.texts.filter((t) => t === 'COMMIT')).toHaveLength(3); // setup, week 1's insert, week 1's rotate
    expect(afterSetup(c.texts).filter(touchesLiveSide)).toEqual([]);
    expect(logs[logs.length - 1]).toBe(`backfill failed: stage=insert week=2026-09-26 (2/3) code=57014${KEPT}`);
    expect(logs.join('\n')).not.toMatch(/SECRET|secret_table/);
  });

  it('a failing rotate (week 1) rolls back and fails at stage=rotate', async () => {
    const { c, logs, outcome } = await run(failWhen(healthy(WEEKS), (t) => t.startsWith('ALTER TABLE keyword_top_asins_bf RENAME'), boom));
    expect(outcome).toBe(boom);
    expect(c.texts[c.texts.length - 1]).toBe('ROLLBACK');
    expect(afterSetup(c.texts).filter(touchesLiveSide)).toEqual([]);
    expect(logs[logs.length - 1]).toBe(`backfill failed: stage=rotate week=2026-09-19 (1/3) code=57014${KEPT}`);
  });

  it('the swap-in refuses to replace a NEWER build (an import landed during the run): nothing built, rolled back, scratch kept, top_asins_older_than_meta', async () => {
    const { c, logs, outcome } = await run(healthy(WEEKS, { metaWeek: '2026-10-10' }));
    expect(outcome).toMatchObject({ code: 'top_asins_older_than_meta' });
    expect(lastTx(c.texts)).toEqual([BEGIN, SET_TIMEOUT, LOCK, STAMP_READ, META_QUERY, 'ROLLBACK']);
    expect(logs[logs.length - 1]).toBe(`backfill failed: stage=finalize code=top_asins_older_than_meta${KEPT}`);
  });

  it('a failing fill of the replacement rolls the whole swap-in back (the old _prev drop with it); the live table was never dropped', async () => {
    const { c, logs, outcome } = await run(failWhen(healthy(WEEKS), (t) => t.startsWith('INSERT INTO keyword_top_asins_next SELECT'), boom));
    expect(outcome).toBe(boom);
    const tx = lastTx(c.texts);
    expect(tx[tx.length - 1]).toBe('ROLLBACK');
    expect(tx).toContain('DROP TABLE IF EXISTS keyword_top_asins_prev'); // ran inside the transaction that was rolled back
    expect(tx).not.toContain('DROP TABLE keyword_top_asins');
    expect(tx).not.toContain('COMMIT');
    expect(c.texts).not.toContain('ANALYZE keyword_top_asins');
    expect(logs[logs.length - 1]).toBe(`backfill failed: stage=finalize code=57014${KEPT}`);
  });

  it('a replacement of zero rows rolls the swap-in back before the live table is dropped (top_asins_no_rows)', async () => {
    const base = healthy(WEEKS);
    const { c, outcome } = await run((t, v) => (t.startsWith('INSERT INTO keyword_top_asins_next SELECT') ? answer(0) : base(t, v)));
    expect(outcome).toMatchObject({ code: 'top_asins_no_rows' });
    const tx = lastTx(c.texts);
    expect(tx[tx.length - 1]).toBe('ROLLBACK');
    expect(tx).not.toContain('DROP TABLE keyword_top_asins');
  });

  it('a lock timeout at the live DROP (55P03) rolls the swap-in back, scratch drops included; nothing commits or analyzes', async () => {
    const lockTimeout = Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
    const { c, logs, outcome } = await run(failWhen(healthy(WEEKS), (t) => t === 'DROP TABLE keyword_top_asins', lockTimeout));
    expect(outcome).toBe(lockTimeout);
    const tx = lastTx(c.texts);
    expect(tx[tx.length - 1]).toBe('ROLLBACK');
    expect(tx).toContain('DROP TABLE keyword_top_asins_bf'); // rolled back with everything else, so the scratch tables survive
    expect(tx).not.toContain('COMMIT');
    expect(c.texts).not.toContain('ANALYZE keyword_top_asins');
    expect(logs[logs.length - 1]).toBe(`backfill failed: stage=finalize code=55P03${KEPT}`);
  });
});
