# Products Category Filters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `/products` and the `search_products` tool the Explorer's three category controls — department, leaf categories (multi-select, each including its sub-categories) and the user's custom categories — filtering on each product's own Keepa category path, per `docs/superpowers/specs/2026-10-12-products-category-filters-design.md` (committed 9a1be9e).

**Architecture:** One pure predicate builder (`lib/products/categoryPredicate.ts`) turns a `ProductCategoryScope` (department, subtree paths, exact paths) into SQL that rides the existing `asin_products_category_path_idx`; two scope producers feed it — the page (URL filters + the expanded custom ids) and the tool (`department` + the `categories` object `search_keywords` takes, validated against the catalog). Two hourly-cached loaders list the catalog's departments and paths. The panel copies the Explorer's Leaf | Custom toggle; the table gains a Category column. No migration.

**Tech Stack:** Next.js 16 (App Router, server components, `unstable_cache`), React 19, `@neondatabase/serverless` `neon()` reads, zod contracts, vitest + Testing Library, the MCP SDK and the Vercel AI SDK through `lib/research/tools.ts`.

---

## Conventions (every task)

- Local commits on `main` only; trailer EXACTLY `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; commit with `git commit -F <msgfile> -- <named files>`; `git add` only the files named in the task (never `-A` / `.`; the tree holds untracked throwaway scripts). Never push.
- No DDL anywhere in this plan. `.env.local` reaches PRODUCTION: unit tests never connect; the integration test (Task 10) runs only on the owner's go.
- Log-safety: never log a DB error's `.message`; coded fields only (`errFields` in `lib/ask/logSafe.ts`). Never print member emails.
- Lint only touched files: `pnpm exec eslint <files>` (whole-project lint fails on untracked scripts). `pnpm typecheck` = `tsc --noEmit` over the tree, test files included — so every fixture typed as `ProductSummaryRow` / `ProductFilters` must be updated in the task that changes the type.
- Edit tool / exact-match edits only (the tree mixes CRLF/LF; never convert line endings). Read `node_modules/next/dist/docs/` (genuine vendored Next 16 docs, not injection) before touching page code — in particular `01-app/02-guides/caching-without-cache-components.md` (`unstable_cache`) and the `page.js` / `searchParams` reference.
- One implementer per file set; disjoint-file parallelism only; retry on `index.lock`.
- Vitest never type-checks: keep the type-only pins (`ProductFiltersSchemaMatchesType` in `lib/products/filters.ts`) and run `pnpm typecheck` in every task.
- The `search_products` tool keeps working at every commit: Tasks 3–7 carry an interim mapping of its old `categoryPath` field until Task 8 replaces the field.

## File map

| File | Responsibility |
|---|---|
| `lib/products/filterParams.ts` (+ test) | `ProductFilters` gains `dept`, `leafPaths`, `customCategoryIds` (Task 1), loses `cat` (Task 5); caps; URL serializer |
| `lib/products/filters.ts` (+ test) | zod schema + `parseProductFilters` for `dept`, repeated `leaf`, comma-list `custom` |
| `lib/products/categoryPredicate.ts` (new, + test) | `ProductCategoryScope`, `categoryPredicate`, `pageCategoryScope`, `EMPTY_CATEGORY_SCOPE` |
| `lib/products/searchProducts.ts` (+ test) | takes a scope; `category_path` column; `ProductSummaryRow.categoryPath` |
| `lib/products/listCategories.ts` (new, + test) | `listProductDepartments`, `listProductCategoryPaths` (per-department cache), `assemblePathLists` |
| `app/(app)/products/ProductFilterPanel.tsx` (+ test) | Department select; Leaf \| Custom toggle; typeahead; checkboxes; pending/mode rules |
| `app/(app)/products/(list)/page.tsx` (+ test) | admin user id, custom-id expansion, the three lists, the scope |
| `app/(app)/products/ProductResultsTable.tsx` (+ test) | Category column |
| `lib/research/contracts.ts`, `lib/research/products.ts` (+ test) | `department` + `categories` fields, `resolveProductCategoryScope`, new deps |
| `lib/research/tools.ts`, `lib/research/catalog.ts` (+ tests) | tool description, guide rules, `GUIDE_VERSION` 4 |
| `tests/integration/productsQueries.test.ts` | owner-gated EXPLAIN + real custom-category cases |

---

### Task 1: Filter fields, parser and serializer (additive — `cat` stays until Task 5)

**Files:**
- Modify: `lib/products/filterParams.ts`
- Modify: `lib/products/filters.ts`
- Modify: `lib/products/filters.test.ts`

- [ ] **Step 1: Failing tests** — in `lib/products/filters.test.ts`, replace the `viaUrl` helper (it collapses repeated keys) and add the new cases. Replace:

```ts
/** What a browser does: serialise to the query string, then parse that string back. */
const viaUrl = (f: ProductFilters): ProductFilters =>
  parseProductFilters(Object.fromEntries(new URLSearchParams(productFiltersToSearchParams(f).toString())));
```

with

```ts
/** The query string as Next hands it to a page: repeated keys become string[] (Object.fromEntries would keep only the last `leaf`). */
function toSearchParamsLike(qs: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of new URLSearchParams(qs)) {
    const cur = out[k];
    out[k] = cur === undefined ? v : Array.isArray(cur) ? [...cur, v] : [cur, v];
  }
  return out;
}
/** What a browser does: serialise to the query string, then parse that string back. */
const viaUrl = (f: ProductFilters): ProductFilters => parseProductFilters(toSearchParamsLike(productFiltersToSearchParams(f).toString()));
const ID1 = '11111111-1111-4111-8111-000000000001';
const ID2 = '22222222-2222-4222-8222-000000000002';
```

Update `FULL` to carry every field (add after `cat`):

```ts
  cat: 'Home & Kitchen › Bath', dept: 'Home & Kitchen', leafPaths: ['Home & Kitchen › Bath', 'Home & Kitchen › Lighting'], customCategoryIds: [ID1, ID2],
  fba: 'yes', amazon: 'no', sort: 'ratio', dir: 'asc', page: 7,
```

In 'parses every filter and ignores junk', add `dept: null, leafPaths: [], customCategoryIds: [],` to the expected literal (after `cat: 'Tools › Bath',`). In 'round-trips every field through the URL string…', the expected string becomes:

```ts
    expect(sp.toString()).toBe(
      'age=365&soldMin=100000&reviewsMax=300&ratingMin=35&ratingMax=50&priceMin=19.99&priceMax=20&bsrMin=1&bsrMax=50000&ratioMax=70&cat=Home+%26+Kitchen+%E2%80%BA+Bath&dept=Home+%26+Kitchen&leaf=Home+%26+Kitchen+%E2%80%BA+Bath&leaf=Home+%26+Kitchen+%E2%80%BA+Lighting&custom=11111111-1111-4111-8111-000000000001%2C22222222-2222-4222-8222-000000000002&fba=yes&amazon=no&sort=ratio&dir=asc&page=7',
    );
```

Add inside `describe('parseProductFilters', …)`:

```ts
  it('reads dept, repeated leaf and the comma-list custom (spec 2026-10-12 §3), and writes them back in a fixed order', () => {
    const f = parseProductFilters({ dept: ' Pet Supplies ', leaf: ['Pet Supplies › Dogs › Toys', ' Pet Supplies › Cats › Toys '], custom: `${ID1},${ID2.toUpperCase()}` });
    expect(f).toEqual({ ...PRODUCT_DEFAULTS, dept: 'Pet Supplies', leafPaths: ['Pet Supplies › Dogs › Toys', 'Pet Supplies › Cats › Toys'], customCategoryIds: [ID1, ID2] });
    expect(productFiltersToSearchParams(f).toString()).toBe(
      `dept=Pet+Supplies&leaf=Pet+Supplies+%E2%80%BA+Dogs+%E2%80%BA+Toys&leaf=Pet+Supplies+%E2%80%BA+Cats+%E2%80%BA+Toys&custom=${ID1}%2C${ID2}`,
    );
    expect(viaUrl(f)).toEqual(f);
  });
  it('one leaf arrives as a string, several as an array; blanks and over-long paths are dropped, the rest kept', () => {
    expect(parseProductFilters({ leaf: 'Tools › Bath' }).leafPaths).toEqual(['Tools › Bath']);
    expect(parseProductFilters({ leaf: ['  ', 'x'.repeat(257), 'Tools › Bath'] }).leafPaths).toEqual(['Tools › Bath']);
    expect(parseProductFilters({ leaf: Array.from({ length: 2001 }, (_, i) => `p${i}`) }).leafPaths).toHaveLength(2000);
  });
  it('custom keeps well-formed uuids only, lower-cased and deduplicated, at most 50', () => {
    expect(parseProductFilters({ custom: `${ID1},nope,${ID1.toUpperCase()},11111111-1111-4111-8111-00000000000,` }).customCategoryIds).toEqual([ID1]);
    expect(parseProductFilters({ custom: '' }).customCategoryIds).toEqual([]);
    const many = Array.from({ length: 51 }, (_, i) => `33333333-3333-4333-8333-${String(i).padStart(12, '0')}`);
    expect(parseProductFilters({ custom: many.join(',') }).customCategoryIds).toEqual(many.slice(0, 50));
  });
  it('dept is trimmed; blank or over-long values fall back to null', () => {
    expect(parseProductFilters({ dept: ' Tools ' }).dept).toBe('Tools');
    expect(parseProductFilters({ dept: '   ' }).dept).toBeNull();
    expect(parseProductFilters({ dept: 'x'.repeat(300) }).dept).toBeNull();
  });
  it('hands back fresh arrays, never the defaults\u2019 own', () => {
    const f = parseProductFilters({});
    expect(f.leafPaths).toEqual([]);
    expect(f.leafPaths).not.toBe(PRODUCT_DEFAULTS.leafPaths);
    expect(f.customCategoryIds).not.toBe(PRODUCT_DEFAULTS.customCategoryIds);
  });
```

- [ ] **Step 2: Run to see them fail** — `pnpm vitest run lib/products/filters.test.ts` → FAIL (the type pin test fails to compile the new fields; `dept`/`leaf`/`custom` are ignored).

- [ ] **Step 3: Implement** — `lib/products/filterParams.ts`: after `export const MAX_CATEGORY_PATH_LENGTH = 256;` add

```ts
/** Leaf picks a URL may carry (`leaf` repeated), the Explorer's MAX_LEAF_PATHS. */
export const PRODUCT_MAX_LEAF_PATHS = 2000;
/** Custom-category ids a URL may carry (`custom`, comma-separated), the Explorer's MAX_CUSTOM_CATEGORY_IDS. */
export const PRODUCT_MAX_CUSTOM_IDS = 50;
```

In `ProductFilters`, after `cat: string | null;` add

```ts
  /** One Keepa root department ('Health & Household'): the product's own storefront department, matched at any depth (spec 2026-10-12 §3). */
  dept: string | null;
  /** Leaf picks: each matches the path and everything under it; several combine with OR. */
  leafPaths: string[];
  /** The user's custom categories, by id; the page expands them to their stored paths, matched exactly. Unowned ids match nothing. */
  customCategoryIds: string[];
```

In `PRODUCT_DEFAULTS` replace `ratioMax: null, cat: null, fba: null,` with `ratioMax: null, cat: null, dept: null, leafPaths: [], customCategoryIds: [], fba: null,`. In `productFiltersToSearchParams` replace the line starting `set('bsrMin', …` with

```ts
  set('bsrMin', f.bsrMin, null); set('bsrMax', f.bsrMax, null); set('ratioMax', f.ratioMax, null); set('cat', f.cat, null); set('dept', f.dept, null);
  for (const path of f.leafPaths) sp.append('leaf', path);
  if (f.customCategoryIds.length > 0) sp.set('custom', f.customCategoryIds.join(','));
  set('fba', f.fba, null); set('amazon', f.amazon, null);
```

`lib/products/filters.ts`: extend the import to `import { MAX_CATEGORY_PATH_LENGTH, PRODUCT_AGES, PRODUCT_DEFAULTS, PRODUCT_MAX_CUSTOM_IDS, PRODUCT_MAX_LEAF_PATHS, PRODUCT_MAX_PAGE, PRODUCT_SORTS, type ProductFilters } from './filterParams';`. In the schema after the `cat:` line add

```ts
  dept: z.string().trim().min(1).max(MAX_CATEGORY_PATH_LENGTH).nullable(),
  leafPaths: z.array(z.string().trim().min(1).max(MAX_CATEGORY_PATH_LENGTH)).max(PRODUCT_MAX_LEAF_PATHS),
  customCategoryIds: z.array(z.uuid()).max(PRODUCT_MAX_CUSTOM_IDS),
```

After the `pageNumber` helper add

```ts
/** A repeated key as Next hands it: absent, one value, or an array of values. */
const many = (v: string | string[] | undefined): string[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
/** Repeated `leaf` values: trimmed, non-empty, at most MAX_CATEGORY_PATH_LENGTH each, the first PRODUCT_MAX_LEAF_PATHS. */
const leafPaths = (v: string | string[] | undefined): string[] =>
  many(v).map((s) => s.trim()).filter((s) => s.length > 0 && s.length <= MAX_CATEGORY_PATH_LENGTH).slice(0, PRODUCT_MAX_LEAF_PATHS);
const uuid = z.uuid();
/** One comma-separated `custom` value: well-formed uuids only (lower-cased, deduplicated), the first PRODUCT_MAX_CUSTOM_IDS; anything else is dropped. */
const customIds = (v: string | undefined): string[] =>
  v === undefined ? [] : [...new Set(v.split(',').map((s) => s.trim().toLowerCase()).filter((s) => uuid.safeParse(s).success))].slice(0, PRODUCT_MAX_CUSTOM_IDS);
```

In `parseProductFilters`'s `raw` replace `cat: one(sp.cat) ?? null, fba:` with `cat: one(sp.cat) ?? null, dept: one(sp.dept) ?? null, leafPaths: leafPaths(sp.leaf), customCategoryIds: customIds(one(sp.custom)), fba:`.

- [ ] **Step 4: Run** — `pnpm vitest run lib/products/filters.test.ts lib/products/filterParams.test.ts && pnpm exec eslint lib/products/filterParams.ts lib/products/filters.ts lib/products/filters.test.ts && pnpm typecheck` → PASS. (Typecheck passes: `cat` still exists everywhere; the new fields have defaults.)

- [ ] **Step 5: Commit** → `feat(products): dept, leaf and custom category filter fields (URL, parser, serializer)`.

---

### Task 2: The category predicate and the page's scope

**Files:**
- Create: `lib/products/categoryPredicate.ts`, `lib/products/categoryPredicate.test.ts`

- [ ] **Step 1: Failing tests** — `lib/products/categoryPredicate.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to see it fail** — `pnpm vitest run lib/products/categoryPredicate.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** — `lib/products/categoryPredicate.ts`:

```ts
// lib/products/categoryPredicate.ts
/**
 * The category filter of a product search (spec 2026-10-12 §3, §4.1): one predicate over
 * asin_products.category_path, built from a ProductCategoryScope. Two producers make scopes — the
 * page (pageCategoryScope: URL filters + the custom categories expanded by the page) and the tools
 * (lib/research/products.ts: department + the categories object, validated). Pure: no I/O.
 *
 * Every form rides asin_products_category_path_idx (text_pattern_ops): the planner rewrites
 * starts_with(column, constant) into an index range, so a subtree is a BitmapOr of two index scans,
 * and `= ANY(array)` is one index scan whatever the array's length (measured 2026-10-10, spec §2).
 */
import { PATH_SEP } from '@/lib/categoryBuilder/buildTree';
import type { ProductFilters } from './filterParams';

export interface ProductCategoryScope {
  /** A Keepa root department, matched as a subtree; null for all departments. */
  dept: string | null;
  /** Each matches the path and its descendants (the page's leaf picks; the tools' taxonomy selections). */
  subtreePaths: string[];
  /** Each matches exactly (custom categories' stored paths; the tools' leafPaths). */
  exactPaths: string[];
  /** A leaf or custom selection was requested; with no paths left, the group is FALSE instead of absent. */
  scoped: boolean;
}

export const EMPTY_CATEGORY_SCOPE: Readonly<ProductCategoryScope> = Object.freeze({ dept: null, subtreePaths: [], exactPaths: [], scoped: false });

type Bind = (v: unknown) => string;
const unique = (paths: readonly string[]): string[] => [...new Set(paths)];

/** The page's scope: leaf picks as subtrees, the expanded custom paths exact; scoped when either was asked for (even if the ids expanded to nothing). */
export function pageCategoryScope(f: Pick<ProductFilters, 'dept' | 'leafPaths' | 'customCategoryIds'>, customPaths: readonly string[]): ProductCategoryScope {
  return { dept: f.dept, subtreePaths: unique(f.leafPaths), exactPaths: unique(customPaths), scoped: f.leafPaths.length > 0 || f.customCategoryIds.length > 0 };
}

/** `path` itself or anything under it. Two binds: the path, then the path with the separator appended. */
const subtree = (path: string, bind: Bind): string => `(a.category_path = ${bind(path)}::text OR starts_with(a.category_path, ${bind(path + PATH_SEP)}::text))`;

/**
 * The WHERE fragment (over alias `a`), or null when the scope sets nothing. Department AND (subtrees OR
 * exact array); a scoped selection with no paths is FALSE. Binds in order of appearance: department,
 * subtree paths, then the exact-path array as one text[] parameter.
 */
export function categoryPredicate(scope: ProductCategoryScope, bind: Bind): string | null {
  const terms: string[] = [];
  if (scope.dept !== null) terms.push(subtree(scope.dept, bind));
  const group = scope.subtreePaths.map((p) => subtree(p, bind));
  if (scope.exactPaths.length > 0) group.push(`a.category_path = ANY(${bind(scope.exactPaths)}::text[])`);
  if (group.length === 1) terms.push(group[0]);
  else if (group.length > 1) terms.push(`(${group.join(' OR ')})`);
  else if (scope.scoped) terms.push('FALSE');
  return terms.length === 0 ? null : terms.join(' AND ');
}
```

- [ ] **Step 4: Run** — `pnpm vitest run lib/products/categoryPredicate.test.ts && pnpm exec eslint lib/products/categoryPredicate.ts lib/products/categoryPredicate.test.ts && pnpm typecheck` → PASS.

- [ ] **Step 5: Commit** → `feat(products): category predicate (department, subtree picks, exact paths) and the page scope`.

---

### Task 3: The search statement takes the scope and returns the path

**Files:**
- Modify: `lib/products/searchProducts.ts`, `lib/products/searchProducts.test.ts`
- Modify (signature + fixtures only): `lib/research/products.ts`, `lib/research/products.test.ts`, `lib/research/contracts.ts` (`toProductFilters`), `app/(app)/products/(list)/page.tsx`, `app/(app)/products/(list)/page.test.tsx`, `app/(app)/products/ProductResultsTable.test.tsx`, `tests/integration/productsQueries.test.ts`

- [ ] **Step 1: Failing tests** — `lib/products/searchProducts.test.ts`: import `EMPTY_CATEGORY_SCOPE, type ProductCategoryScope` from `'./categoryPredicate'`; give every `productSearchSql(...)` and `searchProducts(run, ...)` call a second/third argument `EMPTY_CATEGORY_SCOPE` (the `it.each` cases and the `names only real columns` case too, dropping their `cat:` filter). Rewrite 'maps every filter to its predicate with bound values':

```ts
  it('maps every filter to its predicate with bound values; the category scope sits between ratioMax and the offer filters', () => {
    const scope: ProductCategoryScope = { dept: 'Tools', subtreePaths: ['Tools › Bath'], exactPaths: ['Tools › Bath › Mats'], scoped: true };
    const q = productSearchSql({ ...PRODUCT_DEFAULTS, age: 90, soldMin: 1000, reviewsMax: 300, ratingMin: 40, ratingMax: 50, priceMinCents: 999, priceMaxCents: 4000, bsrMin: 1, bsrMax: 50000, ratioMax: 70, fba: 'no', amazon: 'yes', sort: 'listed', dir: 'asc', page: 3 }, scope);
    const t = q.rows.text;
    expect(t).toContain('a.listed_since >= current_date - $1::int');
    expect(t).toContain('a.monthly_sold >= $2::int');
    expect(t).toContain('a.review_count <= $3::int');
    expect(t).toContain('a.average_rating_x10 >= $4::int');
    expect(t).toContain('a.average_rating_x10 <= $5::int');
    expect(t).toContain('a.current_price_cents >= $6::int');
    expect(t).toContain('a.current_price_cents <= $7::int');
    expect(t).toContain('a.sales_rank >= $8::int');
    expect(t).toContain('a.sales_rank <= $9::int');
    expect(t).toContain('a.rank_ratio_x100 <= $10::int');
    expect(t).toContain('(a.category_path = $11::text OR starts_with(a.category_path, $12::text)) AND ((a.category_path = $13::text OR starts_with(a.category_path, $14::text)) OR a.category_path = ANY($15::text[])) AND a.fba_offer_count = 0');
    expect(t).toContain('a.amazon_availability >= 0');
    expect(t).toContain('a.listed_since IS NOT NULL');
    expect(t).toContain(', a.listed_since AS sort_key FROM asin_products a WHERE ');
    expect(t).toContain('ORDER BY a.listed_since ASC, a.asin ASC LIMIT $16 OFFSET $17) p');
    expect(t.endsWith(' ORDER BY p.sort_key ASC, p.asin ASC')).toBe(true);
    expect(q.rows.values).toEqual([90, 1000, 300, 40, 50, 999, 4000, 1, 50000, 70, 'Tools', 'Tools › ', 'Tools › Bath', 'Tools › Bath › ', ['Tools › Bath › Mats'], 50, 100]);
    expect(q.count.values).toEqual(q.rows.values.slice(0, -2));
    expect(q.count.text).toContain('a.listed_since IS NOT NULL');
  });
  it('the category fields of the filters object are not read: the scope alone decides', () => {
    const q = productSearchSql({ ...PRODUCT_DEFAULTS, dept: 'Tools', leafPaths: ['Tools › Bath'], customCategoryIds: ['11111111-1111-4111-8111-000000000001'] }, EMPTY_CATEGORY_SCOPE);
    expect(q.rows.text).not.toContain('category_path =');
    expect(q.rows.values).toEqual([50, 0]);
  });
  it('a scoped selection with no paths matches nothing, in the rows and the count', () => {
    const q = productSearchSql(PRODUCT_DEFAULTS, { ...EMPTY_CATEGORY_SCOPE, scoped: true });
    expect(q.rows.text).toContain(' AND FALSE AND a.monthly_sold IS NOT NULL');
    expect(q.count.text).toContain(' AND FALSE AND a.monthly_sold IS NOT NULL');
  });
  it('selects the category path for the Category column', () => {
    expect(productSearchSql(PRODUCT_DEFAULTS, EMPTY_CATEGORY_SCOPE).rows.text).toContain('a.brand, a.category_path, a.listed_since::text AS listed_since');
  });
```

In the `it.each(SORT_DIR_PAIRS)` case, replace `cat: 'Tools › Bath',` in the filters with nothing and pass `{ ...EMPTY_CATEGORY_SCOPE, dept: 'Tools', subtreePaths: ['Tools › Bath'], scoped: true }` as the scope. In `describe('searchProducts')`, add `category_path: 'Home & Kitchen › Lighting › Desk Lamps'` to the fake row of 'runs both statements and maps rows' and assert `expect(r.rows[0].categoryPath).toBe('Home & Kitchen › Lighting › Desk Lamps')`. Add, inside `describe('neonRunner')`, a wire check for the array parameter:

```ts
  it('with the real neon client: an exact-path array travels as one Postgres array literal', async () => {
    const requests: Array<{ url: string; batch: Batch }> = [];
    await withNeonFetch(
      (url, batch) => {
        requests.push({ url, batch });
        return okResults(SET_RESULT, { command: 'SELECT', rowCount: 0, rows: [], fields: [], rowAsArray: true });
      },
      async (sql) => {
        const q = productSearchSql(PRODUCT_DEFAULTS, { ...EMPTY_CATEGORY_SCOPE, exactPaths: ['Pet Supplies › Dogs › Toys', 'Pet Supplies › Cats › Toys'], scoped: true });
        await neonRunner(sql)(q.count.text, q.count.values);
      },
    );
    expect(requests[0].batch.queries[1].params).toEqual(['{"Pet Supplies › Dogs › Toys","Pet Supplies › Cats › Toys"}']);
  });
```

That wire assertion is a real guard, not a formality: the driver serialises a JavaScript array with pg's `prepareValue` into the `{"…","…"}` literal the `::text[]` cast reads. If the recorded param is anything else, the array form is not supported by the driver in use — then switch the exact paths to `IN ($n, $n+1, …)` with one bind per path in `categoryPredicate` (and its tests), and keep this test asserting the per-path params.

Update the typed fixtures so `pnpm typecheck` stays green: `ProductResultsTable.test.tsx` `makeRow` gains `categoryPath: 'Home & Kitchen › Lighting › Desk Lamps',` (after `brand: 'Acme',`); `(list)/page.test.tsx` `RESULT.rows[0]` gains the same field; `lib/research/products.test.ts` `summaryRow` gains `categoryPath: 'Health & Household › Vitamins',` and `makeDeps().search` becomes `vi.fn(async (_filters: ProductFilters, _scope: ProductCategoryScope) => ({ … }))` with `import type { ProductFilters } from '@/lib/products/filters'` and `import { EMPTY_CATEGORY_SCOPE, type ProductCategoryScope } from '@/lib/products/categoryPredicate'`; its two `toHaveBeenCalledWith` on `deps.search` gain a second argument `EMPTY_CATEGORY_SCOPE`; in 'runs each loader through neon()' use `d.search({ ...PRODUCT_DEFAULTS }, EMPTY_CATEGORY_SCOPE)` and `productSearchSql({ ...PRODUCT_DEFAULTS }, EMPTY_CATEGORY_SCOPE)`.

- [ ] **Step 2: Run to see them fail** — `pnpm vitest run lib/products/searchProducts.test.ts` → FAIL.

- [ ] **Step 3: Implement** — `lib/products/searchProducts.ts`: import `import { categoryPredicate, type ProductCategoryScope } from './categoryPredicate';`. In `ProductSummaryRow` add `categoryPath: string | null;` after `brand`. In `PAGE_COLUMNS` replace `a.asin, a.title, a.brand, a.listed_since::text AS listed_since,` with `a.asin, a.title, a.brand, a.category_path, a.listed_since::text AS listed_since,`. Change the signature to `export function productSearchSql(f: ProductFilters, scope: ProductCategoryScope): { rows: SqlStatement; count: SqlStatement }` and replace the `if (f.cat !== null) …` line with

```ts
  // The category filter comes from the scope alone (spec 2026-10-12 §4.1); f's own category fields are the URL's, not the query's.
  const category = categoryPredicate(scope, bind);
  if (category !== null) where.push(category);
```

Change `searchProducts` to `export async function searchProducts(run: SqlRunner, f: ProductFilters, scope: ProductCategoryScope): Promise<ProductSearchResult>` with `const q = productSearchSql(f, scope);`. In `Raw` add `category_path: string | null;` after `brand`; in the mapper add `categoryPath: r.category_path,` after `brand: r.brand,`. Update the header comment's first paragraph to mention the scope ("the category filter is a ProductCategoryScope built by the caller — see ./categoryPredicate").

Call sites: `lib/research/products.ts` — `import { EMPTY_CATEGORY_SCOPE, pageCategoryScope, type ProductCategoryScope } from '@/lib/products/categoryPredicate';` (drop whichever of the two values ends up unused); `ProductLoaders.search: (filters: ProductFilters, scope: ProductCategoryScope) => Promise<ProductSearchResult>;`; `search: (filters, scope) => searchProducts(run(), filters, scope),`; in `searchProductsForTool`: `const result = await deps.search(filters, pageCategoryScope(filters, []));` (interim: the tool's `categoryPath` keeps its subtree meaning through `leafPaths` until Task 8). `lib/research/contracts.ts` `toProductFilters`: replace `cat: f.categoryPath ?? PRODUCT_DEFAULTS.cat,` with

```ts
    cat: f.categoryPath ?? PRODUCT_DEFAULTS.cat,
    dept: PRODUCT_DEFAULTS.dept,
    // Interim until the department + categories fields land: the old single path keeps its subtree meaning.
    leafPaths: f.categoryPath === undefined ? [] : [f.categoryPath],
    customCategoryIds: [],
```

`app/(app)/products/(list)/page.tsx`: `import { pageCategoryScope } from '@/lib/products/categoryPredicate';` and `searchProducts(neonRunner(sql), filters, pageCategoryScope(filters, []))` (Task 6 wires the real expansion). `tests/integration/productsQueries.test.ts`: import `EMPTY_CATEGORY_SCOPE` from `'@/lib/products/categoryPredicate'` and pass it to its `productSearchSql(…)` and `searchProducts(run, …)` calls (Task 10 adds the category cases).

- [ ] **Step 4: Run** — `pnpm vitest run lib/products lib/research/products.test.ts "app/(app)/products" && pnpm exec eslint lib/products/searchProducts.ts lib/products/searchProducts.test.ts lib/research/products.ts lib/research/products.test.ts lib/research/contracts.ts "app/(app)/products/(list)/page.tsx" "app/(app)/products/(list)/page.test.tsx" "app/(app)/products/ProductResultsTable.test.tsx" tests/integration/productsQueries.test.ts && pnpm typecheck` → PASS (the page test's `data.search` assertion on the filters still holds; it checks the second argument only from Task 6).

- [ ] **Step 5: Commit** → `feat(products): search takes a category scope and returns each row's category path`.

---

### Task 4: Department and path lists (hourly cache, per department)

**Files:**
- Create: `lib/products/listCategories.ts`, `lib/products/listCategories.test.ts`

- [ ] **Step 1: Failing tests** — `lib/products/listCategories.test.ts`:

```ts
// lib/products/listCategories.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/env', () => ({ env: { DATABASE_URL: 'postgres://test' } }));
// unstable_cache as a pass-through: the caching is Next's; these tests check the statements and the assembly.
vi.mock('next/cache', () => ({ unstable_cache: (fn: (...args: unknown[]) => unknown) => fn }));
const neonMock = vi.hoisted(() => ({
  queries: [] as Array<{ text: string; values: unknown[] }>,
  answer: ((_text: string, _values: unknown[]) => []) as (text: string, values: unknown[]) => unknown[],
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
```

- [ ] **Step 2: Run to see it fail** — `pnpm vitest run lib/products/listCategories.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** — `lib/products/listCategories.ts` (read `node_modules/next/dist/docs/01-app/02-guides/caching-without-cache-components.md` first; `lib/explorer/listLeafCategories.ts` is the house pattern):

```ts
// lib/products/listCategories.ts
/**
 * The Products page's category option lists (spec 2026-10-12 §4.4), cached an hour with
 * unstable_cache like lib/explorer/listLeafCategories.ts:
 *  - listProductDepartments: the distinct Keepa root departments of the rows the page can show
 *    (36 today; the uncached statement scans the catalog, 1.3 s cold, hence the cache);
 *  - listProductCategoryPaths: every distinct category_path of those rows (22,693 today, 1.9 MB),
 *    read one department at a time through asin_products_category_path_idx and cached per
 *    department (unstable_cache keys on the function's arguments), so no single cache entry is
 *    large and a cold fill is a parallel half-second instead of a 1.4 s scan.
 * Both lists are sorted by plain code-unit comparison, the ordering lib/research/categories.ts uses,
 * so the typeahead's options and the tools' catalog check agree. An empty catalog gives empty lists.
 */
import { unstable_cache } from 'next/cache';
import { neon } from '@neondatabase/serverless';
import { env } from '@/lib/env';
import { PATH_SEP } from '@/lib/categoryBuilder/buildTree';

const REVALIDATE_SECONDS = 60 * 60;
/** One tag for both lists, so a future revalidateTag can refresh them together. */
export const PRODUCT_CATEGORIES_TAG = 'product-categories';

/** `a < b ? -1 : a > b ? 1 : 0`: a pure function of the strings, unlike localeCompare (host ICU data). */
export const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Pure: the per-department lists as one deduplicated list in code-unit order. */
export function assemblePathLists(lists: ReadonlyArray<ReadonlyArray<string>>): string[] {
  return [...new Set(lists.flat())].sort(compareCodeUnits);
}

async function fetchDepartments(): Promise<string[]> {
  const sql = neon(env.DATABASE_URL);
  const rows = (await sql`
    SELECT DISTINCT category_root FROM asin_products
    WHERE in_scope AND enrichment_status IN ('active', 'no_price') AND category_root IS NOT NULL
    ORDER BY category_root
  `) as Array<{ category_root: string }>;
  return rows.map((r) => r.category_root);
}

/** The catalog's root departments, in code-unit order (the statement's ORDER BY is the database's collation; re-sorted here). */
export const listProductDepartments = unstable_cache(
  async () => [...(await fetchDepartments())].sort(compareCodeUnits),
  ['product-departments'],
  { revalidate: REVALIDATE_SECONDS, tags: [PRODUCT_CATEGORIES_TAG] },
);

/** One department's distinct paths: the root itself and everything under it, through the path index. */
async function fetchPathsForDepartment(dept: string): Promise<string[]> {
  const sql = neon(env.DATABASE_URL);
  const rows = (await sql`
    SELECT DISTINCT category_path FROM asin_products
    WHERE in_scope AND category_path IS NOT NULL AND enrichment_status IN ('active', 'no_price')
      AND (category_path = ${dept} OR starts_with(category_path, ${dept + PATH_SEP}))
    ORDER BY category_path
  `) as Array<{ category_path: string }>;
  return rows.map((r) => r.category_path);
}

const cachedPathsForDepartment = unstable_cache(fetchPathsForDepartment, ['product-category-paths'], { revalidate: REVALIDATE_SECONDS, tags: [PRODUCT_CATEGORIES_TAG] });

/** Every distinct category path of the rows the page can show, assembled from the per-department caches. */
export async function listProductCategoryPaths(): Promise<string[]> {
  const departments = await listProductDepartments();
  const lists = await Promise.all(departments.map((dept) => cachedPathsForDepartment(dept)));
  return assemblePathLists(lists);
}
```

The test normalises each statement's whitespace (`.replace(/\s+/g, ' ').trim()`), so the multi-line templates above compare as the one-line strings the test expects.

- [ ] **Step 4: Run** — `pnpm vitest run lib/products/listCategories.test.ts && pnpm exec eslint lib/products/listCategories.ts lib/products/listCategories.test.ts && pnpm typecheck` → PASS.

- [ ] **Step 5: Commit** → `feat(products): cached department and category-path lists for the Products filters`.

---

### Task 5: The filter panel — Department, Leaf | Custom (and `cat` retired)

**Files:**
- Modify: `app/(app)/products/ProductFilterPanel.tsx`, `app/(app)/products/ProductFilterPanel.test.tsx`
- Modify (retire `cat`): `lib/products/filterParams.ts`, `lib/products/filters.ts`, `lib/products/filters.test.ts`, `lib/research/contracts.ts` (`toProductFilters`), `app/(app)/products/ProductResultsTable.test.tsx` (the `cat` URL case)
- Modify (interim props, replaced in Task 6): `app/(app)/products/(list)/page.tsx`

Read `app/(app)/explorer/FilterSidebar.tsx` lines 636–735 first: the toggle and the Custom list are copied from there (the Explorer file itself is not touched).

- [ ] **Step 1: Failing tests** — `app/(app)/products/ProductFilterPanel.test.tsx`. Replace the fixtures and `renderPanel`:

```ts
const LEAVES = [
  'Home & Kitchen › Lighting › Desk Lamps',
  'Home & Kitchen › Lighting › Floor Lamps',
  'Toys & Games › Puzzles › Jigsaw Puzzles',
];
const DEPARTMENTS = ['Home & Kitchen', 'Pet Supplies', 'Toys & Games'];
const CUSTOM = [
  { id: '11111111-1111-4111-8111-000000000001', name: 'Lamps', leafPaths: [LEAVES[0], LEAVES[1]] },
  { id: '22222222-2222-4222-8222-000000000002', name: 'Puzzles & lamps', leafPaths: [LEAVES[1], LEAVES[2]] },
];

/** Every filter set to a non-default value, on page 3 (leaf mode: picks, no custom ids). */
const SEEDED: ProductFilters = {
  age: 180, soldMin: 1000, reviewsMax: 300, ratingMin: 40, ratingMax: 48, priceMinCents: 999, priceMaxCents: 3000,
  bsrMin: 1, bsrMax: 50_000, ratioMax: 70, dept: 'Home & Kitchen', leafPaths: [LEAVES[0]], customCategoryIds: [], fba: 'yes', amazon: 'no', sort: 'listed', dir: 'asc', page: 3,
};

function renderPanel(filters: ProductFilters = PRODUCT_DEFAULTS, customCategories = CUSTOM) {
  return render(<ProductFilterPanel filters={filters} departments={DEPARTMENTS} leafCategories={LEAVES} customCategories={customCategories} />);
}
```

In 'renders every control at PRODUCT_DEFAULTS' add, before the `Add leaf category` lines:

```ts
    expect(control('Department')).toHaveDisplayValue('All departments');
    expect(optionTexts('Department')).toEqual(['All departments', ...DEPARTMENTS]);
    expect(screen.getByRole('button', { name: 'Leaf' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Custom' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText(/3 categories — type to search/)).toBeInTheDocument();
```

In 'seeds every control from the applied filters' add `expect(control('Department')).toHaveDisplayValue('Home & Kitchen');`. Replace `describe('ProductFilterPanel category (single selection)', …)` with:

```ts
describe('ProductFilterPanel categories (spec 2026-10-12 §5.1)', () => {
  beforeEach(() => replace.mockClear());

  it('leaf picks accumulate as chips and apply as repeated leaf params, with the department', () => {
    renderPanel();
    change('Department', 'Home & Kitchen');
    pickCategory('Desk Lamps');
    pickCategory('Jigsaw Puzzles');
    expect(screen.getAllByRole('button', { name: /^Remove / })).toHaveLength(2);
    fireEvent.click(applyButton());
    expect(replace).toHaveBeenLastCalledWith(
      `/products?${productFiltersToSearchParams({ ...PRODUCT_DEFAULTS, dept: 'Home & Kitchen', leafPaths: [LEAVES[0], LEAVES[2]] })}`,
      { scroll: false },
    );
    fireEvent.click(screen.getByRole('button', { name: `Remove ${LEAVES[0]}` }));
    expect(screen.getAllByRole('button', { name: /^Remove / })).toHaveLength(1);
  });

  it('a department the list lacks (from the URL) still shows as the selected option', () => {
    renderPanel({ ...PRODUCT_DEFAULTS, dept: 'Appliances' });
    expect(control('Department')).toHaveDisplayValue('Appliances');
    expect(optionTexts('Department')).toEqual(['All departments', ...DEPARTMENTS, 'Appliances']);
  });

  it('Custom mode lists the custom categories with their leaf counts; checked ones apply as the custom param and drop the leaf picks', () => {
    renderPanel(SEEDED);
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    expect(screen.getByRole('button', { name: 'Custom' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByLabelText('Add leaf category')).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Lamps (2)' })).not.toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Lamps (2)' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Puzzles & lamps (2)' }));
    expect(screen.getByText('2 selected → 3 leaves')).toBeInTheDocument();
    fireEvent.click(applyButton());
    expect(replace).toHaveBeenLastCalledWith(
      `/products?${productFiltersToSearchParams({ ...SEEDED, leafPaths: [], customCategoryIds: [CUSTOM[0].id, CUSTOM[1].id], page: 1 })}`,
      { scroll: false },
    );
  });

  it('opens in Custom mode when the applied filters carry custom ids, with those boxes checked', () => {
    renderPanel({ ...PRODUCT_DEFAULTS, customCategoryIds: [CUSTOM[1].id] });
    expect(screen.getByRole('button', { name: 'Custom' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('checkbox', { name: 'Puzzles & lamps (2)' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Lamps (2)' })).not.toBeChecked();
    expect(screen.getByText('1 selected → 2 leaves')).toBeInTheDocument();
    expect(applyButton()).toBeDisabled();
  });

  it('switching back to Leaf mode applies the picks and drops the custom ids', () => {
    renderPanel({ ...PRODUCT_DEFAULTS, customCategoryIds: [CUSTOM[0].id] });
    fireEvent.click(screen.getByRole('button', { name: 'Leaf' }));
    pickCategory('Floor Lamps');
    fireEvent.click(applyButton());
    expect(replace).toHaveBeenLastCalledWith(`/products?${productFiltersToSearchParams({ ...PRODUCT_DEFAULTS, leafPaths: [LEAVES[1]] })}`, { scroll: false });
  });

  it('says where to build one when the account has no custom categories', () => {
    renderPanel(PRODUCT_DEFAULTS, []);
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    expect(screen.getByText(/No custom categories yet — build one in the Category Builder tab/)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });
});
```

In `describe('filtersToPending / pendingToFilters')` add:

```ts
  it('derives the mode from the applied filters, and the active mode wins on the way back (custom ids drop leaf picks and vice versa)', () => {
    expect(filtersToPending(SEEDED).leafMode).toBe('leaf');
    expect(filtersToPending({ ...PRODUCT_DEFAULTS, customCategoryIds: [CUSTOM[0].id] }).leafMode).toBe('custom');
    const hybrid = { ...PRODUCT_DEFAULTS, leafPaths: [LEAVES[0]], customCategoryIds: [CUSTOM[0].id] };
    expect(pendingToFilters(filtersToPending(hybrid))).toEqual({ ...PRODUCT_DEFAULTS, customCategoryIds: [CUSTOM[0].id] });
    expect(pendingToFilters({ ...filtersToPending(hybrid), leafMode: 'leaf' })).toEqual({ ...PRODUCT_DEFAULTS, leafPaths: [LEAVES[0]] });
    expect(pendingToFilters({ ...filtersToPending(PRODUCT_DEFAULTS), dept: '' }).dept).toBeNull();
  });
```

The `Reset` case: add `expect(control('Department')).toHaveDisplayValue('All departments');`.

Retire `cat` in the other tests: `lib/products/filters.test.ts` — remove `cat` from `FULL` and from the 'parses every filter' input/expected literal (and the `cat=…&` segment from the round-trip URL string), delete the two `cat` assertions in 'caps page and the category path length' and 'trims the category path…' (the `dept` case of Task 1 covers trimming and length), and add `it('ignores the retired cat key', () => expect(parseProductFilters({ cat: 'Tools › Bath' })).toEqual(PRODUCT_DEFAULTS));`. `app/(app)/products/ProductResultsTable.test.tsx` — in "the from it sends is the ASIN page back control's products list…" parse `{ age: '180', leaf: 'Home & Kitchen › Lighting', sort: 'listed', dir: 'asc', page: '2', from: '/explorer' }` and expect `'/products?age=180&leaf=Home+%26+Kitchen+%E2%80%BA+Lighting&sort=listed&dir=asc&page=2'`.

- [ ] **Step 2: Run to see them fail** — `pnpm vitest run "app/(app)/products/ProductFilterPanel.test.tsx" lib/products/filters.test.ts` → FAIL.

- [ ] **Step 3: Implement the panel** — `app/(app)/products/ProductFilterPanel.tsx`. Pending state: replace `cat: string | null;` with

```ts
  dept: string;
  leafPaths: string[];
  /** Which side of the Leaf | Custom toggle is open; only that side's selection is applied. */
  leafMode: 'leaf' | 'custom';
  customCategoryIds: string[];
```

`filtersToPending`: replace `cat: f.cat,` with

```ts
    dept: f.dept ?? '',
    leafPaths: f.leafPaths,
    // The Explorer's rule: custom ids in the applied filters open the Custom side.
    leafMode: f.customCategoryIds.length > 0 ? 'custom' : 'leaf',
    customCategoryIds: f.customCategoryIds,
```

`pendingToFilters`: replace `cat: p.cat,` with

```ts
    dept: p.dept === '' ? null : p.dept,
    leafPaths: p.leafMode === 'leaf' ? p.leafPaths : [],
    customCategoryIds: p.leafMode === 'custom' ? p.customCategoryIds : [],
```

Props and derived values:

```tsx
export interface PanelCustomCategory { id: string; name: string; leafPaths: string[] }

export function ProductFilterPanel({
  filters, departments, leafCategories, customCategories,
}: {
  filters: ProductFilters;
  /** The catalog's root departments (lib/products/listCategories). */
  departments: string[];
  /** The catalog's distinct category paths, the typeahead's options. */
  leafCategories: string[];
  /** The signed-in user's custom categories (lib/customCategories/loadServer). */
  customCategories: ReadonlyArray<PanelCustomCategory>;
}) {
```

After `const ratioOptions = …` add

```tsx
  // A department from a hand-edited URL that the list lacks still shows as the selected option.
  const departmentOptions = pending.dept === '' || departments.includes(pending.dept) ? departments : [...departments, pending.dept];
  const toggleCustom = (id: string) =>
    set('customCategoryIds', pending.customCategoryIds.includes(id) ? pending.customCategoryIds.filter((x) => x !== id) : [...pending.customCategoryIds, id]);
  const selectedCustom = customCategories.filter((c) => pending.customCategoryIds.includes(c.id));
  const uniqueLeaves = new Set(selectedCustom.flatMap((c) => c.leafPaths)).size;
  const MODE_BUTTON = 'flex-1 px-2 py-1';
  const modeClass = (on: boolean) => `${MODE_BUTTON} ${on ? 'bg-[#0B1E3A] text-white' : 'bg-white text-gray-700 hover:bg-slate-50'}`;
```

Replace the `<Field label="Category">…</Field>` block with

```tsx
            <Field label="Department" htmlFor="pf-dept">
              <select id="pf-dept" value={pending.dept} onChange={(e) => set('dept', e.target.value)} className={INPUT}>
                <option value="">All departments</option>
                {departmentOptions.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Leaf categories">
              {/* Leaf | Custom segmented toggle, as the explorer sidebar's. */}
              <div className="mb-2 flex overflow-hidden rounded-full border border-slate-300 text-xs font-medium">
                <button type="button" aria-pressed={pending.leafMode === 'leaf'} onClick={() => set('leafMode', 'leaf')} className={modeClass(pending.leafMode === 'leaf')}>
                  Leaf
                </button>
                <button
                  type="button"
                  aria-pressed={pending.leafMode === 'custom'}
                  onClick={() => set('leafMode', 'custom')}
                  className={`border-l border-slate-300 ${modeClass(pending.leafMode === 'custom')}`}
                >
                  Custom
                </button>
              </div>
              {pending.leafMode === 'leaf' ? (
                <>
                  <LeafCategoryTypeahead options={leafCategories} selected={pending.leafPaths} onChange={(next) => set('leafPaths', next)} />
                  <p className={HINT}>
                    {leafCategories.length.toLocaleString('en-US')} categories — type to search, click or Enter to add. Each pick includes its sub-categories; several
                    match with OR.
                  </p>
                </>
              ) : customCategories.length === 0 ? (
                <p className={HINT}>No custom categories yet — build one in the Category Builder tab.</p>
              ) : (
                <>
                  <div className="space-y-1">
                    {customCategories.map((c) => (
                      <label key={c.id} className="flex items-center gap-2 text-sm">
                        <input type="checkbox" checked={pending.customCategoryIds.includes(c.id)} onChange={() => toggleCustom(c.id)} />
                        <span>
                          {c.name} <span className="text-gray-400">({c.leafPaths.length})</span>
                        </span>
                      </label>
                    ))}
                  </div>
                  {selectedCustom.length > 0 && (
                    <p className={HINT}>
                      {selectedCustom.length} selected → {uniqueLeaves} leaves
                    </p>
                  )}
                </>
              )}
            </Field>
```

(The checkbox's accessible name is the label's text, `Lamps (2)`.) Update the component's doc comment: the panel takes the three lists; Leaf mode applies picks, Custom mode applies ids, never both.

Retire `cat`: `lib/products/filterParams.ts` — delete `cat: string | null;` from the type, `cat: null,` from the defaults and `set('cat', f.cat, null);` from the serializer. `lib/products/filters.ts` — delete the `cat:` schema line and `cat: one(sp.cat) ?? null,` from `raw`. `lib/research/contracts.ts` `toProductFilters` — delete the `cat: f.categoryPath ?? PRODUCT_DEFAULTS.cat,` line (the interim `leafPaths` mapping stays until Task 8). `app/(app)/products/(list)/page.tsx` — the panel call becomes `<ProductFilterPanel key={panelKey} filters={filters} departments={[]} leafCategories={leafCategories} customCategories={[]} />` for now (Task 6 wires the real lists), so the tree type-checks at this commit.

- [ ] **Step 4: Run** — `pnpm vitest run "app/(app)/products" lib/products lib/research/products.test.ts && pnpm exec eslint "app/(app)/products/ProductFilterPanel.tsx" "app/(app)/products/ProductFilterPanel.test.tsx" lib/products/filterParams.ts lib/products/filters.ts lib/products/filters.test.ts lib/research/contracts.ts "app/(app)/products/ProductResultsTable.test.tsx" "app/(app)/products/(list)/page.tsx" && pnpm typecheck` → PASS.

- [ ] **Step 5: Commit** → `feat(products): Department select and Leaf | Custom category picker on the Products filter panel; cat retired`.

---

### Task 6: Page wiring — the admin's custom categories, the three lists, the scope

**Files:**
- Modify: `app/(app)/products/(list)/page.tsx`, `app/(app)/products/(list)/page.test.tsx`

Read `node_modules/next/dist/docs/01-app/02-guides/caching-without-cache-components.md` (the `unstable_cache` section) and the `page.js` reference before editing.

- [ ] **Step 1: Failing tests** — `app/(app)/products/(list)/page.test.tsx`. Replace the `data` mock block and the `listLeafCategories` mock with

```ts
const data = vi.hoisted(() => ({ search: vi.fn(), departments: vi.fn(), paths: vi.fn(), custom: vi.fn(), expand: vi.fn() }));
vi.mock('@/lib/products/searchProducts', async (orig) => ({
  ...(await orig<typeof import('@/lib/products/searchProducts')>()),
  searchProducts: data.search,
}));
vi.mock('@/lib/products/listCategories', () => ({ listProductDepartments: data.departments, listProductCategoryPaths: data.paths }));
vi.mock('@/lib/customCategories/loadServer', () => ({ listCustomCategoriesForUser: data.custom }));
vi.mock('@/lib/customCategories/expand', () => ({ expandCustomCategories: data.expand }));
```

Add `import { EMPTY_CATEGORY_SCOPE } from '@/lib/products/categoryPredicate';`, give `RESULT.rows[0]` its `categoryPath` (Task 3 did), and in `beforeEach` replace `data.leaves.mockResolvedValue(…)` with

```ts
    data.departments.mockResolvedValue(['Home & Kitchen', 'Pet Supplies']);
    data.paths.mockResolvedValue(['Home & Kitchen › Lighting › Desk Lamps']);
    data.custom.mockResolvedValue([{ id: '11111111-1111-4111-8111-000000000001', name: 'Lamps', leafPaths: ['Home & Kitchen › Lighting › Desk Lamps'], createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' }]);
    data.expand.mockResolvedValue([]);
```

In the two redirect cases replace `expect(data.leaves).not.toHaveBeenCalled();` with `for (const fn of [data.departments, data.paths, data.custom, data.expand]) expect(fn).not.toHaveBeenCalled();`. In the admin case replace the `[runner, filters]` destructuring lines with

```ts
    const [runner, filters, scope] = data.search.mock.calls[0] as [SqlRunner, unknown, unknown];
    expect(filters).toEqual({ ...PRODUCT_DEFAULTS, age: 180, sort: 'price', dir: 'asc' });
    expect(scope).toEqual(EMPTY_CATEGORY_SCOPE);
```

and replace `expect(data.leaves).toHaveBeenCalledTimes(1);` with

```ts
    expect(data.departments).toHaveBeenCalledTimes(1);
    expect(data.paths).toHaveBeenCalledTimes(1);
    expect(data.custom).toHaveBeenCalledWith('a1');
    expect(data.expand).toHaveBeenCalledWith('a1', [], []);
    expect(screen.getByLabelText('Department')).toHaveDisplayValue('All departments');
```

Add a case:

```ts
  it("expands the admin's custom categories into exact paths for the query and keeps the ids in the filters", async () => {
    const ID = '11111111-1111-4111-8111-000000000001';
    data.expand.mockResolvedValue(['Home & Kitchen › Lighting › Desk Lamps']);
    render(<>{await resolveAsync(await callPage({ dept: 'Home & Kitchen', custom: ID }))}</>);
    const [, filters, scope] = data.search.mock.calls[0] as [SqlRunner, unknown, unknown];
    expect(filters).toEqual({ ...PRODUCT_DEFAULTS, dept: 'Home & Kitchen', customCategoryIds: [ID] });
    expect(scope).toEqual({ dept: 'Home & Kitchen', subtreePaths: [], exactPaths: ['Home & Kitchen › Lighting › Desk Lamps'], scoped: true });
    expect(data.expand).toHaveBeenCalledWith('a1', [ID], []);
    expect(screen.getByRole('checkbox', { name: 'Lamps (1)' })).toBeChecked();
  });
```

- [ ] **Step 2: Run to see them fail** — `pnpm vitest run "app/(app)/products/(list)/page.test.tsx"` → FAIL.

- [ ] **Step 3: Implement** — `app/(app)/products/(list)/page.tsx`: imports become

```ts
import type { User } from '@/db/schema';
import { requireAdmin, AuthError } from '@/lib/auth/requireAdmin';
import { expandCustomCategories } from '@/lib/customCategories/expand';
import { listCustomCategoriesForUser } from '@/lib/customCategories/loadServer';
import { parseProductFilters, productFiltersToSearchParams, type ProductFilters, type SearchParamsLike } from '@/lib/products/filters';
import { pageCategoryScope } from '@/lib/products/categoryPredicate';
import { listProductCategoryPaths, listProductDepartments } from '@/lib/products/listCategories';
import { searchProducts, neonRunner } from '@/lib/products/searchProducts';
```

(drop the `listLeafCategories` import). The page keeps the user:

```tsx
export default async function ProductsPage({ searchParams }: { searchParams: Promise<SearchParamsLike> }) {
  // Page-level gate, as app/admin/keepa-enrichment/page.tsx does it … (comment unchanged)
  let user: User;
  try {
    user = await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) redirect(e.code === 'UNAUTHENTICATED' ? '/sign-in' : '/explorer');
    throw e;
  }
  const filters = parseProductFilters(await searchParams);
  return (
    <Suspense fallback={<ProductsSkeleton />}>
      <ProductsResults filters={filters} userId={user.id} />
    </Suspense>
  );
}

/**
 * The page's reads, in parallel, and the moment they finished. The custom-category ids expand (owner-scoped, unknown
 * ids skipped) before the search they scope; the three option lists load alongside. The clock is read once, here on
 * the server … (rest of the comment unchanged)
 */
async function loadProductsPage(filters: ProductFilters, userId: string) {
  const sql = neon(env.DATABASE_URL);
  const searched = expandCustomCategories(userId, filters.customCategoryIds, []).then((customPaths) =>
    searchProducts(neonRunner(sql), filters, pageCategoryScope(filters, customPaths)),
  );
  const [result, departments, leafCategories, customCategories] = await Promise.all([
    searched, listProductDepartments(), listProductCategoryPaths(), listCustomCategoriesForUser(userId),
  ]);
  return { result, departments, leafCategories, customCategories, now: new Date() };
}

async function ProductsResults({ filters, userId }: { filters: ProductFilters; userId: string }) {
  const { result, departments, leafCategories, customCategories, now } = await loadProductsPage(filters, userId);
  const panelKey = productFiltersToSearchParams({ ...filters, page: 1 }).toString();
  return (
    <div className="flex">
      <ProductFilterPanel key={panelKey} filters={filters} departments={departments} leafCategories={leafCategories} customCategories={customCategories} />
      <div className="min-w-0 flex-1 p-6">
        <ProductResultsTable rows={result.rows} total={result.total} totalIsCapped={result.totalIsCapped} filters={filters} now={now} />
        <ProductPagination page={filters.page} total={result.total} totalIsCapped={result.totalIsCapped} pageSize={result.pageSize} />
      </div>
    </div>
  );
}
```

Update the file's header comment step 2: "behind <Suspense>, expand the custom ids, run the product search, and read the department, path and custom-category lists".

- [ ] **Step 4: Run** — `pnpm vitest run "app/(app)/products" && pnpm exec eslint "app/(app)/products/(list)/page.tsx" "app/(app)/products/(list)/page.test.tsx" && pnpm typecheck` → PASS.

- [ ] **Step 5: Commit** → `feat(products): the list page expands custom categories and feeds the panel its department, path and custom lists`.

---

### Task 7: The Category column

**Files:**
- Modify: `app/(app)/products/ProductResultsTable.tsx`, `app/(app)/products/ProductResultsTable.test.tsx`

- [ ] **Step 1: Failing tests** — in 'formats one full row': `expect(cells).toHaveLength(10);` and, after the Amazon-link assertions, insert

```ts
    expect(cells[1]).toHaveTextContent(/^Desk Lamps$/);
    expect(within(cells[1]).getByText('Desk Lamps')).toHaveAttribute('title', 'Home & Kitchen › Lighting › Desk Lamps');
```

then shift every later index by one (`cells[2]` Aug 1, `cells[3]` 1,000+, `cells[4]` reviews, `cells[5]` $19.99, `cells[6]` BSR + chip, `cells[7]` offers, `cells[8]` Amazon, `cells[9]` 7). In 'missing values render as dashes…' add `categoryPath: null,` to the row, loop `for (const i of [1, 2, 3, 4, 5, 6, 7, 8])` and `expect(cells[9]).toHaveTextContent(/^0$/)`. In the `+30%` chip case use `bodyCells(0)[6]` and `bodyCells(1)[6]`; in the compact-reviews case `bodyCells()[4]`. Add to `describe('ProductResultsTable sortable headers')` nothing; add a header check to 'formats one full row': `expect(screen.getByRole('columnheader', { name: 'Category' })).toBeInTheDocument();`.

- [ ] **Step 2: Run to see them fail** — `pnpm vitest run "app/(app)/products/ProductResultsTable.test.tsx"` → FAIL.

- [ ] **Step 3: Implement** — `app/(app)/products/ProductResultsTable.tsx`: `import { splitCategoryPath } from '@/lib/categoryBuilder/pathDisplay';`. In the header row, after `<th className="p-2">Product</th>` add `<th className="p-2" title="The product's Keepa category (leaf); hover a cell for the full path">Category</th>`. In `ProductRow`, after the product `</td>` add

```tsx
      <td className="max-w-40 p-2 text-xs text-gray-700">
        {row.categoryPath ? (
          <span className="block truncate" title={row.categoryPath}>
            {splitCategoryPath(row.categoryPath).leaf}
          </span>
        ) : (
          orDash(DASH)
        )}
      </td>
```

- [ ] **Step 4: Run** — `pnpm vitest run "app/(app)/products" lib/products/filterParams.test.ts && pnpm exec eslint "app/(app)/products/ProductResultsTable.tsx" "app/(app)/products/ProductResultsTable.test.tsx" && pnpm typecheck` → PASS (`filterParams.test.ts` re-checks that the client components import `lib/products` values only from the allowed modules; `pathDisplay` is outside `lib/products`, so it is fine).

- [ ] **Step 5: Commit** → `feat(products): Category column (leaf, full path on hover) in the results table`.

---

### Task 8: The tool's department and categories (resolved and validated scope)

**Files:**
- Modify: `lib/research/contracts.ts`, `lib/research/products.ts`, `lib/research/products.test.ts`

- [ ] **Step 1: Failing tests** — `lib/research/products.test.ts`. Extend `makeDeps`:

```ts
const DEPARTMENTS = ['Health & Household', 'Pet Supplies'];
const CATALOG_PATHS = [
  'Health & Household', 'Health & Household › Vitamins', 'Health & Household › Vitamins › Magnesium',
  'Pet Supplies › Cats › Toys', 'Pet Supplies › Dogs › Toys', 'Pet Supplies › Dogs › Toys › Chew Toys',
];
const CUSTOM_ID = '11111111-1111-4111-8111-000000000001';
const OTHER_ID = '22222222-2222-4222-8222-000000000002';
// … inside makeDeps' returned object:
    departments: vi.fn(async () => DEPARTMENTS),
    categoryPaths: vi.fn(async () => CATALOG_PATHS),
    customRows: vi.fn(async (_userId: string, ids: string[]) => (ids.includes(CUSTOM_ID) ? [{ id: CUSTOM_ID, leafPaths: ['Pet Supplies › Dogs › Toys › Chew Toys', 'Pet Supplies › Cats › Toys'] }] : [])),
```

Add a describe:

```ts
describe('searchProductsForTool: department and categories (spec 2026-10-12 §6)', () => {
  const notAvailable = async (deps: ProductsDeps, input: unknown) => {
    const err = await searchProductsForTool(deps, admin, input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResearchError);
    expect((err as ResearchError).code).toBe('CATEGORY_NOT_AVAILABLE');
    expect(deps.search).not.toHaveBeenCalled();
    expect(deps.record).not.toHaveBeenCalled();
    return err as ResearchError;
  };

  it('a department is checked against the catalog list and becomes dept; the scope is otherwise empty', async () => {
    const deps = makeDeps();
    await searchProductsForTool(deps, admin, { filters: { department: 'Pet Supplies' } });
    expect(deps.search).toHaveBeenCalledWith({ ...PRODUCT_DEFAULTS, dept: 'Pet Supplies' }, { dept: 'Pet Supplies', subtreePaths: [], exactPaths: [], scoped: false });
    expect(deps.categoryPaths).not.toHaveBeenCalled();
    expect(deps.customRows).not.toHaveBeenCalled();
  });
  it('an unknown department fails with the valid names in the message and the field in details', async () => {
    const err = await notAvailable(makeDeps(), { filters: { department: 'Pets' } });
    expect(err.message).toContain('"Pets"');
    expect(err.message).toContain('Health & Household; Pet Supplies');
    expect(err.details).toEqual([{ path: 'filters.department', message: 'unknown department' }]);
  });
  it('taxonomy selections are subtrees by default and exact without descendants; leafPaths are exact; all checked against the catalog', async () => {
    const deps = makeDeps();
    await searchProductsForTool(deps, admin, {
      filters: { categories: { selections: [{ kind: 'taxonomy', path: 'Pet Supplies › Dogs › Toys' }, { kind: 'taxonomy', path: 'Health & Household › Vitamins', includeDescendants: false }], leafPaths: ['Pet Supplies › Cats › Toys'] } },
    });
    expect(deps.search).toHaveBeenCalledWith({ ...PRODUCT_DEFAULTS }, { dept: null, subtreePaths: ['Pet Supplies › Dogs › Toys'], exactPaths: ['Health & Household › Vitamins', 'Pet Supplies › Cats › Toys'], scoped: true });
  });
  it('a subtree path may be a parent of catalog paths without being one itself; an exact path must be an entry', async () => {
    const deps = makeDeps();
    await searchProductsForTool(deps, admin, { filters: { categories: { selections: [{ kind: 'taxonomy', path: 'Pet Supplies › Dogs' }] } } });
    expect(deps.search).toHaveBeenCalledWith({ ...PRODUCT_DEFAULTS }, { dept: null, subtreePaths: ['Pet Supplies › Dogs'], exactPaths: [], scoped: true });
    const err = await notAvailable(makeDeps(), { filters: { categories: { selections: [{ kind: 'taxonomy', path: 'Pet Supplies › Dogs', includeDescendants: false }] } } });
    expect(err.details).toEqual([{ path: 'filters.categories.selections[0].path', message: 'not a category path of the product catalog' }]);
  });
  it('an unknown path fails, naming the field, and nothing runs', async () => {
    const err = await notAvailable(makeDeps(), { filters: { categories: { leafPaths: ['Pet Supplies › Birds'] } } });
    expect(err.message).toContain('"Pet Supplies › Birds"');
    expect(err.details).toEqual([{ path: 'filters.categories.leafPaths[0]', message: 'not a category path of the product catalog' }]);
  });
  it("a custom selection expands to the account's stored paths, exactly; an unknown or foreign id fails", async () => {
    const deps = makeDeps();
    await searchProductsForTool(deps, admin, { filters: { department: 'Pet Supplies', categories: { selections: [{ kind: 'custom', id: CUSTOM_ID.toUpperCase() }] } } });
    expect(deps.customRows).toHaveBeenCalledWith('u1', [CUSTOM_ID]);
    expect(deps.search).toHaveBeenCalledWith({ ...PRODUCT_DEFAULTS, dept: 'Pet Supplies' }, { dept: 'Pet Supplies', subtreePaths: [], exactPaths: ['Pet Supplies › Dogs › Toys › Chew Toys', 'Pet Supplies › Cats › Toys'], scoped: true });
    const err = await notAvailable(makeDeps(), { filters: { categories: { selections: [{ kind: 'custom', id: OTHER_ID }] } } });
    expect(err.details).toEqual([{ path: 'filters.categories.selections[0].id', message: 'unknown custom category id' }]);
  });
  it('an empty categories object scopes nothing; paths are deduplicated', async () => {
    const deps = makeDeps();
    await searchProductsForTool(deps, admin, { filters: { categories: {} } });
    expect(deps.search).toHaveBeenCalledWith({ ...PRODUCT_DEFAULTS }, EMPTY_CATEGORY_SCOPE);
    const dup = makeDeps();
    await searchProductsForTool(dup, admin, { filters: { categories: { leafPaths: ['Pet Supplies › Cats › Toys', 'Pet Supplies › Cats › Toys'] } } });
    expect(dup.search).toHaveBeenCalledWith({ ...PRODUCT_DEFAULTS }, { dept: null, subtreePaths: [], exactPaths: ['Pet Supplies › Cats › Toys'], scoped: true });
  });
  it('resolves the scope after the reserve and before the search (the keyword tools\u2019 order)', async () => {
    const deps = makeDeps();
    await searchProductsForTool(deps, admin, { filters: { department: 'Pet Supplies' } });
    expect(firstCall(deps.reserve)).toBeLessThan(firstCall(deps.departments));
    expect(firstCall(deps.departments)).toBeLessThan(firstCall(deps.search));
  });
  it('the retired categoryPath field is rejected as INVALID_FILTERS', async () => {
    await expect(searchProductsForTool(makeDeps(), admin, { filters: { categoryPath: 'Pet Supplies' } })).rejects.toMatchObject({ code: 'INVALID_FILTERS' });
  });
});
```

Update `describe('defaultProductsDeps')`: the keys become `['categoryPaths', 'customRows', 'departments', 'facts', 'history', 'keywords', 'search']` and the `typeof … 'function'` loop covers them.

- [ ] **Step 2: Run to see them fail** — `pnpm vitest run lib/research/products.test.ts` → FAIL.

- [ ] **Step 3: Implement** — `lib/research/contracts.ts`: in `productSearchFiltersSchema` delete the `categoryPath` field and add, after `bsrRatioMax`:

```ts
    department: z.string().trim().min(1).max(MAX_CATEGORY_PATH_LENGTH).optional().describe(
      "One of the catalog's Keepa root departments, spelled exactly ('Health & Household', 'Pet Supplies'): the product's own storefront department, not the keyword report's broad category. Matches the department at any depth. An unknown name fails with CATEGORY_NOT_AVAILABLE and the valid names.",
    ),
    categories: categoriesSchema.optional().describe(
      "The object search_keywords takes: selections from resolve_categories (several = OR) and leafPaths. A taxonomy selection matches the path and everything under it unless includeDescendants is false; a custom selection matches the paths that custom category stores, exactly; leafPaths match exactly. Paths are checked against the product catalog (keyword-side paths almost always exist there); an unknown path or custom id fails with CATEGORY_NOT_AVAILABLE, never an empty page.",
    ),
```

In `toProductFilters` replace the interim lines with `dept: f.department ?? PRODUCT_DEFAULTS.dept, leafPaths: [], customCategoryIds: [],` and a comment: "the categories object is resolved into the search scope by lib/research/products.ts, not into the page filters". Update the section comment above the schema to mention the two category fields.

`lib/research/products.ts`: imports gain `import { PATH_SEP } from '@/lib/categoryBuilder/buildTree';`, `import { listProductCategoryPaths, listProductDepartments } from '@/lib/products/listCategories';`, `import { EMPTY_CATEGORY_SCOPE, type ProductCategoryScope } from '@/lib/products/categoryPredicate';`, `import { loadCustomRows, type CustomRow } from './categories';` and `type ProductSearchInput` from `./contracts` (drop `pageCategoryScope`). `ProductLoaders` gains

```ts
  /** The catalog's departments and distinct category paths (lib/products/listCategories, cached an hour), for a search's category scope. */
  departments: () => Promise<string[]>;
  categoryPaths: () => Promise<string[]>;
  /** The actor's own custom categories by id; unknown and foreign ids are absent (lib/research/categories.ts loadCustomRows). */
  customRows: (userId: string, ids: string[]) => Promise<CustomRow[]>;
```

`defaultProductsDeps` adds `departments: () => listProductDepartments(), categoryPaths: () => listProductCategoryPaths(), customRows: (userId, ids) => loadCustomRows(userId, ids),`. Add:

```ts
type ProductSearchFilters = NonNullable<ProductSearchInput['filters']>;
type ScopeDeps = Pick<ProductLoaders, 'departments' | 'categoryPaths' | 'customRows'>;
const PATH_NOT_AVAILABLE = 'not a category path of the product catalog';

function pathNotAvailable(path: string, at: string): ResearchError {
  return new ResearchError(
    'CATEGORY_NOT_AVAILABLE',
    `"${path}" is not a category path of the product catalog (paths from resolve_categories almost always are; check the spelling and the ' › ' separators).`,
    { details: [{ path: at, message: PATH_NOT_AVAILABLE }] },
  );
}

/**
 * The search's category scope (spec 2026-10-12 §6): the department checked against the catalog's list;
 * taxonomy selections as subtrees (includeDescendants, the default) or exact paths; custom selections as
 * the account's stored paths, exactly; leafPaths exactly. Every path is checked against the catalog's path
 * list — an exact path must be an entry, a subtree path an entry or a proper prefix of one — and every
 * custom id must be the actor's own. Any miss is CATEGORY_NOT_AVAILABLE naming the field: never a silent
 * skip, never an empty page for a typo. An absent or empty categories object scopes nothing.
 */
export async function resolveProductCategoryScope(deps: ScopeDeps, actor: ResearchActor, filters: ProductSearchFilters): Promise<ProductCategoryScope> {
  const dept = filters.department ?? null;
  if (dept !== null) {
    const departments = await deps.departments();
    if (!departments.includes(dept)) {
      throw new ResearchError('CATEGORY_NOT_AVAILABLE', `"${dept}" is not a department of the product catalog. Pass one of: ${departments.join('; ')}.`, {
        details: [{ path: 'filters.department', message: 'unknown department' }],
      });
    }
  }
  const categories = filters.categories;
  if (!categories || (categories.selections.length === 0 && categories.leafPaths.length === 0)) return { ...EMPTY_CATEGORY_SCOPE, dept };

  const subtree: Array<{ path: string; at: string }> = [];
  const exact: Array<{ path: string; at: string }> = [];
  const customIds: Array<{ id: string; at: string }> = [];
  categories.selections.forEach((sel, i) => {
    const at = `filters.categories.selections[${i}]`;
    if (sel.kind === 'custom') customIds.push({ id: sel.id, at: `${at}.id` });
    else (sel.includeDescendants ? subtree : exact).push({ path: sel.path, at: `${at}.path` });
  });
  categories.leafPaths.forEach((path, i) => exact.push({ path, at: `filters.categories.leafPaths[${i}]` }));

  if (subtree.length > 0 || exact.length > 0) {
    const catalog = await deps.categoryPaths();
    const known = new Set(catalog);
    for (const { path, at } of exact) if (!known.has(path)) throw pathNotAvailable(path, at);
    for (const { path, at } of subtree) {
      if (!known.has(path) && !catalog.some((entry) => entry.startsWith(path + PATH_SEP))) throw pathNotAvailable(path, at);
    }
  }
  const exactPaths = exact.map((e) => e.path);
  if (customIds.length > 0) {
    const rows = await deps.customRows(actor.localUserId, [...new Set(customIds.map((c) => c.id))]);
    const found = new Map(rows.map((r) => [r.id, r.leafPaths]));
    for (const { id, at } of customIds) {
      const paths = found.get(id);
      if (!paths) {
        throw new ResearchError('CATEGORY_NOT_AVAILABLE', 'That custom category does not exist for this account. List yours with resolve_categories and pick from its custom candidates.', {
          details: [{ path: at, message: 'unknown custom category id' }],
        });
      }
      exactPaths.push(...paths);
    }
  }
  return { dept, subtreePaths: [...new Set(subtree.map((s) => s.path))], exactPaths: [...new Set(exactPaths)], scoped: true };
}
```

In `searchProductsForTool`, after `await deps.reserve(actor, PRODUCT_PAGE_SIZE);`: `const scope = await resolveProductCategoryScope(deps, actor, parsed.data.filters ?? {});` then `const result = await deps.search(filters, scope);`. Update the module header's order line to "refuse → validate → reserve → resolve the category scope → read → build → record".

- [ ] **Step 4: Run** — `pnpm vitest run lib/research lib/ask lib/mcp && pnpm exec eslint lib/research/contracts.ts lib/research/products.ts lib/research/products.test.ts && pnpm typecheck` → PASS (the guide test still passes: it reads the schema's field descriptions, which the new fields carry).

- [ ] **Step 5: Commit** → `feat(research): search_products takes department and the categories object, resolved and checked against the catalog`.

---

### Task 9: Tool description, guide rules, guide version

**Files:**
- Modify: `lib/research/tools.ts`, `lib/research/catalog.ts`, `lib/research/catalog.test.ts`, `lib/research/tools.test.ts` (only if it pins the description text)

- [ ] **Step 1: Failing tests** — `lib/research/catalog.test.ts`: change the two `toBe(3)` assertions on the guide version (lines ~229 and ~231) to `4`. In the products rules case add

```ts
    expect(rules).toContain("filters.department is one of the catalog's storefront departments");
    expect(rules).toContain("not the keyword report's broad category");
    expect(rules).toContain('filters.categories is the object search_keywords takes');
    expect(rules).toContain('matches the path and everything under it unless includeDescendants is false');
    expect(rules).toContain('an unknown path or custom id fails with CATEGORY_NOT_AVAILABLE, never an empty page');
    expect(unitsOf('department')).toContain('storefront department');
    expect(unitsOf('categories')).toContain('resolve_categories');
    expect(on.products?.filters.map((f) => f.name)).not.toContain('categoryPath');
```

Add to `lib/research/tools.test.ts` (next to the existing description assertions, or as a new case):

```ts
  it('search_products describes the department and categories filters', () => {
    const text = researchToolByName('search_products').description();
    expect(text).toContain("department (the product's Keepa storefront department, not the keyword report's broad category)");
    expect(text).toContain('filters.categories, the same object search_keywords takes');
  });
```

(Adjust the import of `researchToolByName` to the file's existing style.)

- [ ] **Step 2: Run to see them fail** — `pnpm vitest run lib/research/catalog.test.ts lib/research/tools.test.ts` → FAIL.

- [ ] **Step 3: Implement** — `lib/research/tools.ts` `searchProductsDescription()`: replace the first sentence with

```ts
    "Search the product catalog (Amazon ASINs with Keepa data) by listing age, monthly sold, reviews, rating, price, best sellers rank (BSR), BSR against its 30-day average, department (the product's Keepa storefront department, not the keyword report's broad category), categories, FBA offers and whether Amazon sells it; every filter is optional and they combine with AND.",
    "Categories go in filters.categories, the same object search_keywords takes: resolve_categories selections (several = OR; a taxonomy pick includes its sub-categories unless includeDescendants is false; a custom pick is that custom category's stored paths, exactly) and exact leafPaths. An unknown department, path or custom id fails with CATEGORY_NOT_AVAILABLE.",
```

`lib/research/catalog.ts`: `GUIDE_VERSION = 4`; in `PRODUCT_RULES` add after the second entry

```ts
  "Categories on products are the product's own Keepa category path. filters.department is one of the catalog's storefront departments (Health & Household, Pet Supplies, …), not the keyword report's broad category; an unknown name fails with CATEGORY_NOT_AVAILABLE and the message lists the valid names.",
  'filters.categories is the object search_keywords takes: resolve_categories selections (several = OR) and leafPaths. A taxonomy selection matches the path and everything under it unless includeDescendants is false; a custom selection matches the paths that custom category stores, exactly; leafPaths match exactly. Paths are checked against the product catalog, where almost every keyword-side path exists; an unknown path or custom id fails with CATEGORY_NOT_AVAILABLE, never an empty page.',
```

- [ ] **Step 4: Run** — `pnpm vitest run lib/research lib/ask lib/mcp && pnpm exec eslint lib/research/tools.ts lib/research/catalog.ts lib/research/catalog.test.ts lib/research/tools.test.ts && pnpm typecheck` → PASS.

- [ ] **Step 5: Commit** → `docs(research): search_products description and guide rules for department and categories; guide version 4`.

---

### Task 10: Integration cases (owner-gated, read-only)

**Files:**
- Modify: `tests/integration/productsQueries.test.ts`

- [ ] **Step 1: Add the cases** (the file skips without `RUN_INTEGRATION`; never run it here). Import `pageCategoryScope` next to `EMPTY_CATEGORY_SCOPE`. Add a constant `const CATEGORY_PATH_INDEX = 'asin_products_category_path_idx';` and these cases after the owner's search case:

```ts
  it(
    'a department-only search (the smallest department) is served by the category path index',
    async () => {
      await inReadOnlyTransaction(async () => {
        const picked = await client.query<{ category_root: string }>(
          "SELECT category_root FROM asin_products WHERE in_scope AND enrichment_status IN ('active', 'no_price') AND category_root IS NOT NULL GROUP BY 1 ORDER BY count(*) ASC LIMIT 1",
        );
        const dept = picked.rows[0].category_root;
        const q = productSearchSql(PRODUCT_DEFAULTS, pageCategoryScope({ ...PRODUCT_DEFAULTS, dept }, []));
        const { lines, seconds } = await explain(q.rows);
        console.log(`[productsQueries] department "${dept}" planned in ${seconds.toFixed(2)}s:\n${lines.join('\n')}`);
        expect(lines.join('\n')).toContain(CATEGORY_PATH_INDEX);
        const result = await searchProducts(run, PRODUCT_DEFAULTS, pageCategoryScope({ ...PRODUCT_DEFAULTS, dept }, []));
        for (const row of result.rows) expect(row.categoryPath === dept || row.categoryPath?.startsWith(`${dept} › `), `${row.asin} in ${dept}`).toBe(true);
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'a leaf pick matches its subtree through the path index',
    async () => {
      await inReadOnlyTransaction(async () => {
        // A mid-size path (enough rows to fill a page, few enough that the bitmap plan is the cheap one), the deepest such
        // path first: deep paths are leaves, so the subtree half of the predicate stays small and the plan stays on the index.
        const picked = await client.query<{ category_path: string }>(
          "SELECT category_path FROM asin_products WHERE in_scope AND enrichment_status IN ('active', 'no_price') AND category_path IS NOT NULL GROUP BY 1 HAVING count(*) BETWEEN 60 AND 400 ORDER BY length(category_path) DESC, category_path LIMIT 1",
        );
        const path = picked.rows[0].category_path;
        const scope = pageCategoryScope({ ...PRODUCT_DEFAULTS, leafPaths: [path] }, []);
        const { lines, seconds } = await explain(productSearchSql(PRODUCT_DEFAULTS, scope).rows);
        console.log(`[productsQueries] leaf "${path}" planned in ${seconds.toFixed(2)}s:\n${lines.join('\n')}`);
        expect(lines.join('\n')).toContain(CATEGORY_PATH_INDEX);
        const result = await searchProducts(run, PRODUCT_DEFAULTS, scope);
        expect(result.rows.length).toBeGreaterThanOrEqual(1);
        for (const row of result.rows) expect(row.categoryPath === path || row.categoryPath?.startsWith(`${path} › `), `${row.asin} under ${path}`).toBe(true);
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "a real custom category's paths match exactly through the path index",
    async (ctx) => {
      await inReadOnlyTransaction(async () => {
        // The smallest custom category: the index assertion is about the array form, and a huge path list could legitimately
        // send the planner to the sort index instead (it would still be correct, just a different plan).
        const picked = await client.query<{ leaf_paths: string[] }>('SELECT leaf_paths FROM custom_categories ORDER BY jsonb_array_length(leaf_paths) ASC LIMIT 1');
        const paths = picked.rows[0]?.leaf_paths;
        if (!paths || paths.length === 0) return ctx.skip('no custom category to test with');
        const scope = pageCategoryScope({ ...PRODUCT_DEFAULTS, customCategoryIds: ['11111111-1111-4111-8111-000000000001'] }, paths);
        const { lines, seconds } = await explain(productSearchSql(PRODUCT_DEFAULTS, scope).rows);
        console.log(`[productsQueries] custom category with ${paths.length} paths planned in ${seconds.toFixed(2)}s:\n${lines.join('\n')}`);
        expect(lines.join('\n')).toContain(CATEGORY_PATH_INDEX);
        const started = performance.now();
        const result = await searchProducts(run, PRODUCT_DEFAULTS, scope);
        console.log(`[productsQueries] custom category search ran in ${((performance.now() - started) / 1000).toFixed(2)}s: ${result.rows.length} rows, ${result.total}${result.totalIsCapped ? '+' : ''} matches`);
        const set = new Set(paths);
        for (const row of result.rows) expect(set.has(row.categoryPath ?? ''), `${row.asin}'s path is in the custom category`).toBe(true);
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'the option lists: 36-ish departments and about 22.7k distinct paths among the rows the page can show',
    async () => {
      await inReadOnlyTransaction(async () => {
        const counts = await client.query<{ departments: number; paths: number }>(
          "SELECT count(DISTINCT category_root)::int AS departments, count(DISTINCT category_path)::int AS paths FROM asin_products WHERE in_scope AND enrichment_status IN ('active', 'no_price')",
        );
        console.log(`[productsQueries] option lists: ${counts.rows[0].departments} departments, ${counts.rows[0].paths} paths`);
        expect(counts.rows[0].departments).toBeGreaterThanOrEqual(20);
        expect(counts.rows[0].paths).toBeGreaterThanOrEqual(10_000);
      });
    },
    TEST_TIMEOUT_MS,
  );
```

(The loaders themselves are not called here: `unstable_cache` needs Next's request scope; their statements are the ones above.) Extend the header comment's bullet list with the three category cases and the option-list count.

- [ ] **Step 2: Check it compiles** — vitest EXCLUDES `tests/integration/**` while RUN_INTEGRATION is unset (running the file alone reports "No test files found"), so the compile check is `pnpm exec eslint tests/integration/productsQueries.test.ts && pnpm typecheck` → PASS.

- [ ] **Step 3: Commit** → `test(products): integration cases for the department, leaf and custom-category predicates`.

---

## Landed shape (2026-10-12, before Task 11)

Every task's commit, two reviews and a nits round are recorded in the session's landing notes; the deviations that matter for a reader of this plan:

- **Task 1** needed a second commit: adding required fields to `ProductFilters` broke four full-literal sites the plan did not list (`toProductFilters`, `pendingToFilters`, the panel test's `SEEDED`, `contracts.test.ts`'s "maps every field"). `3313efa` alone does not type-check; `8d00038` completes it.
- **Task 3** also had to update `lib/research/service.test.ts` (a `ProductSummaryRow` fixture and a two-argument assertion); the neon driver was proven to send a JavaScript array as one Postgres array literal (the wire test recorded `[]` before the implementation).
- **Task 4** gained a recording `next/cache` mock, a React `cache()` wrapper on `listProductDepartments`, and the documented failure contract (`26905ff`).
- **Task 5** folded in the Task 1 review's parser hardening (dedupe, control characters, schema lower-casing, caps pinned to the Explorer) and, in `b03fcee`, the stale-custom-id notice, the order-insensitive dirty check and the a11y touches.
- **Task 6** tests pin that the lists reach the panel and that a failed expansion never searches (`05fe79c`).
- **Task 7** moved the tooltip to the cell and pins the header position (`b0f0f23`).
- **Task 8** needed `lib/research/service.test.ts` too, and a fix round: on products every taxonomy selection is a subtree whatever `includeDescendants` says (the keyword-side resolver marks leaves as having no descendants). The valid department names travel in the error message, not in `details`.
- **Task 9**'s tools test must call `description(DEFAULT_LIMITS)` (the plan's no-argument call does not type-check); the guide rules name `broadCategory` and disambiguate `categoryPath`.
- **Task 10** adds the largest-custom-category timing case and the per-department cache-entry size check; its leaf picker counts only badge-bearing rows.
- **Final review (ship) nits, `5c8a3d9`:** the list page degrades to empty category controls when a cold-fill list read fails (the catch sits in the page, outside the cached functions; the search and the custom-category read still fail the page); the departments cache callback holds its own statement (`fetchDepartmentsSorted`, since Next keys the entry on the callback's source — Task 4's inline arrow would have kept a stale key across a deploy that changed the SQL); the wire test covers quotes, backslashes and commas in the array literal.

### Final review (before Task 11)

- Full suite `pnpm vitest run` green; `pnpm typecheck` clean; `pnpm build` clean (the panel still imports no zod: `lib/products/filterParams.test.ts` guards it).
- Dispatch the whole-diff code review (spec compliance against `2026-10-12-products-category-filters-design.md`, then quality). Fix findings; re-run.
- Spec §14-style amendments, where landed decisions differ from the spec, went into the spec's §11 "Amendments as landed" (docs commit fd25810 and its follow-up).

---

### Task 11: Ship and smoke (owner-gated, in order)

1. **Push** (owner's go): `node --env-file=.env.local --import tsx scripts/checkActiveJobs.ts` quiet, then a bare `git push origin main`; watch the three deploys with `gh api repos/raw5045/AmazonAnalytics/commits/<sha>/status --jq '"overall: \(.state)", (.statuses[] | "\(.context): \(.state) @ \(.updated_at)")'`. The Keepa service and the worker restart with no change in them (clean `sigterm` handover expected); no Inngest sync.
2. **Integration test** (owner's go, after the push or before — read-only either way): `RUN_INTEGRATION=1 pnpm vitest run tests/integration/productsQueries.test.ts` → the three category cases print their plans with `asin_products_category_path_idx`.
3. **Page smoke** (owner, admin): `/products?dept=Pet%20Supplies` returns pet products with the Category column; two leaf picks in Leaf mode apply as two `leaf=` params and the rows sit under either; Custom mode shows the custom categories with counts, one checked returns rows whose paths are in it; each combined with monthly sold ≥ 1,000 and reviews ≤ 300; Reset clears all three; a non-admin is still redirected.
4. **Tools smoke** (owner, from Claude): "search products in the Pet Supplies department with 1,000+ monthly sold" → `search_products` with `department`; "products in my custom category <name>" → `resolve_categories` then `search_products` with a custom selection; a made-up department name → CATEGORY_NOT_AVAILABLE listing the departments; a non-admin connector still lacks the tools.

| Step | Date | Outcome | Notes |
|---|---|---|---|
| Push + deploys | 2026-10-12 | OK: pushed 13:47 UTC (cca065f → d477143, 30 commits incl. the Explorer custom-id fix); Railway worker + keepa-importer green by 13:49 UTC; Vercel created NO deployment for the push (second time after 2026-09-29) → empty commit c3ad8f4 pushed 14:03 UTC on the owner's go; Vercel green 14:05:10 UTC, both Railway services green 14:06 UTC | pre-push gate quiet (0 Keepa runs, 0 imports mid-phase); the Keepa service kept its 10-10 boot (no change in its files) and is idle by design — tier 1 fully refreshed, next due 2026-10-13 10:31 UTC, the tail lane disabled; no Inngest sync needed |
| Integration test | 2026-10-12 | OK: 12/12 in 13 s (read-only, before the push) | department-only (smallest, 'Alexa Skills'), leaf subtree and the smallest custom category (1 path) all plan as BitmapOr / Bitmap Index Scan on asin_products_category_path_idx; the largest custom category (1,355 paths) planned on the monthly_sold sort index instead and ran in 0.26 s with 10,000+ matches (both plans correct); option lists 34 departments / 23,025 paths; largest per-department cache entry = Books, 3,997 paths ≈ 339k chars (limit 2 MB; Clothing 1,912 paths ≈ 165k); the per-department loader statement for Books plans as a bitmap scan on the path index; the arc-7 cases (default view, owner search 0.46 s / 3,823 matches, loaders, stub) still pass |
| Page smoke | 2026-10-12 | PASS (run by Claude in the owner's signed-in built-in browser, ~14:10–14:20 UTC) | cold fill rendered 34 departments + 23,025 typeahead categories + the Category column; department only (Pet Supplies → `?dept=Pet+Supplies`, 10,000+ pet rows); two leaf picks with the department (Chew Toys + Plush Toys → two `leaf=` params, 320 rows, all chew/plush toys); Custom mode lists the four custom categories with counts, 'Supplements Custom' → `custom=<id>`, '1 selected → 206 leaves', supplement rows; + sold ≥ 1,000 + reviews ≤ 300 → 989 rows; an unowned custom id in the URL shows '1 selected custom category no longer exists and matches nothing' + Clear (0 products), Clear + a real tick re-applies cleanly; `?leaf=Appliances&sort=reviews&dir=asc` (a root-level pick by URL) → 2,138 rows under Appliances; `?dept=Alexa+Skills&sort=keywords` → 1 row; Reset → bare `/products`; an ASIN page from the list (facts incl. the category path, four charts, keywords with weeks in top 3, Back to products); `/explorer?custom=nope` renders normally (the 6238f82 fix); no console errors, every RSC navigation 200 |
| Tools smoke | 2026-10-12 | PASS (owner, from Claude) | a search by the Pet Supplies department and a search by one of the owner's custom categories both worked through `search_products`; not separately reported: the misspelled-department error listing the valid names, and an Ask AI department question (both covered by unit tests; try them whenever convenient) |
