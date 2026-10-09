// lib/topAsins/buildWeek.test.ts
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { keywordTopAsins, keywordTopAsinsMeta, keywordWeeklyMetrics } from '@/db/schema';
import { ENQUEUE_LOCK_KEY } from '@/lib/keepa/lanes';
import { buildTopAsinsStatements, buildTopAsinsWeek, TOP_ASINS_LOCK_KEY, TopAsinsBuildError, type Queryable } from './buildWeek';

const dbCols = (t: Parameters<typeof getTableColumns>[0]) => new Set(Object.values(getTableColumns(t)).map((c) => c.name));
const WEEK = '2026-10-03';
// LIKE ... INCLUDING ALL copies no table comment, so the swap sets them; the first is migration 0051's text.
const CURRENT_COMMENT = "COMMENT ON TABLE keyword_top_asins IS 'Current week''s top-3 clicked ASINs per keyword with consecutive-week streaks. Rebuilt per import (lib/topAsins/buildWeek.ts); backfilled once by scripts/backfillTopAsins.ts.'";
const PREV_COMMENT = "COMMENT ON TABLE keyword_top_asins_prev IS 'Previous build of keyword_top_asins: the streak carry source for a same-week rebuild.'";

describe('buildTopAsinsStatements', () => {
  const advance = buildTopAsinsStatements(WEEK); // the default plan: carry from the current build, keep it as _prev
  const sameWeekPrev = buildTopAsinsStatements(WEEK, { carryFrom: 'prev', sameWeek: true });
  const sameWeekNone = buildTopAsinsStatements(WEEK, { carryFrom: 'none', sameWeek: true });
  const everyMode = [advance, sameWeekPrev, sameWeekNone];
  const carrying = [advance, sameWeekPrev];
  const swapOf = (st: { swap: { text: string }[] }) => st.swap.map((x) => x.text);

  it('reads the week from its year partition, three slots, well-formed ASINs only', () => {
    for (const st of everyMode) {
      expect(st.insert.text).toContain('FROM keyword_weekly_metrics_2026');
      expect(st.insert.text.match(/top_clicked_product_[123]_asin ~ '\^\[A-Z0-9\]\{10\}\$'/g)).toHaveLength(3);
      expect(st.insert.values).toEqual([WEEK]);
    }
  });
  it('carries the streak from the carry table: prev + 1, else 1 with this week as the start', () => {
    for (const st of carrying) {
      expect(st.insert.text).toContain('COALESCE(prev.weeks_in_top3, 0) + 1');
      expect(st.insert.text).toContain('COALESCE(prev.streak_started_week, $1::date)');
    }
  });
  it('hash-joinable: DISTINCT ON + plain LEFT JOIN, no LATERAL', () => {
    for (const st of carrying) {
      expect(st.insert.text).toMatch(/LEFT JOIN \(\s*SELECT DISTINCT ON \(search_term_id, asin\) search_term_id, asin, weeks_in_top3, streak_started_week\s+FROM /);
      expect(st.insert.text).toContain('ORDER BY search_term_id, asin, weeks_in_top3 DESC');
      expect(st.insert.text).toContain(') prev ON prev.search_term_id = p.search_term_id AND prev.asin = p.asin');
      expect(st.insert.text).not.toContain('LATERAL');
      expect(st.insert.text).not.toContain('LIMIT');
    }
  });
  it('reads the carry from the right table, or from nothing', () => {
    expect(advance.insert.text).toMatch(/FROM keyword_top_asins\s+ORDER BY/);
    expect(advance.insert.text).not.toContain('keyword_top_asins_prev');
    expect(sameWeekPrev.insert.text).toMatch(/FROM keyword_top_asins_prev\s+ORDER BY/);
    expect(sameWeekPrev.insert.text).not.toMatch(/FROM keyword_top_asins\s/);
    // Carrying from nothing: no join, no carry table, every pair starts at 1 on this week.
    expect(sameWeekNone.insert.text).not.toMatch(/JOIN|DISTINCT|prev|FROM keyword_top_asins/);
    expect(sameWeekNone.insert.text).toMatch(/p\.conversion_share,\s+1,\s+\$1::date,\s+\$1::date\s+FROM \(/);
  });
  it('builds into _next, shaped like the current table', () => {
    for (const st of everyMode) expect(st.createNext.text).toBe('CREATE TABLE keyword_top_asins_next (LIKE keyword_top_asins INCLUDING ALL)');
  });
  it('advance: retires the old _prev, keeps the replaced build as _prev, then promotes _next under the canonical names, each table with its comment', () => {
    expect(swapOf(advance)).toEqual([
      'DROP TABLE IF EXISTS keyword_top_asins_prev',
      'ALTER TABLE keyword_top_asins RENAME TO keyword_top_asins_prev',
      'ALTER INDEX keyword_top_asins_asin_idx RENAME TO keyword_top_asins_prev_asin_idx',
      'ALTER TABLE keyword_top_asins_prev RENAME CONSTRAINT keyword_top_asins_pkey TO keyword_top_asins_prev_pkey',
      PREV_COMMENT,
      'ALTER TABLE keyword_top_asins_next RENAME TO keyword_top_asins',
      CURRENT_COMMENT,
      'ALTER INDEX keyword_top_asins_next_asin_search_term_id_idx RENAME TO keyword_top_asins_asin_idx',
      'ALTER TABLE keyword_top_asins RENAME CONSTRAINT keyword_top_asins_next_pkey TO keyword_top_asins_pkey',
    ]);
  });
  it('same-week rebuild: drops the stale current table, promotes _next with its comment, and never touches _prev', () => {
    for (const st of [sameWeekPrev, sameWeekNone]) {
      expect(swapOf(st)).toEqual([
        'DROP TABLE keyword_top_asins',
        'ALTER TABLE keyword_top_asins_next RENAME TO keyword_top_asins',
        CURRENT_COMMENT,
        'ALTER INDEX keyword_top_asins_next_asin_search_term_id_idx RENAME TO keyword_top_asins_asin_idx',
        'ALTER TABLE keyword_top_asins RENAME CONSTRAINT keyword_top_asins_next_pkey TO keyword_top_asins_pkey',
      ]);
      expect(swapOf(st).join('\n')).not.toContain('keyword_top_asins_prev');
    }
  });
  it("the current table's comment is migration 0051's text, so the swap cannot drift from it", () => {
    const migration = readFileSync('db/migrations/0051_products.sql', 'utf8').replace(/\s+/g, ' ');
    expect(migration).toContain(CURRENT_COMMENT);
  });
  it('names only real columns', () => {
    for (const st of everyMode) {
      const kwmCols = new Set([...st.insert.text.matchAll(/\b(top_clicked_product_[123]_(?:asin|click_share|conversion_share)|search_term_id|week_end_date)\b/g)].map((m) => m[1]));
      expect(kwmCols.size).toBe(11);
      expect([...kwmCols].filter((c) => !dbCols(keywordWeeklyMetrics).has(c))).toEqual([]);
      const insertCols = st.insert.text.slice(st.insert.text.indexOf('(') + 1, st.insert.text.indexOf(')')).split(',').map((c) => c.trim());
      expect(insertCols).toHaveLength(8);
      expect(insertCols.filter((c) => !dbCols(keywordTopAsins).has(c))).toEqual([]);
    }
    // The carry subselect names reverse-table columns; the meta upsert names meta columns.
    const carryCols = ['search_term_id', 'asin', 'weeks_in_top3', 'streak_started_week'];
    expect(advance.insert.text).toContain(`DISTINCT ON (search_term_id, asin) ${carryCols.join(', ')}`);
    expect(carryCols.filter((c) => !dbCols(keywordTopAsins).has(c))).toEqual([]);
    const metaCols = advance.meta.text.slice(advance.meta.text.indexOf('(') + 1, advance.meta.text.indexOf(')')).split(',').map((c) => c.trim());
    expect(metaCols).toEqual(['singleton', 'week_end_date', 'built_at', 'row_count']);
    expect(metaCols.filter((c) => !dbCols(keywordTopAsinsMeta).has(c))).toEqual([]);
  });
  it('rejects a malformed week (the partition name is interpolated into SQL)', () => {
    for (const plan of [undefined, { carryFrom: 'prev', sameWeek: true } as const, { carryFrom: 'none', sameWeek: true } as const]) {
      expect(() => buildTopAsinsStatements('2026/10/03', plan)).toThrow(TopAsinsBuildError);
      expect(() => buildTopAsinsStatements("2026-10-03'; DROP TABLE x", plan)).toThrowError(expect.objectContaining({ code: 'top_asins_bad_date' }));
    }
  });
});

describe('TOP_ASINS_LOCK_KEY', () => {
  it('is its own key, distinct from the Keepa enqueue lock', () => {
    expect(TOP_ASINS_LOCK_KEY).toBe(20261009);
    expect(TOP_ASINS_LOCK_KEY).not.toBe(ENQUEUE_LOCK_KEY);
  });
});

describe('buildTopAsinsWeek', () => {
  type Answer = { rowCount: number | null; rows: unknown[] } | { throws: unknown };
  /** Records every statement three ways: its first three words (calls), its whitespace-collapsed text (texts) and its bound values (args). */
  function fakeClient(answers: Record<string, Answer>): Queryable & { calls: string[]; texts: string[]; args: unknown[][] } {
    const calls: string[] = [];
    const texts: string[] = [];
    const args: unknown[][] = [];
    return {
      calls,
      texts,
      args,
      async query(text: string, values?: unknown[]) {
        calls.push(text.trim().split(/\s+/).slice(0, 3).join(' '));
        texts.push(text.trim().replace(/\s+/g, ' '));
        args.push(values ?? []);
        const key = Object.keys(answers).find((k) => text.includes(k));
        const hit = key ? answers[key] : undefined;
        if (hit && 'throws' in hit) throw hit.throws;
        return hit ?? { rowCount: 0, rows: [] };
      },
    };
  }
  // Substrings that pick a statement's answer.
  const K = { meta: 'FROM keyword_top_asins_meta', probe: 'to_regclass(', insert: 'INSERT INTO keyword_top_asins_next', analyze: 'ANALYZE keyword_top_asins' };
  const metaAt = (week: string | null): Answer => ({ rowCount: 1, rows: [{ week_end_date: week }] });
  const prevPresent = (present: boolean): Answer => ({ rowCount: 1, rows: [{ present }] });
  const inserted = (rowCount: number): Answer => ({ rowCount, rows: [] });
  // Each entry is a statement's first three words. Everything but ANALYZE sits between BEGIN and COMMIT: the settings,
  // then the advisory lock (builds queue here), then the meta read, so the plan is chosen from what is committed now.
  const ADVANCE_CALLS = [
    'BEGIN',
    'SET LOCAL statement_timeout',
    'SET LOCAL work_mem',
    'SELECT pg_advisory_xact_lock($1)',
    'SELECT week_end_date::text AS', // the meta read, under the lock
    'CREATE TABLE keyword_top_asins_next',
    'INSERT INTO keyword_top_asins_next',
    'DROP TABLE IF', // the older _prev
    'ALTER TABLE keyword_top_asins', // current -> _prev
    'ALTER INDEX keyword_top_asins_asin_idx',
    'ALTER TABLE keyword_top_asins_prev', // its primary key
    'COMMENT ON TABLE', // _prev's
    'ALTER TABLE keyword_top_asins_next', // _next -> current
    'COMMENT ON TABLE', // current's
    'ALTER INDEX keyword_top_asins_next_asin_search_term_id_idx',
    'ALTER TABLE keyword_top_asins', // its primary key
    'INSERT INTO keyword_top_asins_meta',
    'COMMIT',
    'ANALYZE keyword_top_asins',
  ];
  const SAME_WEEK_CALLS = [
    'BEGIN',
    'SET LOCAL statement_timeout',
    'SET LOCAL work_mem',
    'SELECT pg_advisory_xact_lock($1)',
    'SELECT week_end_date::text AS',
    "SELECT to_regclass('keyword_top_asins_prev') IS", // the _prev probe
    'CREATE TABLE keyword_top_asins_next',
    'INSERT INTO keyword_top_asins_next',
    'DROP TABLE keyword_top_asins', // the stale current table; _prev is never named again
    'ALTER TABLE keyword_top_asins_next', // _next -> current
    'COMMENT ON TABLE', // current's
    'ALTER INDEX keyword_top_asins_next_asin_search_term_id_idx',
    'ALTER TABLE keyword_top_asins', // its primary key
    'INSERT INTO keyword_top_asins_meta',
    'COMMIT',
    'ANALYZE keyword_top_asins',
  ];
  const REFUSED_CALLS = ['BEGIN', 'SET LOCAL statement_timeout', 'SET LOCAL work_mem', 'SELECT pg_advisory_xact_lock($1)', 'SELECT week_end_date::text AS', 'ROLLBACK'];
  /** The swap statements the runner executed: from the swap's first call up to the meta insert. */
  const executedSwap = (c: { calls: string[]; texts: string[] }, first: string) =>
    c.texts.slice(c.calls.indexOf(first), c.calls.indexOf('INSERT INTO keyword_top_asins_meta'));

  it('refuses a Pool: one dedicated connection only', async () => {
    const pool = Object.assign(fakeClient({}), { totalCount: 1 });
    await expect(buildTopAsinsWeek(pool, WEEK)).rejects.toMatchObject({ code: 'top_asins_bad_client' });
    expect(pool.calls).toEqual([]);
  });
  it('rejects a malformed week before opening a transaction', async () => {
    const c = fakeClient({});
    await expect(buildTopAsinsWeek(c, '2026/10/03')).rejects.toMatchObject({ code: 'top_asins_bad_date' });
    expect(c.calls).toEqual([]);
  });
  it('refuses a week older than the meta week unless forced: the guard throws under the lock and rolls back', async () => {
    const c = fakeClient({ [K.meta]: metaAt('2026-10-03') });
    await expect(buildTopAsinsWeek(c, '2026-09-26')).rejects.toMatchObject({ code: 'top_asins_older_than_meta' });
    expect(c.calls).toEqual(REFUSED_CALLS); // nothing built, nothing swapped
  });
  it('forced older week is a clean rewind: it carries nothing, so every streak restarts at 1', async () => {
    const c = fakeClient({ [K.meta]: metaAt('2026-10-03'), [K.insert]: inserted(5) });
    await expect(buildTopAsinsWeek(c, '2026-09-26', { force: true })).resolves.toEqual({ rows: 5, previousWeek: '2026-10-03', carriedFrom: 'none' });
    expect(c.calls).toEqual(ADVANCE_CALLS); // swaps like an advance: the newer build it replaces ends up as _prev
    expect(c.texts[c.calls.indexOf('INSERT INTO keyword_top_asins_next')]).not.toMatch(/JOIN|keyword_top_asins_prev/);
    expect(executedSwap(c, 'DROP TABLE IF')).toEqual(buildTopAsinsStatements('2026-09-26', { carryFrom: 'none', sameWeek: false }).swap.map((x) => x.text));
  });
  it('first build (no meta week yet) advances from the current table', async () => {
    const c = fakeClient({ [K.meta]: metaAt(null), [K.insert]: inserted(3) });
    await expect(buildTopAsinsWeek(c, WEEK)).resolves.toEqual({ rows: 3, previousWeek: null, carriedFrom: 'current' });
    expect(c.calls).toEqual(ADVANCE_CALLS);
  });
  it('advance: carries from the current table, keeps it as _prev, records meta, analyzes, returns the counts', async () => {
    const c = fakeClient({ [K.meta]: metaAt('2026-09-26'), [K.insert]: inserted(7) });
    const r = await buildTopAsinsWeek(c, WEEK);
    expect(r).toEqual({ rows: 7, previousWeek: '2026-09-26', carriedFrom: 'current' });
    expect(c.calls).toEqual(ADVANCE_CALLS);
    // The transaction's settings come first, then the advisory lock with its key.
    expect(c.texts.slice(1, 4)).toEqual(["SET LOCAL statement_timeout = '1800s'", "SET LOCAL work_mem = '256MB'", 'SELECT pg_advisory_xact_lock($1)']);
    expect(c.args[3]).toEqual([TOP_ASINS_LOCK_KEY]);
    expect(c.texts[c.calls.indexOf('INSERT INTO keyword_top_asins_next')]).toMatch(/FROM keyword_top_asins ORDER BY/);
    expect(executedSwap(c, 'DROP TABLE IF')).toEqual(buildTopAsinsStatements(WEEK).swap.map((x) => x.text));
    // The meta row records the week and the inserted row count, not the statement's placeholder count.
    expect(c.args[c.calls.indexOf('INSERT INTO keyword_top_asins_meta')]).toEqual([WEEK, 7]);
  });
  it('same-week rebuild: carries from _prev, drops the stale current table, leaves _prev alone', async () => {
    const c = fakeClient({ [K.meta]: metaAt(WEEK), [K.probe]: prevPresent(true), [K.insert]: inserted(6) });
    const r = await buildTopAsinsWeek(c, WEEK);
    expect(r).toEqual({ rows: 6, previousWeek: WEEK, carriedFrom: 'prev' });
    expect(c.calls).toEqual(SAME_WEEK_CALLS);
    expect(c.texts[5]).toBe("SELECT to_regclass('keyword_top_asins_prev') IS NOT NULL AS present");
    const insertAt = c.calls.indexOf('INSERT INTO keyword_top_asins_next');
    expect(c.texts[insertAt]).toMatch(/FROM keyword_top_asins_prev ORDER BY/);
    expect(c.texts.slice(insertAt + 1).filter((t) => t.includes('keyword_top_asins_prev'))).toEqual([]); // nothing after the insert names _prev
    expect(executedSwap(c, 'DROP TABLE keyword_top_asins')).toEqual(buildTopAsinsStatements(WEEK, { carryFrom: 'prev', sameWeek: true }).swap.map((x) => x.text));
    expect(c.args[c.calls.indexOf('INSERT INTO keyword_top_asins_meta')]).toEqual([WEEK, 6]);
  });
  it('same-week rebuild without a _prev table carries from nothing: every pair starts at 1', async () => {
    const c = fakeClient({ [K.meta]: metaAt(WEEK), [K.probe]: prevPresent(false), [K.insert]: inserted(6) });
    await expect(buildTopAsinsWeek(c, WEEK)).resolves.toEqual({ rows: 6, previousWeek: WEEK, carriedFrom: 'none' });
    expect(c.calls).toEqual(SAME_WEEK_CALLS);
    expect(c.texts[c.calls.indexOf('INSERT INTO keyword_top_asins_next')]).not.toMatch(/JOIN|keyword_top_asins_prev/);
  });
  it('walks a week sequence consistently: first build, advance, same-week re-runs (idempotent), forced rewind, advance', async () => {
    let metaWeek: string | null = null;
    let prevExists = false;
    const client: Queryable = {
      async query(text: string, values?: unknown[]) {
        if (text.includes(K.meta)) return { rowCount: 1, rows: [{ week_end_date: metaWeek }] };
        if (text.includes(K.probe)) return { rowCount: 1, rows: [{ present: prevExists }] };
        if (text.startsWith(K.insert)) return { rowCount: 5, rows: [] };
        if (text.startsWith('INSERT INTO keyword_top_asins_meta')) metaWeek = String(values?.[0]);
        if (text === 'DROP TABLE IF EXISTS keyword_top_asins_prev') prevExists = false;
        if (text === 'ALTER TABLE keyword_top_asins RENAME TO keyword_top_asins_prev') prevExists = true;
        return { rowCount: 0, rows: [] };
      },
    };
    const carried: string[] = [];
    for (const [week, force] of [['2026-09-19', false], ['2026-09-26', false], ['2026-09-26', false], ['2026-09-26', false], ['2026-09-19', true], ['2026-09-26', false]] as const) {
      carried.push((await buildTopAsinsWeek(client, week, { force })).carriedFrom);
    }
    expect(carried).toEqual(['current', 'current', 'prev', 'prev', 'none', 'current']);
  });
  for (const [label, metaWeek] of [['advance', '2026-09-26'], ['same-week rebuild', WEEK]]) {
    it(`${label}: refuses to swap when the insert wrote zero rows, rolling back`, async () => {
      const c = fakeClient({ [K.meta]: metaAt(metaWeek), [K.probe]: prevPresent(true), [K.insert]: inserted(0) });
      await expect(buildTopAsinsWeek(c, WEEK)).rejects.toMatchObject({ code: 'top_asins_no_rows' });
      expect(c.calls[c.calls.length - 1]).toBe('ROLLBACK');
      // No swap statement ran (neither the live table nor _prev is touched), and nothing commits.
      expect(c.calls.filter((x) => /^(ALTER|DROP|COMMENT)/.test(x))).toEqual([]);
      expect(c.calls).not.toContain('COMMIT');
    });
  }
  it('rolls back and rethrows the original error when a swap statement fails; nothing commits or analyzes', async () => {
    const boom = Object.assign(new Error('relation already exists'), { code: '42P07' });
    const c = fakeClient({ [K.meta]: metaAt('2026-09-26'), [K.insert]: inserted(7), 'ALTER INDEX keyword_top_asins_next': { throws: boom } });
    await expect(buildTopAsinsWeek(c, WEEK)).rejects.toBe(boom);
    expect(c.calls[c.calls.length - 1]).toBe('ROLLBACK');
    expect(c.calls.filter((x) => ['COMMIT', 'ANALYZE keyword_top_asins', 'INSERT INTO keyword_top_asins_meta'].includes(x))).toEqual([]);
  });
  for (const [label, thrown, expected] of [
    ['a pg error code', Object.assign(new Error('boom'), { code: '57014' }), '57014'],
    ['an error name', new TypeError('boom'), 'TypeError'],
    ['a non-Error', 'boom', 'unknown'],
  ] as const) {
    it(`reports an ANALYZE failure after COMMIT as analyzeError (${label}), never thrown, never its message`, async () => {
      const c = fakeClient({ [K.meta]: metaAt('2026-09-26'), [K.insert]: inserted(7), [K.analyze]: { throws: thrown } });
      const r = await buildTopAsinsWeek(c, WEEK);
      expect(r).toEqual({ rows: 7, previousWeek: '2026-09-26', carriedFrom: 'current', analyzeError: expected });
      expect(c.calls.slice(-2)).toEqual(['COMMIT', 'ANALYZE keyword_top_asins']);
      expect(c.calls).not.toContain('ROLLBACK'); // the swap is committed; nothing is rolled back
    });
  }
});
