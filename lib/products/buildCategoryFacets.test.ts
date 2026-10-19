// lib/products/buildCategoryFacets.test.ts
import { describe, it, expect } from 'vitest';
import { asinProducts, productCategoryFacets } from '@/db/schema';
import { dbCols, notIn } from '@/lib/products/testHelpers';
import {
  FACETS_INSERT_SQL,
  FACETS_SCOPE_SQL,
  FACETS_SELECT_SQL,
  FacetsBuildError,
  buildProductCategoryFacets,
  computeProductCategoryFacets,
  facetStatsSql,
} from './buildCategoryFacets';

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
const STATS = { paths: 23429, departments: 36, products: 1176481 };
const ANSWERS: Array<[string, { rows?: unknown[]; rowCount?: number }]> = [
  ['INSERT INTO product_category_facets', { rowCount: 23429 }],
  ['SELECT count(*)::int AS paths', { rows: [STATS] }],
];
const pool = { totalCount: 0, async query(): Promise<never> { throw new Error('must not run'); } };

describe('the statements (spec 2026-10-19 §5)', () => {
  it('selects one row per distinct path of the rows the Products page can show, with its department and product count', () => {
    expect(FACETS_SCOPE_SQL).toBe("in_scope AND enrichment_status IN ('active', 'no_price') AND category_path IS NOT NULL AND category_root IS NOT NULL");
    expect(FACETS_SELECT_SQL.replace(/\s+/g, ' ')).toBe(
      `SELECT category_path, category_root AS department, count(*)::int AS product_count FROM asin_products WHERE ${FACETS_SCOPE_SQL} GROUP BY category_path, category_root`,
    );
    // Names only real catalog columns.
    const named = new Set([...FACETS_SELECT_SQL.matchAll(/\b(category_path|category_root|in_scope|enrichment_status)\b/g)].map((m) => m[1]));
    expect(named.size).toBe(4);
    expect(notIn(named, dbCols(asinProducts))).toEqual([]);
  });

  it("inserts exactly the mirror's columns but built_at (its default), from that SELECT", () => {
    expect(FACETS_INSERT_SQL.startsWith('INSERT INTO product_category_facets (category_path, department, product_count)\n')).toBe(true);
    expect(FACETS_INSERT_SQL.endsWith(FACETS_SELECT_SQL)).toBe(true);
    const cols = FACETS_INSERT_SQL.slice(FACETS_INSERT_SQL.indexOf('(') + 1, FACETS_INSERT_SQL.indexOf(')')).split(',').map((c) => c.trim());
    const mirror = dbCols(productCategoryFacets);
    expect(notIn(cols, mirror)).toEqual([]);
    expect(notIn(mirror, new Set([...cols, 'built_at']))).toEqual([]);
  });

  it('counts the paths, departments and products of the table, or of the SELECT for a dry run', () => {
    expect(facetStatsSql('table')).toBe(
      'SELECT count(*)::int AS paths, count(DISTINCT department)::int AS departments, coalesce(sum(product_count), 0)::int AS products FROM product_category_facets',
    );
    expect(facetStatsSql('select')).toBe(
      `SELECT count(*)::int AS paths, count(DISTINCT department)::int AS departments, coalesce(sum(product_count), 0)::int AS products FROM (${FACETS_SELECT_SQL}) f`,
    );
  });
});

describe('buildProductCategoryFacets', () => {
  it('replaces the rows in one transaction under the self-exclusive lock, reads the stats inside it, commits, then vacuums best-effort', async () => {
    const { client, calls, heads } = fakeClient(ANSWERS);
    await expect(buildProductCategoryFacets(client)).resolves.toEqual(STATS);
    expect(heads()).toEqual(['BEGIN', 'SET LOCAL', 'SET LOCAL', 'LOCK TABLE', 'DELETE FROM', 'INSERT INTO', 'SELECT count(*)::int', 'COMMIT', 'VACUUM (ANALYZE,']);
    expect(calls.slice(1, 5).map((c) => c.text)).toEqual([
      "SET LOCAL statement_timeout = '600s'",
      "SET LOCAL lock_timeout = '120s'",
      'LOCK TABLE product_category_facets IN SHARE ROW EXCLUSIVE MODE',
      'DELETE FROM product_category_facets',
    ]);
    expect(calls[5].text).toBe(FACETS_INSERT_SQL);
    expect(calls[6].text).toBe(facetStatsSql('table'));
    expect(calls[8].text).toBe('VACUUM (ANALYZE, TRUNCATE false) product_category_facets');
  });

  it('a failing INSERT (a path with two roots: 23505) rolls back, rethrows the error unchanged and skips the VACUUM', async () => {
    const failure = Object.assign(new Error('duplicate key'), { code: '23505' });
    const { client, heads } = fakeClient([['INSERT INTO product_category_facets', { throws: failure }], ...ANSWERS]);
    await expect(buildProductCategoryFacets(client)).rejects.toBe(failure);
    expect(heads()).toEqual(['BEGIN', 'SET LOCAL', 'SET LOCAL', 'LOCK TABLE', 'DELETE FROM', 'INSERT INTO', 'ROLLBACK']);
  });

  it('a lock wait past lock_timeout (55P03) rolls back before anything is deleted', async () => {
    const { client, heads } = fakeClient([['LOCK TABLE', { throws: Object.assign(new Error('lock timeout'), { code: '55P03' }) }], ...ANSWERS]);
    await expect(buildProductCategoryFacets(client)).rejects.toMatchObject({ code: '55P03' });
    expect(heads()).toEqual(['BEGIN', 'SET LOCAL', 'SET LOCAL', 'LOCK TABLE', 'ROLLBACK']);
  });

  it('a failing ROLLBACK does not mask the original error', async () => {
    const failure = new Error('insert failed');
    const { client } = fakeClient([
      ['INSERT INTO product_category_facets', { throws: failure }],
      ['ROLLBACK', { throws: new Error('rollback failed') }],
      ...ANSWERS,
    ]);
    await expect(buildProductCategoryFacets(client)).rejects.toBe(failure);
  });

  it('a failing VACUUM is swallowed: the build is committed and the stats are returned', async () => {
    const { client, heads } = fakeClient([['VACUUM', { throws: new Error('no vacuum for you') }], ...ANSWERS]);
    await expect(buildProductCategoryFacets(client)).resolves.toEqual(STATS);
    expect(heads().slice(-2)).toEqual(['COMMIT', 'VACUUM (ANALYZE,']);
  });

  it('an empty stats row (never expected) reads as zeros', async () => {
    const { client } = fakeClient([['SELECT count(*)::int AS paths', { rows: [] }], ...ANSWERS]);
    await expect(buildProductCategoryFacets(client)).resolves.toEqual({ paths: 0, departments: 0, products: 0 });
  });

  it('refuses a Pool before any query', async () => {
    await expect(buildProductCategoryFacets(pool)).rejects.toMatchObject({ name: 'FacetsBuildError', code: 'facets_bad_client' });
    expect(new FacetsBuildError('facets_bad_client', 'x')).toBeInstanceOf(Error);
  });
});

describe('computeProductCategoryFacets (the dry run)', () => {
  it('counts what a build would write in one bounded read-only transaction and never writes', async () => {
    const { client, calls, heads } = fakeClient(ANSWERS);
    await expect(computeProductCategoryFacets(client)).resolves.toEqual(STATS);
    expect(heads()).toEqual(['BEGIN ISOLATION', 'SET LOCAL', 'SELECT count(*)::int', 'COMMIT']);
    expect(calls[0].text).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(calls[1].text).toBe("SET LOCAL statement_timeout = '600s'");
    expect(calls[2].text).toBe(facetStatsSql('select'));
  });

  it('a failing read rolls back and rethrows', async () => {
    const failure = Object.assign(new Error('canceled'), { code: '57014' });
    const { client, heads } = fakeClient([['SELECT count(*)::int AS paths', { throws: failure }]]);
    await expect(computeProductCategoryFacets(client)).rejects.toBe(failure);
    expect(heads()).toEqual(['BEGIN ISOLATION', 'SET LOCAL', 'SELECT count(*)::int', 'ROLLBACK']);
  });

  it('refuses a Pool before any query', async () => {
    await expect(computeProductCategoryFacets(pool)).rejects.toMatchObject({ code: 'facets_bad_client' });
  });
});
