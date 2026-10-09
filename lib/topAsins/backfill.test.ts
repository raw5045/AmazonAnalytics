// lib/topAsins/backfill.test.ts
import { describe, it, expect } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { keywordTopAsins, keywordWeeklyMetrics } from '@/db/schema';
import { buildTopAsinsStatements, TOP_ASINS_LOCK_KEY, TopAsinsBuildError, type Queryable } from './buildWeek';
import {
  KWM_PARTITIONS,
  assertBackfillWeeks,
  backfillSetupStatements,
  backfillWeekStatements,
  finalizeStatements,
  rotateStatements,
  runBackfill,
  weeksSql,
} from './backfill';

const dbCols = (t: Parameters<typeof getTableColumns>[0]) => new Set(Object.values(getTableColumns(t)).map((c) => c.name));
/** A statement's text with its whitespace collapsed (the builders' templates are indented). */
const norm = (s: string) => s.trim().replace(/\s+/g, ' ');
const WEEK = '2026-10-03';
const WEEKS = ['2026-09-19', '2026-09-26', '2026-10-03'];
const CARRY_COLS = ['search_term_id', 'asin', 'weeks_in_top3', 'streak_started_week'];
/** The live table's bare name (not _next, _prev, _bf or _meta). */
const LIVE = /\bkeyword_top_asins\b/;

/** The build's own swap statements for a plan (the backfill's swap and comments must stay in step with them). */
const buildSwapOf = (plan: Parameters<typeof buildTopAsinsStatements>[1]) => buildTopAsinsStatements(WEEK, plan).swap.map((s) => norm(s.text));

describe('weeksSql', () => {
  it('lists the distinct weeks of every listed kwm partition, as ISO text, ascending', () => {
    expect(KWM_PARTITIONS).toEqual(['keyword_weekly_metrics_2025', 'keyword_weekly_metrics_2026']);
    expect(norm(weeksSql())).toBe(
      'SELECT week_end_date::text AS week FROM ( SELECT DISTINCT week_end_date FROM keyword_weekly_metrics_2025 UNION SELECT DISTINCT week_end_date FROM keyword_weekly_metrics_2026 ) w ORDER BY 1',
    );
    expect(dbCols(keywordWeeklyMetrics).has('week_end_date')).toBe(true);
  });
});

describe('backfillSetupStatements', () => {
  const setup = backfillSetupStatements().map((s) => norm(s.text));
  it('drops, then recreates, the two scratch tables shaped like the live table (defaults only: no key, no checks), and indexes the carry source', () => {
    expect(setup).toEqual([
      'DROP TABLE IF EXISTS keyword_top_asins_bf',
      'DROP TABLE IF EXISTS keyword_top_asins_bf_prev',
      'CREATE TABLE keyword_top_asins_bf (LIKE keyword_top_asins INCLUDING DEFAULTS)',
      'CREATE TABLE keyword_top_asins_bf_prev (LIKE keyword_top_asins INCLUDING DEFAULTS)',
      'CREATE INDEX keyword_top_asins_bf_prev_pair_idx ON keyword_top_asins_bf_prev (search_term_id, asin)',
    ]);
  });
  it('never writes the live table (it is only the LIKE source) and binds no values', () => {
    for (const st of backfillSetupStatements()) {
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
  it('moves the built week into _bf_prev (then refreshes its statistics for the next carry), and empties _bf', () => {
    expect(rotateStatements().map((s) => norm(s.text))).toEqual([
      'TRUNCATE keyword_top_asins_bf_prev',
      'INSERT INTO keyword_top_asins_bf_prev SELECT * FROM keyword_top_asins_bf',
      'ANALYZE keyword_top_asins_bf_prev',
      'TRUNCATE keyword_top_asins_bf',
    ]);
  });
  it('never touches the live table', () => {
    for (const st of rotateStatements()) expect(st.text).not.toMatch(LIVE);
  });
});

describe('finalizeStatements', () => {
  const f = finalizeStatements(WEEK);
  it('reads the meta week with the same statement a build uses', () => {
    expect(f.metaWeek.text).toBe('SELECT week_end_date::text AS week_end_date FROM keyword_top_asins_meta WHERE singleton');
  });
  it('builds the replacement beside the live table, like a build, and fills it from the LAST week (still in _bf: the last week is never rotated)', () => {
    expect(norm(f.createNext.text)).toBe(norm(buildTopAsinsStatements(WEEK).createNext.text));
    expect(norm(f.createNext.text)).toBe('CREATE TABLE keyword_top_asins_next (LIKE keyword_top_asins INCLUDING ALL)');
    expect(norm(f.fillNext.text)).toBe('INSERT INTO keyword_top_asins_next SELECT * FROM keyword_top_asins_bf');
  });
  it("keeps the week before it as keyword_top_asins_prev: the old one dropped, the new one made from _bf_prev's four carry columns, with the comment a build gives it", () => {
    const buildComment = buildSwapOf(undefined).find((t) => t.startsWith('COMMENT ON TABLE keyword_top_asins_prev'));
    expect(buildComment).toBeDefined();
    expect(f.prev.map((s) => norm(s.text))).toEqual([
      'DROP TABLE IF EXISTS keyword_top_asins_prev',
      `CREATE TABLE keyword_top_asins_prev AS SELECT ${CARRY_COLS.join(', ')} FROM keyword_top_asins_bf_prev`,
      buildComment,
    ]);
    expect(CARRY_COLS.filter((c) => !dbCols(keywordTopAsins).has(c))).toEqual([]);
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
  it('accepts ascending distinct weeks across both listed partitions', () => {
    expect(() => assertBackfillWeeks(['2025-04-19', '2025-12-27', '2026-01-03', '2026-10-03'])).not.toThrow();
    expect(() => assertBackfillWeeks([WEEK])).not.toThrow();
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
  it('refuses a week outside the listed partitions (extend KWM_PARTITIONS when a later year has weeks)', () => {
    expect(() => assertBackfillWeeks(['2026-12-26', '2027-01-02'])).toThrowError(expect.objectContaining({ code: 'top_asins_bad_date' }));
    expect(() => assertBackfillWeeks(['2024-12-28'])).toThrow(TopAsinsBuildError);
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

const ROWS: Record<string, number> = { '2026-09-19': 5, '2026-09-26': 6, '2026-10-03': 7 };
const WEEKS_QUERY = norm(weeksSql());
const META_QUERY = 'SELECT week_end_date::text AS week_end_date FROM keyword_top_asins_meta WHERE singleton';
const SET_TIMEOUT = "SET LOCAL statement_timeout = '1800s'";
const SET_WORK_MEM = "SET LOCAL work_mem = '256MB'";
const SET_LOCK_TIMEOUT = "SET LOCAL lock_timeout = '120s'";
const BEGIN = 'BEGIN ISOLATION LEVEL READ COMMITTED';
const BEGIN_TAG = 'BEGIN ISOLATION LEVEL'; // its first three words
const LOCK = 'SELECT pg_advisory_xact_lock($1)';

/** A database that answers every statement sensibly: the weeks, the meta week, each week's insert row count, the replacement's. */
function healthy(weeks: string[], rowsByWeek: Record<string, number> = ROWS, metaWeek: string | null = null): Responder {
  return (text, values) => {
    if (text === WEEKS_QUERY) return answer(weeks.length, weeks.map((week) => ({ week })));
    if (text === META_QUERY) return answer(1, [{ week_end_date: metaWeek }]);
    if (text.startsWith('INSERT INTO keyword_top_asins_bf (')) return answer(rowsByWeek[String(values[0])] ?? 0);
    if (text.startsWith('INSERT INTO keyword_top_asins_next SELECT')) return answer(rowsByWeek[weeks[weeks.length - 1]] ?? 0);
    return undefined;
  };
}
const failWhen = (base: Responder, pred: (text: string, values: unknown[]) => boolean, error: unknown): Responder =>
  (text, values) => (pred(text, values) ? { throws: error } : base(text, values));

/** A statement's first three words. */
const tag = (t: string) => t.split(' ').slice(0, 3).join(' ');
const META_TAG = 'SELECT week_end_date::text AS'; // the weeks query and the meta-week read start alike
const SETUP_TAGS = [BEGIN_TAG, 'DROP TABLE IF', 'DROP TABLE IF', 'CREATE TABLE keyword_top_asins_bf', 'CREATE TABLE keyword_top_asins_bf_prev', 'CREATE INDEX keyword_top_asins_bf_prev_pair_idx', 'COMMIT'];
const INSERT_TX_TAGS = [BEGIN_TAG, 'SET LOCAL statement_timeout', 'SET LOCAL work_mem', LOCK, 'INSERT INTO keyword_top_asins_bf', 'COMMIT'];
const ROTATE_TX_TAGS = [BEGIN_TAG, 'SET LOCAL statement_timeout', 'TRUNCATE keyword_top_asins_bf_prev', 'INSERT INTO keyword_top_asins_bf_prev', 'ANALYZE keyword_top_asins_bf_prev', 'TRUNCATE keyword_top_asins_bf', 'COMMIT'];
const FINALIZE_TX_TAGS = [
  BEGIN_TAG,
  'SET LOCAL statement_timeout',
  LOCK, // a running build finishes first
  META_TAG, // the meta week, read under the lock
  'DROP TABLE IF', // the old _prev
  'CREATE TABLE keyword_top_asins_prev', // from the week before the last
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

  it('walks three weeks: setup, per week one locked insert transaction then one rotate transaction (none after the last week), then the locked swap-in', async () => {
    const c = fakeClient(healthy(WEEKS));
    const logs: string[] = [];
    const result = await runBackfill(c, { log: (l) => logs.push(l) });
    expect(result).toEqual({ weeks: 3, lastWeek: WEEK, rows: 7 });

    expect(c.texts.map(tag)).toEqual([
      META_TAG, // the weeks
      ...SETUP_TAGS,
      ...INSERT_TX_TAGS, ...ROTATE_TX_TAGS, // 2026-09-19
      ...INSERT_TX_TAGS, ...ROTATE_TX_TAGS, // 2026-09-26
      ...INSERT_TX_TAGS, // 2026-10-03: the last week stays in keyword_top_asins_bf
      ...FINALIZE_TX_TAGS,
      'ANALYZE keyword_top_asins',
    ]);

    // The exact statements are the builders': the runner adds only transaction control and settings.
    const f = finalizeStatements(WEEK);
    const insertTx = (w: string) => [BEGIN, SET_TIMEOUT, SET_WORK_MEM, LOCK, norm(backfillWeekStatements(w).insert.text), 'COMMIT'];
    const rotateTx = [BEGIN, SET_TIMEOUT, ...rotateStatements().map((s) => norm(s.text)), 'COMMIT'];
    expect(c.texts).toEqual([
      WEEKS_QUERY,
      BEGIN, ...backfillSetupStatements().map((s) => norm(s.text)), 'COMMIT',
      ...insertTx(WEEKS[0]), ...rotateTx,
      ...insertTx(WEEKS[1]), ...rotateTx,
      ...insertTx(WEEKS[2]),
      BEGIN, SET_TIMEOUT, LOCK, META_QUERY,
      ...[...f.prev, f.createNext, f.fillNext, f.meta(7), ...f.cleanup].map((s) => norm(s.text)),
      SET_LOCK_TIMEOUT,
      ...f.swap.map((s) => norm(s.text)),
      'COMMIT',
      norm(f.analyze.text),
    ]);

    // Bound values: the lock key on every locked transaction (three weeks + the swap-in), [week] on each insert, the meta row [last week, copied rows].
    const at = (pred: (t: string) => boolean) => c.texts.flatMap((t, i) => (pred(t) ? [i] : []));
    const locks = at((t) => t === LOCK);
    expect(locks).toHaveLength(4);
    for (const i of locks) expect(c.args[i]).toEqual([TOP_ASINS_LOCK_KEY]);
    expect(at((t) => t.startsWith('INSERT INTO keyword_top_asins_bf (')).map((i) => c.args[i])).toEqual(WEEKS.map((w) => [w]));
    expect(c.args[at((t) => t.startsWith('INSERT INTO keyword_top_asins_meta'))[0]]).toEqual([WEEK, 7]);

    // Nothing live is touched before the swap-in transaction (the live table stays as it was for the whole walk) ...
    const finalizeBegin = c.texts.lastIndexOf(BEGIN);
    const beforeFinalize = c.texts.slice(0, finalizeBegin).map((t) => t.replace('LIKE keyword_top_asins ', ''));
    expect(beforeFinalize.filter((t) => LIVE.test(t) || t.includes('keyword_top_asins_next') || t.includes('keyword_top_asins_prev'))).toEqual([]);
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
      'backfill: 3 weeks, 2026-09-19 .. 2026-10-03',
      expect.stringMatching(/^week 2026-09-19 \(1\/3\): rows=5 in \d+\.\ds$/),
      expect.stringMatching(/^week 2026-09-26 \(2\/3\): rows=6 in \d+\.\ds$/),
      expect.stringMatching(/^week 2026-10-03 \(3\/3\): rows=7 in \d+\.\ds$/),
      'finalizing: building keyword_top_asins_next from week 2026-10-03, then swapping it in (a few minutes)',
      expect.stringMatching(/^finalized: keyword_top_asins = week 2026-10-03 \(7 rows\), keyword_top_asins_prev = week 2026-09-26 in \d+\.\ds$/),
    ]);
  });

  it('works without a log callback', async () => {
    await expect(runBackfill(fakeClient(healthy(WEEKS)))).resolves.toMatchObject({ weeks: 3, rows: 7 });
  });

  for (const meta of [null, '2026-09-26', WEEK]) {
    it(`swaps in over a live build that is not newer than the last week (meta week ${meta ?? 'none'})`, async () => {
      await expect(runBackfill(fakeClient(healthy(WEEKS, ROWS, meta)))).resolves.toMatchObject({ weeks: 3, lastWeek: WEEK });
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

describe('runBackfill: where each week ends up', () => {
  /**
   * Tracks which week each table holds by parsing the runner's statements. A statement on a table that does not
   * exist throws like the database would, so a dropped or never-created table fails the run.
   */
  function tableModel() {
    const tables = new Map<string, string | null>([
      ['keyword_top_asins', 'before-backfill'],
      ['keyword_top_asins_prev', 'older'],
    ]);
    const carries: (string | null)[] = []; // what keyword_top_asins_bf_prev held at each week's insert
    let metaWeek: string | null = null;
    const held = (name: string): string | null => {
      if (!tables.has(name)) throw Object.assign(new Error(`relation "${name}" does not exist`), { code: '42P01' });
      return tables.get(name) ?? null;
    };
    const rules: [RegExp, (m: RegExpMatchArray, values: unknown[]) => Answer | undefined][] = [
      [/^CREATE TABLE (\w+) \(LIKE keyword_top_asins INCLUDING (?:DEFAULTS|ALL)\)$/, (m) => { if (tables.has(m[1])) throw new Error(`relation "${m[1]}" already exists`); tables.set(m[1], null); return undefined; }],
      [/^CREATE INDEX \w+ ON (\w+) /, (m) => { held(m[1]); return undefined; }],
      [/^DROP TABLE IF EXISTS (\w+)$/, (m) => { tables.delete(m[1]); return undefined; }],
      [/^DROP TABLE (\w+)$/, (m) => { held(m[1]); tables.delete(m[1]); return undefined; }],
      [/^TRUNCATE (\w+)$/, (m) => { held(m[1]); tables.set(m[1], null); return undefined; }],
      [/^ANALYZE (\w+)$/, (m) => { held(m[1]); return undefined; }],
      [/^ALTER TABLE (\w+) RENAME TO (\w+)$/, (m) => {
        const label = held(m[1]);
        if (tables.has(m[2])) throw new Error(`relation "${m[2]}" already exists`);
        tables.delete(m[1]);
        tables.set(m[2], label);
        return undefined;
      }],
      [/^ALTER TABLE (\w+) RENAME CONSTRAINT /, (m) => { held(m[1]); return undefined; }],
      [/^COMMENT ON TABLE (\w+) IS /, (m) => { held(m[1]); return undefined; }],
      [/^INSERT INTO keyword_top_asins_bf \(/, (_m, v) => {
        carries.push(held('keyword_top_asins_bf_prev'));
        held('keyword_top_asins_bf');
        tables.set('keyword_top_asins_bf', String(v[0]));
        return answer(1);
      }],
      [/^INSERT INTO (\w+) SELECT \* FROM (\w+)$/, (m) => { held(m[1]); tables.set(m[1], held(m[2])); return answer(1); }],
      [/^CREATE TABLE (\w+) AS SELECT .+ FROM (\w+)$/, (m) => { tables.set(m[1], held(m[2])); return undefined; }],
      [/^INSERT INTO keyword_top_asins_meta /, (_m, v) => { metaWeek = String(v[0]); return undefined; }],
    ];
    const respond = (weeks: string[]): Responder => (text, values) => {
      if (text === WEEKS_QUERY) return answer(weeks.length, weeks.map((week) => ({ week })));
      if (text === META_QUERY) return answer(1, [{ week_end_date: null }]);
      for (const [re, apply] of rules) {
        const m = text.match(re);
        if (m) return apply(m, values);
      }
      return undefined;
    };
    return { tables, carries, respond, metaWeek: () => metaWeek };
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
      expect(m.metaWeek()).toBe(weeks[n - 1]);
    });
  }

  it('a single week never rotates', async () => {
    const c = fakeClient(healthy([WEEK], ROWS));
    await runBackfill(c);
    expect(c.texts.filter((t) => t.startsWith('TRUNCATE'))).toEqual([]);
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
  /** Statements only the swap-in transaction may run. */
  const swapInOnly = /^(DROP|ALTER|COMMENT|CREATE TABLE keyword_top_asins_(?:prev|next)|INSERT INTO keyword_top_asins_(?:next|meta))/;
  const KEPT = '; scratch tables kept (a re-run starts over)';
  const lastTx = (texts: string[]) => texts.slice(texts.lastIndexOf(BEGIN));

  it('a failing weeks query fails at stage=weeks with nothing created', async () => {
    const { c, logs, outcome } = await run(failWhen(healthy(WEEKS), (t) => t === WEEKS_QUERY, boom));
    expect(outcome).toBe(boom);
    expect(c.texts).toEqual([WEEKS_QUERY]);
    expect(logs).toEqual(['backfill failed: stage=weeks code=57014']);
  });

  it('a failing setup rolls back and fails at stage=setup', async () => {
    const { c, logs, outcome } = await run(failWhen(healthy(WEEKS), (t) => t.startsWith('CREATE TABLE keyword_top_asins_bf_prev'), boom));
    expect(outcome).toBe(boom);
    expect(c.texts[c.texts.length - 1]).toBe('ROLLBACK');
    expect(logs).toEqual(['backfill: 3 weeks, 2026-09-19 .. 2026-10-03', 'backfill failed: stage=setup code=57014']);
  });

  it('a failing insert (week 2) rolls back, rethrows the original error, and logs only its code', async () => {
    const { c, logs, outcome } = await run(failWhen(healthy(WEEKS), (t, v) => t.startsWith('INSERT INTO keyword_top_asins_bf (') && v[0] === WEEKS[1], boom));
    expect(outcome).toBe(boom);
    expect(c.texts[c.texts.length - 1]).toBe('ROLLBACK');
    expect(c.texts.filter((t) => t === 'COMMIT')).toHaveLength(3); // setup, week 1's insert, week 1's rotate
    expect(afterSetup(c.texts).filter((t) => swapInOnly.test(t))).toEqual([]);
    expect(logs[logs.length - 1]).toBe(`backfill failed: stage=insert week=2026-09-26 (2/3) code=57014${KEPT}`);
    expect(logs.join('\n')).not.toMatch(/SECRET|secret_table/);
  });

  it('a week that inserts zero rows stops the run (top_asins_no_rows): its transaction rolls back and the walk never reaches the live table', async () => {
    const { c, logs, outcome } = await run(healthy(WEEKS, { ...ROWS, '2026-09-26': 0 }));
    expect(outcome).toMatchObject({ code: 'top_asins_no_rows' });
    expect(outcome).toBeInstanceOf(TopAsinsBuildError);
    expect(c.texts[c.texts.length - 1]).toBe('ROLLBACK');
    expect(afterSetup(c.texts).filter((t) => swapInOnly.test(t))).toEqual([]);
    expect(logs[logs.length - 1]).toBe(`backfill failed: stage=insert week=2026-09-26 (2/3) code=top_asins_no_rows${KEPT}`);
  });

  it('a failing rotate (week 1) rolls back and fails at stage=rotate', async () => {
    const { c, logs, outcome } = await run(failWhen(healthy(WEEKS), (t) => t === 'TRUNCATE keyword_top_asins_bf_prev', boom));
    expect(outcome).toBe(boom);
    expect(c.texts[c.texts.length - 1]).toBe('ROLLBACK');
    expect(afterSetup(c.texts).filter((t) => swapInOnly.test(t))).toEqual([]);
    expect(logs[logs.length - 1]).toBe(`backfill failed: stage=rotate week=2026-09-19 (1/3) code=57014${KEPT}`);
  });

  it('the swap-in refuses to replace a NEWER build (an import landed during the run): nothing built, rolled back, scratch kept, top_asins_older_than_meta', async () => {
    const { c, logs, outcome } = await run(healthy(WEEKS, ROWS, '2026-10-10'));
    expect(outcome).toMatchObject({ code: 'top_asins_older_than_meta' });
    expect(lastTx(c.texts)).toEqual([BEGIN, SET_TIMEOUT, LOCK, META_QUERY, 'ROLLBACK']);
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
