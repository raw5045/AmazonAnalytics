// lib/products/listCategories.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/env', () => ({ env: { DATABASE_URL: 'postgres://test' } }));
// unstable_cache records what is registered (key parts, options, the callback's source text) and what is called (key parts,
// arguments), then passes through: the caching itself is Next's; these tests check the settings, the statements and the assembly.
const cacheMock = vi.hoisted(() => ({
  registered: [] as Array<{ keyParts: string[]; options: unknown }>,
  /** Each registered callback's source text, in registration order: Next keys an entry on it plus the key parts. */
  sources: [] as string[],
  calls: [] as Array<{ keyParts: string[]; args: unknown[] }>,
}));
vi.mock('next/cache', () => ({
  unstable_cache: (fn: (...a: unknown[]) => unknown, keyParts: string[], options: unknown) => {
    cacheMock.registered.push({ keyParts, options });
    cacheMock.sources.push(String(fn));
    return (...args: unknown[]) => {
      cacheMock.calls.push({ keyParts, args });
      return fn(...args);
    };
  },
}));
const neonMock = vi.hoisted(() => ({
  queries: [] as Array<{ text: string; values: unknown[] }>,
  answer: (() => []) as (text: string, values: unknown[]) => unknown[],
}));
vi.mock('@neondatabase/serverless', () => ({
  // neon()'s tagged template: the statement with a ? per hole, and the hole values. query(text, values) only builds a lazy
  // statement, as neon's does; transaction([...]) runs a batch the way neonRunner uses it: each statement is recorded in
  // order and answered, one result set per statement (neonRunner returns the last).
  neon: () => {
    const tagged = async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?').replace(/\s+/g, ' ').trim();
      neonMock.queries.push({ text, values });
      return neonMock.answer(text, values);
    };
    return Object.assign(tagged, {
      query: (text: string, values: unknown[] = []) => ({ text: text.replace(/\s+/g, ' ').trim(), values }),
      transaction: async (statements: Array<{ text: string; values: unknown[] }>) =>
        statements.map(({ text, values }) => {
          neonMock.queries.push({ text, values });
          return neonMock.answer(text, values);
        }),
    });
  },
}));

import {
  assemblePathLists,
  BROAD_CATEGORY_LIST_SQL,
  compareCodeUnits,
  listProductBroadCategories,
  listProductCategoryPaths,
  listProductDepartments,
  PRODUCT_CATEGORIES_TAG,
} from './listCategories';
import { PRODUCT_READ_TIMEOUT_MS } from './searchProducts';

/** The two facets statements as the tagged-template mock records them (spec 2026-10-19 §6). */
const DEPARTMENTS_SQL = 'SELECT DISTINCT department FROM product_category_facets ORDER BY department';
const PATHS_SQL = 'SELECT category_path FROM product_category_facets WHERE department = ? ORDER BY category_path';

describe('assemblePathLists', () => {
  it('flattens, deduplicates and sorts by code unit (not locale)', () => {
    expect(assemblePathLists([['b › y', 'a'], ['B', 'a']])).toEqual(['B', 'a', 'b › y']);
    expect(['b', 'a', 'B'].sort(compareCodeUnits)).toEqual(['B', 'a', 'b']);
    expect(assemblePathLists([])).toEqual([]);
  });
});

describe('the loaders', () => {
  /** Three departments, answered out of code-unit order so the re-sort shows (by code unit the lowercase one comes last; by locale it would sort between the other two). */
  const DEPARTMENT_ROWS = [{ department: 'Pet Supplies' }, { department: 'Appliances' }, { department: 'arts' }];
  /** Four codes, answered out of code-unit order so the re-sort shows (by code unit the lowercase one comes last; by locale it would come first). */
  const BROAD_ROWS = [{ code: 'Toys' }, { code: 'Home' }, { code: 'Misc SDP' }, { code: 'apparel' }];
  const PATH_ROWS: Record<string, Array<{ category_path: string }>> = {
    Appliances: [{ category_path: 'Appliances › Dishwashers' }],
    'Pet Supplies': [{ category_path: 'Pet Supplies › Dogs › Toys' }, { category_path: 'Pet Supplies' }],
    arts: [{ category_path: 'arts › Supplies' }],
  };

  beforeEach(() => {
    neonMock.queries.length = 0;
    cacheMock.calls.length = 0; // registered is filled once, at import; only the calls belong to a single test
    neonMock.answer = (text, values) => {
      if (text === DEPARTMENTS_SQL) return DEPARTMENT_ROWS;
      if (text === PATHS_SQL) return PATH_ROWS[values[0] as string] ?? [];
      if (text.includes('SELECT DISTINCT code FROM ba_category_crosswalk')) return BROAD_ROWS;
      return [];
    };
  });

  it('lists the departments of the facets, in code-unit order; the catalog is never scanned', async () => {
    await expect(listProductDepartments()).resolves.toEqual(['Appliances', 'Pet Supplies', 'arts']);
    expect(neonMock.queries).toEqual([{ text: DEPARTMENTS_SQL, values: [] }]);
  });

  it('reads the paths one department at a time, binding only the department, and assembles one sorted list; nothing else runs', async () => {
    await expect(listProductCategoryPaths()).resolves.toEqual(['Appliances › Dishwashers', 'Pet Supplies', 'Pet Supplies › Dogs › Toys', 'arts › Supplies']);
    const pathQueries = neonMock.queries.filter((q) => q.text === PATHS_SQL);
    expect(pathQueries).toHaveLength(3);
    expect(pathQueries.map((q) => q.values)).toEqual([['Appliances'], ['Pet Supplies'], ['arts']]);
    expect(neonMock.queries.map((q) => q.text)).toEqual([DEPARTMENTS_SQL, PATHS_SQL, PATHS_SQL, PATHS_SQL]);
  });

  it('an empty facets table (before the first build) gives empty lists, never an error', async () => {
    neonMock.answer = () => [];
    await expect(listProductDepartments()).resolves.toEqual([]);
    await expect(listProductCategoryPaths()).resolves.toEqual([]);
  });

  it("one department's failed path read rejects the whole list: nothing is swallowed and no partial list is returned", async () => {
    const failure = new Error('connection reset');
    const answer = neonMock.answer;
    neonMock.answer = (text, values) => {
      if (text === PATHS_SQL && values[0] === 'Pet Supplies') throw failure;
      return answer(text, values);
    };
    await expect(listProductCategoryPaths()).rejects.toBe(failure);
  });

  it('a failed departments read rejects both lists', async () => {
    const failure = Object.assign(new Error('cold'), { code: '57014' });
    neonMock.answer = (text) => {
      if (text === DEPARTMENTS_SQL) throw failure;
      return [];
    };
    await expect(listProductDepartments()).rejects.toBe(failure);
    await expect(listProductCategoryPaths()).rejects.toBe(failure);
  });

  it('lists the distinct codes of the crosswalk, in code-unit order (spec 2026-10-14 §7)', async () => {
    await expect(listProductBroadCategories()).resolves.toEqual(['Home', 'Misc SDP', 'Toys', 'apparel']);
    // One neonRunner batch: the page's statement timeout first (its 30 s value is pinned in searchProducts.test.ts), then the list statement.
    expect(neonMock.queries).toHaveLength(2);
    expect(neonMock.queries[0]).toEqual({ text: `SET LOCAL statement_timeout = ${PRODUCT_READ_TIMEOUT_MS}`, values: [] });
    expect(neonMock.queries[1]).toEqual({ text: BROAD_CATEGORY_LIST_SQL, values: [] });
    expect(BROAD_CATEGORY_LIST_SQL).toBe('SELECT DISTINCT code FROM ba_category_crosswalk ORDER BY code');
  });

  it('an empty crosswalk gives an empty code list; a failed read rejects (never an empty list cached for an hour)', async () => {
    neonMock.answer = () => [];
    await expect(listProductBroadCategories()).resolves.toEqual([]);
    neonMock.answer = () => { throw Object.assign(new Error('cold'), { code: '57014' }); };
    await expect(listProductBroadCategories()).rejects.toMatchObject({ code: '57014' });
  });

  it('registers the three caches under their own key parts, with the one-hour revalidation and the shared tag', () => {
    expect(PRODUCT_CATEGORIES_TAG).toBe('product-categories');
    const options = { revalidate: 3600, tags: [PRODUCT_CATEGORIES_TAG] };
    expect(cacheMock.registered).toEqual([
      { keyParts: ['product-departments'], options },
      { keyParts: ['product-category-paths'], options },
      // The broad-category callback names its statement instead of inlining it, so the statement's text is a key part.
      { keyParts: ['product-broad-categories', BROAD_CATEGORY_LIST_SQL], options },
    ]);
  });

  it("each cached callback holds its own statement (or names the constant whose text is a key part), so an edit to the SQL changes the cache key (Next keys an entry on the callback's source and the key parts)", () => {
    const [departments, paths, broad] = cacheMock.sources.map((s) => s.replace(/\s+/g, ' '));
    expect(cacheMock.sources).toHaveLength(3);
    expect(departments).toContain(DEPARTMENTS_SQL);
    // The path statement's head only: its hole is code, which the test transform may rewrite.
    expect(paths).toContain('SELECT category_path FROM product_category_facets WHERE department = ');
    // The broad-category callback runs the exported constant by name, through neonRunner; the statement text itself is its second key part (pinned above).
    expect(broad).toContain('run(BROAD_CATEGORY_LIST_SQL, [])');
  });

  it('calls the departments cache with no arguments, then the paths cache once per department with only that department (not the map index or array)', async () => {
    await listProductCategoryPaths();
    expect(cacheMock.calls).toEqual([
      { keyParts: ['product-departments'], args: [] },
      { keyParts: ['product-category-paths'], args: ['Appliances'] },
      { keyParts: ['product-category-paths'], args: ['Pet Supplies'] },
      { keyParts: ['product-category-paths'], args: ['arts'] },
    ]);
  });
});
