// lib/products/categoryPredicate.test.ts
import { describe, it, expect } from 'vitest';
import { PRODUCT_DEFAULTS } from './filterParams';
import { EMPTY_CATEGORY_SCOPE, categoryPredicate, pageCategoryScope, type ProductCategoryScope } from './categoryPredicate';

/** A bind that numbers values $1, $2, … and records them, as productSearchSql's does. */
function binder() {
  const values: unknown[] = [];
  return { values, bind: (v: unknown) => { values.push(v); return `$${values.length}`; } };
}
const scope = (over: Partial<ProductCategoryScope>): ProductCategoryScope => ({ ...EMPTY_CATEGORY_SCOPE, ...over });
const SUBTREE = (p: number, q: number) => `(a.category_path = $${p}::text OR starts_with(a.category_path, $${q}::text))`;

describe('categoryPredicate', () => {
  it('is null when nothing is set, and binds nothing', () => {
    const { bind, values } = binder();
    expect(categoryPredicate(EMPTY_CATEGORY_SCOPE, bind)).toBeNull();
    expect(values).toEqual([]);
  });
  it('a department matches the root path and everything under it', () => {
    const { bind, values } = binder();
    expect(categoryPredicate(scope({ dept: 'Appliances' }), bind)).toBe(SUBTREE(1, 2));
    expect(values).toEqual(['Appliances', 'Appliances › ']);
  });
  it('one leaf pick is a subtree; several are OR-ed in one group', () => {
    const one = binder();
    expect(categoryPredicate(scope({ subtreePaths: ['Tools › Bath'], scoped: true }), one.bind)).toBe(SUBTREE(1, 2));
    const two = binder();
    expect(categoryPredicate(scope({ subtreePaths: ['Tools › Bath', 'Tools › Paint'], scoped: true }), two.bind)).toBe(`(${SUBTREE(1, 2)} OR ${SUBTREE(3, 4)})`);
    expect(two.values).toEqual(['Tools › Bath', 'Tools › Bath › ', 'Tools › Paint', 'Tools › Paint › ']);
  });
  it('exact paths bind as one text array', () => {
    const { bind, values } = binder();
    expect(categoryPredicate(scope({ exactPaths: ['A › B', 'A › C'], scoped: true }), bind)).toBe('a.category_path = ANY($1::text[])');
    expect(values).toEqual([['A › B', 'A › C']]);
  });
  it('department ANDs with the leaf-or-custom group; binds run department, picks, then the array', () => {
    const { bind, values } = binder();
    const sql = categoryPredicate(scope({ dept: 'Tools', subtreePaths: ['Tools › Bath'], exactPaths: ['Tools › Bath › Mats'], scoped: true }), bind);
    expect(sql).toBe(`${SUBTREE(1, 2)} AND (${SUBTREE(3, 4)} OR a.category_path = ANY($5::text[]))`);
    expect(values).toEqual(['Tools', 'Tools › ', 'Tools › Bath', 'Tools › Bath › ', ['Tools › Bath › Mats']]);
  });
  it('a requested selection that resolved to no path matches nothing (spec §3: unowned custom ids)', () => {
    expect(categoryPredicate(scope({ scoped: true }), binder().bind)).toBe('FALSE');
    expect(categoryPredicate(scope({ dept: 'Tools', scoped: true }), binder().bind)).toBe(`${SUBTREE(1, 2)} AND FALSE`);
  });
});

describe('pageCategoryScope', () => {
  const ID = '11111111-1111-4111-8111-000000000001';
  it('maps the page filters: picks are subtrees (deduplicated), expanded custom paths exact, scoped when either was requested', () => {
    expect(pageCategoryScope(PRODUCT_DEFAULTS, [])).toEqual(EMPTY_CATEGORY_SCOPE);
    expect(pageCategoryScope({ ...PRODUCT_DEFAULTS, dept: 'Tools', leafPaths: ['Tools › Bath', 'Tools › Bath'] }, [])).toEqual({ dept: 'Tools', subtreePaths: ['Tools › Bath'], exactPaths: [], scoped: true });
    expect(pageCategoryScope({ ...PRODUCT_DEFAULTS, customCategoryIds: [ID] }, ['A › B', 'A › B', 'A › C'])).toEqual({ dept: null, subtreePaths: [], exactPaths: ['A › B', 'A › C'], scoped: true });
    // Ids the user does not own expand to nothing: still scoped, so the predicate is FALSE rather than "everything".
    expect(pageCategoryScope({ ...PRODUCT_DEFAULTS, customCategoryIds: [ID] }, [])).toEqual({ dept: null, subtreePaths: [], exactPaths: [], scoped: true });
  });
  it('hands back fresh arrays and a frozen empty scope', () => {
    const s = pageCategoryScope(PRODUCT_DEFAULTS, []);
    expect(s.subtreePaths).not.toBe(PRODUCT_DEFAULTS.leafPaths);
    expect(Object.isFrozen(EMPTY_CATEGORY_SCOPE)).toBe(true);
  });
});
