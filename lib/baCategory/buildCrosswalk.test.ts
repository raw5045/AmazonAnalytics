// lib/baCategory/buildCrosswalk.test.ts
import { describe, it, expect } from 'vitest';
import { asinProducts, baCategoryCrosswalk, keywordWeeklyMetrics } from '@/db/schema';
import { dbCols, notIn } from '@/lib/products/testHelpers';
import { TopAsinsBuildError } from '@/lib/topAsins/buildWeek';
import type { CrosswalkRow } from './assignCodes';
import { BaCrosswalkError, CATALOG_PATHS_SQL, buildCrosswalk, computeCrosswalk, insertSql, votesSql, writeCrosswalk, WRITE_CHUNK } from './buildCrosswalk';

const WEEK = '2026-10-10';
const TOYS = 'Pet Supplies › Dogs › Toys';
const CATS = 'Pet Supplies › Cats';
const VITAMINS = 'Health & Household › Vitamins';
const GIFT = 'Gift Cards › Restaurants';
const VOTE_ROWS = [
  { path: TOYS, code: 'Pet Products', products: 30 },
  { path: TOYS, code: 'Toys', products: 2 },
  { path: VITAMINS, code: 'Health & Personal Care', products: 40 },
];
const PATH_ROWS = [{ path: TOYS }, { path: CATS }, { path: VITAMINS }, { path: GIFT }];

/** Answers by statement head (the first match wins, so an override goes before ANSWERS) and records every call in order. */
function fakeClient(answers: Array<[head: string, answer: { rows?: unknown[]; rowCount?: number; throws?: Error }]> = []) {
  const calls: Array<{ text: string; values?: unknown[] }> = [];
  const client = {
    async query(text: string, values?: unknown[]) {
      calls.push({ text, values });
      const found = answers.find(([head]) => text.startsWith(head));
      const a = found?.[1];
      if (a?.throws) throw a.throws;
      return { rowCount: a?.rowCount ?? a?.rows?.length ?? 0, rows: a?.rows ?? [] };
    },
  };
  return { client, calls, heads: () => calls.map((c) => c.text.trim().split(/\s+/).slice(0, 2).join(' ')) };
}
const ANSWERS: Array<[string, { rows?: unknown[]; rowCount?: number }]> = [
  ['SELECT a.category_path AS path', { rows: VOTE_ROWS }],
  ['SELECT DISTINCT category_path', { rows: PATH_ROWS }],
  ['SELECT max(week_end_date)', { rows: [{ older: null }] }], // an empty table: no built week
  ['INSERT INTO ba_category_crosswalk', { rowCount: 3 }],
];
/** The read transaction's statement heads, and the write transaction's up to its INSERTs. */
const READ = ['BEGIN ISOLATION', 'SET LOCAL', 'SET LOCAL', 'SELECT a.category_path', 'SELECT DISTINCT', 'COMMIT'];
const WRITE_HEAD = ['BEGIN', 'SET LOCAL', 'SET LOCAL', 'LOCK TABLE', 'SELECT max(week_end_date)', 'DELETE FROM'];
const row = (categoryPath: string, code: string, sourcePath: string, votes: number, sharePct: number): CrosswalkRow => ({ categoryPath, code, sourcePath, votes, sharePct });
const pool = { totalCount: 0, async query(): Promise<never> { throw new Error('must not run'); } };

describe('votesSql (spec 2026-10-14 §5.1)', () => {
  const q = votesSql(WEEK);
  it("reads the week's slot-1 rows from its year partition, one vote per product (the mode of category #1), joined to the catalog and grouped by path and code", () => {
    expect(q.text).toContain('FROM keyword_weekly_metrics_2026 m');
    expect(q.text).toContain("m.week_end_date = $1::date AND m.top_clicked_product_1_asin ~ '^[A-Z0-9]{10}$' AND m.top_clicked_category_1 IS NOT NULL");
    expect(q.text).toContain('mode() WITHIN GROUP (ORDER BY m.top_clicked_category_1 COLLATE "C") AS code');
    expect(q.text).toContain('JOIN asin_products a ON a.asin = v.asin');
    expect(q.text).toContain('WHERE a.category_path IS NOT NULL');
    expect(q.text.trim().endsWith('GROUP BY 1, 2')).toBe(true);
    expect(q.text.startsWith('SELECT a.category_path AS path, v.code, count(*)::int AS products')).toBe(true);
    expect(q.values).toEqual([WEEK]);
  });
  it('names only real columns', () => {
    const m = new Set([...q.text.matchAll(/\bm\.([a-z0-9_]+)/g)].map((x) => x[1]));
    const a = new Set([...q.text.matchAll(/\ba\.([a-z0-9_]+)/g)].map((x) => x[1]));
    expect([...m].sort()).toEqual(['top_clicked_category_1', 'top_clicked_product_1_asin', 'week_end_date']);
    expect([...a].sort()).toEqual(['asin', 'category_path']);
    expect(notIn(m, dbCols(keywordWeeklyMetrics))).toEqual([]);
    expect(notIn(a, dbCols(asinProducts))).toEqual([]);
  });
  it('rejects a malformed week before any SQL (the partition name is interpolated)', () => {
    expect(() => votesSql('2026/10/10')).toThrow(TopAsinsBuildError);
  });
  it('lists the distinct catalog paths', () => {
    expect(CATALOG_PATHS_SQL).toBe('SELECT DISTINCT category_path AS path FROM asin_products WHERE category_path IS NOT NULL');
  });
});

describe('computeCrosswalk', () => {
  it('runs the votes read then the paths read in one bounded read-only transaction, assigns the codes and counts the stats', async () => {
    const { client, calls, heads } = fakeClient(ANSWERS);
    const { rows, stats } = await computeCrosswalk(client, WEEK);
    expect(heads()).toEqual(READ);
    expect(calls.slice(0, 3).map((c) => c.text)).toEqual(['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', "SET LOCAL statement_timeout = '1800s'", "SET LOCAL work_mem = '256MB'"]);
    expect(calls[3].values).toEqual([WEEK]);
    expect(rows).toEqual([
      row(VITAMINS, 'Health & Personal Care', VITAMINS, 40, 100),
      row(CATS, 'Pet Products', 'Pet Supplies', 32, 94), // no votes of its own: the department decides
      row(TOYS, 'Pet Products', TOYS, 32, 94),
    ]);
    expect(stats).toEqual({ week: WEEK, paths: 3, direct: 2, backedOff: 1, uncoded: 1, trainingProducts: 72, codes: 2 });
  });
  it('a malformed week is refused with its own code, before any query', async () => {
    const { client, calls } = fakeClient(ANSWERS);
    await expect(computeCrosswalk(client, '2026/10/10')).rejects.toMatchObject({ name: 'BaCrosswalkError', code: 'ba_crosswalk_bad_date' });
    expect(calls).toHaveLength(0);
  });
  it('a week with no slot-1 votes is refused (not imported): the paths read never runs and the transaction rolls back', async () => {
    const { client, heads } = fakeClient([['SELECT a.category_path AS path', { rows: [] }]]);
    await expect(computeCrosswalk(client, WEEK)).rejects.toMatchObject({ code: 'ba_crosswalk_no_votes' });
    expect(heads()).toEqual(['BEGIN ISOLATION', 'SET LOCAL', 'SET LOCAL', 'SELECT a.category_path', 'ROLLBACK']);
    expect(new BaCrosswalkError('ba_crosswalk_no_votes', 'x').name).toBe('BaCrosswalkError');
  });
  it('a failing ROLLBACK does not mask the original error', async () => {
    const { client } = fakeClient([['SELECT a.category_path AS path', { rows: [] }], ['ROLLBACK', { throws: new Error('connection gone') }]]);
    await expect(computeCrosswalk(client, WEEK)).rejects.toMatchObject({ code: 'ba_crosswalk_no_votes' });
  });
});

describe('insertSql', () => {
  const rows = [row(TOYS, 'Pet Products', TOYS, 32, 94), row(CATS, 'Pet Products', 'Pet Supplies', 32, 94)];
  const q = insertSql(rows, WEEK);
  it('inserts the rows from five unnested arrays plus the week, in the mirror\'s columns', () => {
    expect(q.text.replace(/\s+/g, ' ')).toBe(
      'INSERT INTO ba_category_crosswalk (category_path, code, source_path, votes, share_pct, week_end_date) ' +
        'SELECT r.category_path, r.code, r.source_path, r.votes, r.share_pct, $6::date FROM unnest($1::text[], $2::text[], $3::text[], $4::int[], $5::smallint[]) AS r(category_path, code, source_path, votes, share_pct)',
    );
    expect(q.values).toEqual([[TOYS, CATS], ['Pet Products', 'Pet Products'], [TOYS, 'Pet Supplies'], [32, 32], [94, 94], WEEK]);
  });
  it('names only real columns (built_at takes its default)', () => {
    const cols = q.text.slice(q.text.indexOf('(') + 1, q.text.indexOf(')')).split(',').map((c) => c.trim());
    expect(cols).toHaveLength(6);
    expect(notIn(cols, dbCols(baCategoryCrosswalk))).toEqual([]);
  });
});

describe('writeCrosswalk', () => {
  const rows = [row(TOYS, 'Pet Products', TOYS, 32, 94), row(CATS, 'Pet Products', 'Pet Supplies', 32, 94), row(VITAMINS, 'Health & Personal Care', VITAMINS, 40, 100)];
  const boom = Object.assign(new Error('SECRET'), { code: '23505' });
  it('replaces the rows in one transaction, under the lock and after the guard; returns the rows written', async () => {
    const { client, calls, heads } = fakeClient(ANSWERS);
    await expect(writeCrosswalk(client, rows, WEEK)).resolves.toBe(3);
    expect(heads()).toEqual([...WRITE_HEAD, 'INSERT INTO', 'COMMIT']);
    expect(calls.slice(1, 4).map((c) => c.text)).toEqual(["SET LOCAL statement_timeout = '1800s'", "SET LOCAL lock_timeout = '120s'", 'LOCK TABLE ba_category_crosswalk IN SHARE ROW EXCLUSIVE MODE']);
    expect(calls[4]).toEqual({ text: 'SELECT max(week_end_date) > $1::date AS older FROM ba_category_crosswalk', values: [WEEK] });
    expect(calls[5].text).toBe('DELETE FROM ba_category_crosswalk');
  });
  it('chunks the INSERT by WRITE_CHUNK rows and sums their row counts', async () => {
    expect(WRITE_CHUNK).toBe(10_000);
    const many = Array.from({ length: WRITE_CHUNK + 1 }, (_, i) => row(`P${i}`, 'Home', `P${i}`, 20, 100));
    const { client, calls, heads } = fakeClient([['INSERT INTO ba_category_crosswalk', { rowCount: 1 }]]);
    await expect(writeCrosswalk(client, many, WEEK)).resolves.toBe(2);
    expect(heads()).toEqual([...WRITE_HEAD, 'INSERT INTO', 'INSERT INTO', 'COMMIT']);
    const inserts = calls.filter((c) => c.text.startsWith('INSERT INTO'));
    expect((inserts[0].values as unknown[][])[0]).toHaveLength(WRITE_CHUNK);
    expect((inserts[1].values as unknown[][])[0]).toHaveLength(1);
  });
  it('a failing INSERT rolls back and rethrows the error unchanged', async () => {
    const { client, heads } = fakeClient([['INSERT INTO ba_category_crosswalk', { throws: boom }]]);
    await expect(writeCrosswalk(client, rows, WEEK)).rejects.toBe(boom);
    expect(heads()).toEqual([...WRITE_HEAD, 'INSERT INTO', 'ROLLBACK']);
  });
  it('a failing ROLLBACK does not mask the original error', async () => {
    const { client } = fakeClient([['INSERT INTO ba_category_crosswalk', { throws: boom }], ['ROLLBACK', { throws: new Error('connection gone') }]]);
    await expect(writeCrosswalk(client, rows, WEEK)).rejects.toBe(boom);
  });
  it('a lock wait past lock_timeout (55P03) rolls back before anything is deleted', async () => {
    const timeout = Object.assign(new Error('SECRET'), { code: '55P03' });
    const { client, heads } = fakeClient([['LOCK TABLE', { throws: timeout }]]);
    await expect(writeCrosswalk(client, rows, WEEK)).rejects.toBe(timeout);
    expect(heads()).toEqual(['BEGIN', 'SET LOCAL', 'SET LOCAL', 'LOCK TABLE', 'ROLLBACK']);
  });
  it('refuses a week older than the built one, before anything is deleted', async () => {
    const { client, heads } = fakeClient([['SELECT max(week_end_date)', { rows: [{ older: true }] }]]);
    await expect(writeCrosswalk(client, rows, WEEK)).rejects.toMatchObject({ name: 'BaCrosswalkError', code: 'ba_crosswalk_older_than_built' });
    expect(heads()).toEqual(['BEGIN', 'SET LOCAL', 'SET LOCAL', 'LOCK TABLE', 'SELECT max(week_end_date)', 'ROLLBACK']);
  });
  it('rebuilds the built week (or writes a newer one)', async () => {
    const { client, heads } = fakeClient([['SELECT max(week_end_date)', { rows: [{ older: false }] }], ...ANSWERS]);
    await expect(writeCrosswalk(client, rows, WEEK)).resolves.toBe(3);
    expect(heads()).toEqual([...WRITE_HEAD, 'INSERT INTO', 'COMMIT']);
  });
  it('refuses a Pool before any query', async () => {
    await expect(writeCrosswalk(pool, rows, WEEK)).rejects.toMatchObject({ code: 'ba_crosswalk_bad_client' });
  });
});

describe('buildCrosswalk', () => {
  it('refuses a Pool before any query', async () => {
    await expect(buildCrosswalk(pool, WEEK)).rejects.toMatchObject({ code: 'ba_crosswalk_bad_client' });
  });
  it('computes, writes, vacuums (best-effort) and returns the stats', async () => {
    const { client, heads } = fakeClient([...ANSWERS, ['VACUUM', { throws: Object.assign(new Error('late'), { code: '57014' }) }]]);
    await expect(buildCrosswalk(client, WEEK)).resolves.toEqual({ week: WEEK, paths: 3, direct: 2, backedOff: 1, uncoded: 1, trainingProducts: 72, codes: 2 });
    expect(heads()).toEqual([...READ, ...WRITE_HEAD, 'INSERT INTO', 'COMMIT', 'VACUUM (ANALYZE)']);
  });
  it('writes nothing when the compute fails', async () => {
    const { client, heads } = fakeClient([['SELECT a.category_path AS path', { rows: [] }]]);
    await expect(buildCrosswalk(client, WEEK)).rejects.toMatchObject({ code: 'ba_crosswalk_no_votes' });
    expect(heads()).toEqual(['BEGIN ISOLATION', 'SET LOCAL', 'SET LOCAL', 'SELECT a.category_path', 'ROLLBACK']);
  });
  it('a failed write skips the VACUUM and rethrows', async () => {
    const boom = Object.assign(new Error('SECRET'), { code: '23505' });
    const { client, heads } = fakeClient([['INSERT INTO ba_category_crosswalk', { throws: boom }], ...ANSWERS]);
    await expect(buildCrosswalk(client, WEEK)).rejects.toBe(boom);
    expect(heads()).toEqual([...READ, ...WRITE_HEAD, 'INSERT INTO', 'ROLLBACK']);
  });
});
