// lib/products/listCategories.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/env', () => ({ env: { DATABASE_URL: 'postgres://test' } }));
// unstable_cache as a pass-through: the caching is Next's; these tests check the statements and the assembly.
vi.mock('next/cache', () => ({ unstable_cache: (fn: (...args: unknown[]) => unknown) => fn }));
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

  it('tags both caches for one revalidation', () => {
    expect(PRODUCT_CATEGORIES_TAG).toBe('product-categories');
  });
});
