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
  // neon()'s tagged template: the statement with a ? per hole, and the hole values.
  neon: () => async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?').replace(/\s+/g, ' ').trim();
    neonMock.queries.push({ text, values });
    return neonMock.answer(text, values);
  },
}));

import { assemblePathLists, compareCodeUnits, listProductCategoryPaths, listProductDepartments, PRODUCT_CATEGORIES_TAG } from './listCategories';

const SCOPE = "in_scope AND enrichment_status IN ('active', 'no_price')";

describe('assemblePathLists', () => {
  it('flattens, deduplicates and sorts by code unit (not locale)', () => {
    expect(assemblePathLists([['b › y', 'a'], ['B', 'a']])).toEqual(['B', 'a', 'b › y']);
    expect(['b', 'a', 'B'].sort(compareCodeUnits)).toEqual(['B', 'a', 'b']);
    expect(assemblePathLists([])).toEqual([]);
  });
});

describe('the loaders', () => {
  /** Two departments, answered out of code-unit order so the re-sort shows. */
  const DEPARTMENT_ROWS = [{ category_root: 'Pet Supplies' }, { category_root: 'Appliances' }];
  const PATH_ROWS: Record<string, Array<{ category_path: string }>> = {
    Appliances: [{ category_path: 'Appliances › Dishwashers' }],
    'Pet Supplies': [{ category_path: 'Pet Supplies › Dogs › Toys' }, { category_path: 'Pet Supplies' }],
  };

  beforeEach(() => {
    neonMock.queries.length = 0;
    cacheMock.calls.length = 0; // registered is filled once, at import; only the calls belong to a single test
    neonMock.answer = (text, values) => {
      if (text.includes('DISTINCT category_root')) return DEPARTMENT_ROWS;
      if (text.includes('DISTINCT category_path')) return PATH_ROWS[values[0] as string] ?? [];
      return [];
    };
  });

  it('lists the departments of the in-scope, active or no-price rows, in code-unit order', async () => {
    await expect(listProductDepartments()).resolves.toEqual(['Appliances', 'Pet Supplies']);
    expect(neonMock.queries).toHaveLength(1);
    expect(neonMock.queries[0].text).toBe(`SELECT DISTINCT category_root FROM asin_products WHERE ${SCOPE} AND category_root IS NOT NULL ORDER BY category_root`);
    expect(neonMock.queries[0].values).toEqual([]);
  });

  it('reads the paths one department at a time (the path index serves each), binding the root and the root plus separator, and assembles one sorted list', async () => {
    await expect(listProductCategoryPaths()).resolves.toEqual(['Appliances › Dishwashers', 'Pet Supplies', 'Pet Supplies › Dogs › Toys']);
    const pathQueries = neonMock.queries.filter((q) => q.text.includes('DISTINCT category_path'));
    expect(pathQueries).toHaveLength(2);
    expect(pathQueries[0].text).toBe(
      `SELECT DISTINCT category_path FROM asin_products WHERE in_scope AND category_path IS NOT NULL AND enrichment_status IN ('active', 'no_price') AND (category_path = ? OR starts_with(category_path, ?)) ORDER BY category_path`,
    );
    expect(pathQueries.map((q) => q.values)).toEqual([['Appliances', 'Appliances › '], ['Pet Supplies', 'Pet Supplies › ']]);
  });

  it('an empty catalog gives empty lists, never an error', async () => {
    neonMock.answer = () => [];
    await expect(listProductDepartments()).resolves.toEqual([]);
    await expect(listProductCategoryPaths()).resolves.toEqual([]);
  });

  it('a failed department read rejects the whole list: nothing is swallowed and no partial list is returned', async () => {
    const failure = new Error('connection reset');
    const answer = neonMock.answer;
    neonMock.answer = (text, values) => {
      if (text.includes('DISTINCT category_path') && values[0] === 'Pet Supplies') throw failure;
      return answer(text, values);
    };
    await expect(listProductCategoryPaths()).rejects.toBe(failure);
  });

  it('registers the two caches under their own key parts, with the one-hour revalidation and the shared tag', () => {
    expect(PRODUCT_CATEGORIES_TAG).toBe('product-categories');
    const options = { revalidate: 3600, tags: [PRODUCT_CATEGORIES_TAG] };
    expect(cacheMock.registered).toEqual([
      { keyParts: ['product-departments'], options },
      { keyParts: ['product-category-paths'], options },
    ]);
  });

  it("each cached callback holds its own statement, so an edit to the SQL changes the cache key (Next keys an entry on the callback's source and the key parts)", () => {
    const [departments, paths] = cacheMock.sources.map((s) => s.replace(/\s+/g, ' '));
    expect(cacheMock.sources).toHaveLength(2);
    expect(departments).toContain(`SELECT DISTINCT category_root FROM asin_products WHERE ${SCOPE} AND category_root IS NOT NULL ORDER BY category_root`);
    // The path statement's head only: its holes are code, which the test transform may rewrite.
    expect(paths).toContain("SELECT DISTINCT category_path FROM asin_products WHERE in_scope AND category_path IS NOT NULL AND enrichment_status IN ('active', 'no_price')");
  });

  it('calls the departments cache with no arguments, then the paths cache once per department with only that department (not the map index or array)', async () => {
    await listProductCategoryPaths();
    expect(cacheMock.calls).toEqual([
      { keyParts: ['product-departments'], args: [] },
      { keyParts: ['product-category-paths'], args: ['Appliances'] },
      { keyParts: ['product-category-paths'], args: ['Pet Supplies'] },
    ]);
  });
});
