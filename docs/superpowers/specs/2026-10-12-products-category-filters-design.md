# Products page: category filters — design

**Date:** 2026-10-12 · **Status:** approved in brainstorm, awaiting the owner's read of this file · **Builds on:** `2026-10-09-products-page-design.md` (arc 7, live 2026-10-10)

## 1. Goal

Give the admin-only Products page (`/products`) and the `search_products` tool the same three category controls the Explorer has for keywords — a broad department, the owner's custom categories, and individual leaf categories — filtering on each product's own Keepa category path. No migration, no change to the Keepa service or the import.

## 2. Facts the design rests on (measured on production, 2026-10-10/12)

| Fact | Value |
|---|---|
| In-scope catalog rows (`in_scope AND enrichment_status IN ('active','no_price')`) | 1,006,210 |
| Distinct `category_path` among them | 22,693 (1.92 MB of text; longest 205 chars; one root-only path) |
| Distinct `category_root` (Keepa storefront departments) | 36; `category_root` equals the path's first segment on every row (0 mismatches) |
| Explorer leaf list (kcs leaf facets, slot-1 paths) | 14,663 paths; 14,600 exist in the catalog; 27,828 products (2.8 %) sit in paths the Explorer list lacks |
| Custom categories | 16 (one user), 2,349 stored paths, 2,342 exist in the catalog |
| Explorer "broad" list (`Top Clicked Category #1` from the weekly CSV) | 102–104 Brand Analytics codes; only 7 names coincide with Keepa departments; Keepa's `productGroup` is `null` in every captured response |
| Existing index | `asin_products_category_path_idx (category_path text_pattern_ops) WHERE in_scope AND category_path IS NOT NULL` |
| Planner | `category_path = $p OR starts_with(category_path, $p ∥ ' › ')` → BitmapOr of two index scans (starts_with is rewritten to an index range on this Postgres); `category_path = ANY($arr)` → one index scan |
| Timings, cold, page-first `ORDER BY monthly_sold DESC LIMIT 50` | department Appliances (2k rows) 25 ms via the path index vs 110 ms via `category_root =`; Clothing (253k rows) 12 ms; subtree Clothing › Women 10 ms; one-shot `SELECT DISTINCT category_path` 1.4 s; `SELECT DISTINCT category_root` 1.3 s |

Why the broad filter cannot be the Explorer's: the Brand Analytics code is a property of the keyword row, not of the product. Per ASIN it is also inconsistent — of the 1,908,290 top-3 ASINs with a code in the week ending 2026-10-03, 634,603 (33 %) carry two or more different codes across keywords. The product-level broad filter is therefore the Keepa department; carrying the Brand Analytics code over is a separate follow-up (§9).

## 3. Filters and semantics

Three controls replace the page's single "Category" picker (`cat`):

- **Department** (`dept`): one of the 36 Keepa root departments present in the catalog, or none. Matches products filed in that department at any depth: `category_path = dept OR starts_with(category_path, dept › )`.
- **Leaf categories, Leaf mode** (`leaf`, repeated): any number of catalog paths, picked in the Explorer's multi-select typeahead. Each pick matches **the path and everything under it** (the page's existing rule; identical to exact matching for true leaves). Several picks combine with OR.
- **Leaf categories, Custom mode** (`custom`, comma-separated ids): the signed-in user's custom categories. A custom category matches **exactly** the paths it stores (the Explorer's rule, and one `= ANY(array)` index scan). A custom id the user does not own contributes nothing; when the selection is only unowned ids, the filter matches nothing (the Explorer silently widens to everything in that case — deliberately not copied).

Combination, as in the Explorer: `dept AND (leaf picks OR custom paths) AND every other filter`. A URL may carry both `leaf` and `custom` (the panel never writes both); they union into the OR group.

Caps match the Explorer: 2,000 leaf paths of at most 256 characters, 50 custom ids. Malformed ids are dropped by the parser. The old `cat` key is ignored (the page is three days old and admin-only).

Typeahead options are the catalog's own distinct paths (22,693), not the Explorer's keyword-side list.

## 4. Data and query

### 4.1 Category scope and the predicate builder

New pure module `lib/products/categoryPredicate.ts`:

```ts
export interface ProductCategoryScope {
  dept: string | null;
  /** Each matches the path and its descendants. */
  subtreePaths: string[];
  /** Each matches exactly. */
  exactPaths: string[];
  /** A leaf or custom selection was requested; with no paths left, the group is FALSE. */
  scoped: boolean;
}
export function categoryPredicate(scope: ProductCategoryScope, bind: (v: unknown) => string): string | null;
```

- `subtree(p)` = `(a.category_path = ${bind(p)}::text OR starts_with(a.category_path, ${bind(p + PATH_SEP)}::text))` with `PATH_SEP` (`' › '`) from `lib/categoryBuilder/buildTree`.
- Department → `subtree(dept)`, ANDed.
- Group = `subtree(p)` per subtree path, OR `a.category_path = ANY(${bind(exactPaths)}::text[])` when exact paths exist; if `scoped` and the group is empty → `FALSE`.
- Returns `null` when nothing is set. Binding order is the order of appearance (dept, then subtree paths, then the array), so the statement's `$n` sequence stays stable for the tests.

Two scope producers, one predicate:
- Page: `pageCategoryScope(filters, customPaths)` = `{ dept, subtreePaths: leafPaths, exactPaths: customPaths, scoped: leafPaths.length > 0 || customCategoryIds.length > 0 }`.
- Tool: `resolveProductCategoryScope(...)` in `lib/research/products.ts` (§6).

### 4.2 Filters

`lib/products/filterParams.ts` (zod-free): `ProductFilters` drops `cat` and gains `dept: string | null`, `leafPaths: string[]`, `customCategoryIds: string[]`; constants `PRODUCT_MAX_LEAF_PATHS = 2000`, `PRODUCT_MAX_CUSTOM_IDS = 50` (`MAX_CATEGORY_PATH_LENGTH = 256` stays); `PRODUCT_DEFAULTS` gets `dept: null, leafPaths: [], customCategoryIds: []`; `productFiltersToSearchParams` writes `dept`, one `leaf` entry per path, and `custom` as the ids joined by commas.

`lib/products/filters.ts` (zod): `dept: z.string().trim().min(1).max(256).nullable()`, `leafPaths: z.array(z.string().trim().min(1).max(256)).max(2000)`, `customCategoryIds: z.array(z.uuid()).max(50)`. `parseProductFilters` reads `leaf` as a string or string[] (trimmed, length-filtered, first 2,000), `custom` as one comma list (trimmed, lower-cased, only values passing `isValidUuid` from `lib/customCategories/validation`, first 50), `dept` as one value. The per-field fallback and the `ProductFiltersSchemaMatchesType` pin are unchanged.

### 4.3 Search statement and rows

`lib/products/searchProducts.ts`: `productSearchSql(f, scope)` and `searchProducts(run, f, scope)` take the scope next to the filters; the statement reads every non-category filter from `f` and the category predicate from `scope` only. `PAGE_COLUMNS` adds `a.category_path`; `ProductSummaryRow` gains `categoryPath: string | null`. The count statement shares the WHERE; the best-effort timeout handling is untouched.

### 4.4 Option lists

New `lib/products/listCategories.ts`, both cached one hour with `unstable_cache` like `lib/explorer/listLeafCategories.ts` (tag `product-categories`):

- `listProductDepartments(): Promise<string[]>` — `SELECT DISTINCT category_root FROM asin_products WHERE in_scope AND enrichment_status IN ('active','no_price') AND category_root IS NOT NULL ORDER BY 1` (1.3 s uncached, 36 rows).
- `listProductCategoryPaths(): Promise<string[]>` — the departments, then one cached read per department in parallel: `SELECT DISTINCT category_path FROM asin_products WHERE in_scope AND category_path IS NOT NULL AND enrichment_status IN ('active','no_price') AND (category_path = $1 OR starts_with(category_path, $2)) ORDER BY 1` with `$2` bound to `dept + PATH_SEP` (the path index serves it; Clothing, the largest, is a few hundred ms). The per-department entries are concatenated and sorted by plain code-unit comparison. Caching per department keeps every cache entry small (the full list is 1.9 MB) and makes a cold fill a parallel half-second instead of a 1.4 s scan.

Both lists refresh within the hour of a new department or path appearing. An empty result (fresh database) renders empty controls, never an error.

### 4.5 Page wiring

`app/(app)/products/(list)/page.tsx`: keep the `User` from `requireAdmin()`; expand the custom ids with the Explorer's helper `expandCustomCategories(user.id, filters.customCategoryIds, [])` (owner-scoped; unknown ids skipped), build the page scope, then run the search; the three lists (`listProductDepartments`, `listProductCategoryPaths`, `listCustomCategoriesForUser(user.id)`) load in parallel with that chain. The panel receives `departments`, `leafCategories`, `customCategories`; the table receives rows with `categoryPath`.

## 5. UI

### 5.1 Filter panel (`app/(app)/products/ProductFilterPanel.tsx`)

- **Department**: `<select id="pf-dept">` with "All departments" and the 36 names; a hand-edited URL value missing from the list is kept as an extra option (the `withCurrent` rule the numeric selects use) so the select shows what is applied.
- **Leaf categories**: the Explorer's Leaf | Custom segmented toggle, copied from `app/(app)/explorer/FilterSidebar.tsx` into the product panel (about 60 lines; the Explorer's sidebar is not touched). Leaf mode: the existing `LeafCategoryTypeahead` with the product path list and the hint "{N} categories — type to search, click or Enter to add. Each pick includes its sub-categories; several match with OR." Custom mode: the user's custom categories as checkboxes "{name} ({leaf count})", the "{n} selected → {m} leaves" line, and "No custom categories yet — build one in the Category Builder tab." when there are none.
- Pending state: `dept: string`, `leafPaths: string[]`, `leafMode: 'leaf' | 'custom'`, `customCategoryIds: string[]`. `filtersToPending` opens Custom mode when the applied filters carry custom ids, else Leaf (the Explorer's rule). `pendingToFilters` writes the active mode's selection and clears the other (Leaf mode → `customCategoryIds: []`; Custom mode → `leafPaths: []`), as the Explorer's `pendingToParams` does. The dirty check, Apply (page 1) and Reset work as today.

### 5.2 Results table (`app/(app)/products/ProductResultsTable.tsx`)

A **Category** column after the product cell: the leaf name from `splitCategoryPath` (`lib/categoryBuilder/pathDisplay`), the full path as the cell's `title`, a dash when `categoryPath` is null. The Explorer's "Leaf category" column is the model.

### 5.3 ASIN page

Unchanged; it already shows the full path.

## 6. Tools (`search_products`, MCP and Ask AI)

`lib/research/contracts.ts`: `productSearchFiltersSchema` drops `categoryPath` and adds

- `department: z.string().trim().min(1).max(256).optional()` — an exact Keepa department name;
- `categories: categoriesSchema.optional()` — the object `search_keywords` takes: `selections` (taxonomy `{ path, includeDescendants = true }` or custom `{ id }`, up to 25, OR) and `leafPaths` (exact, up to 2,000).

`toProductFilters` maps `department` onto `dept` and leaves `leafPaths` / `customCategoryIds` empty; the category scope is resolved separately because custom ids need a read.

`lib/research/products.ts`: `resolveProductCategoryScope(deps, actor, filters)`:
- `department`: must be in `deps.departments()` (the cached list), else `ResearchError('CATEGORY_NOT_AVAILABLE', …)` with `details.departments` = the valid names.
- custom `{ id }`: loaded with `loadCustomRows(actor.localUserId, ids)` (`lib/research/categories.ts`, owner-scoped); every id must resolve, else `CATEGORY_NOT_AVAILABLE` (the keyword tools' rule: never a silent skip); the stored paths become exact paths.
- taxonomy `{ path, includeDescendants: true }` → a subtree path; `false` → an exact path. `leafPaths` → exact paths.
- Every taxonomy path and leaf path is checked against `deps.categoryPaths()` (the cached catalog list): an exact path must be an entry; a subtree path must be an entry or a proper prefix of one (`entry === p || entry.startsWith(p + PATH_SEP)`). A miss throws `CATEGORY_NOT_AVAILABLE` with the message that the path is not in the product catalog and that `resolve_categories` paths usually are.
- `scoped` = any selection or leaf path was given.

`ProductSummary` (response rows) inherits `categoryPath: string | null` from `ProductSummaryRow`. `ProductsDeps` gains `departments()`, `categoryPaths()` and `customRows(userId, ids)`, all injectable; the default deps wire the §4.4 loaders and `loadCustomRows`.

`lib/research/tools.ts`: the `search_products` description names department and categories ("departments are Amazon's storefront departments, not the keyword report's broad categories; pass resolve_categories selections or custom categories in filters.categories"). `lib/research/catalog.ts`: `PRODUCT_FILTER_DEFINITIONS` is generated from the schema's field descriptions, so `department` and `categories` carry `.describe()` texts in the same voice as the other filters and the `categoryPath` entry disappears with the field; `PRODUCT_RULES` gains the two lines above plus "a taxonomy pick includes its sub-categories unless includeDescendants is false; custom categories and leafPaths match exactly"; `GUIDE_VERSION` 3 → 4. Ask AI changes nothing beyond the shared definitions (`lib/ask/tools.ts` consumes `RESEARCH_TOOLS`).

## 7. Testing

Unit (vitest, local):
- `categoryPredicate.test.ts`: null when empty; department alone; one and several subtree paths; exact array; the OR group with both; department AND group; `scoped` with no paths → `FALSE`; binding order.
- `filters.test.ts` / `filterParams.test.ts`: round trip of `dept`, repeated `leaf`, `custom`; caps; malformed and upper-case ids; `cat` ignored; the type pin still compiles.
- `searchProducts.test.ts`: the statement embeds the predicate and the new column; rows map `categoryPath`.
- `listCategories.test.ts`: per-department assembly and sorting; empty department list → empty paths.
- `ProductFilterPanel.test.tsx`: department select (including a value missing from the list), toggle, chips, checkboxes, mode derivation from applied filters, Apply URL in each mode, Reset.
- `ProductResultsTable.test.tsx`: the column and its title/dash.
- `lib/research/products.test.ts` + `contracts` tests: schema strictness and defaults, department validation and error details, custom resolution (unknown id → error), subtree/exact mapping, path validation, `categoryPath` in rows; `tools.test.ts` / `catalog.test.ts`: description and guide text, version 4; MCP and Ask AI listing tests unchanged in substance.

Integration (owner-gated, read-only; extend `tests/integration/productsQueries.test.ts`): EXPLAIN shows `asin_products_category_path_idx` for a department-only search, a leaf subtree, and a custom-category array; one real custom category (any user's row, read with `SELECT user_id, id FROM custom_categories LIMIT 1`, no emails) expands and returns rows whose paths are in its list; `listProductDepartments` returns 36 entries and `listProductCategoryPaths` roughly 22.7k.

## 8. Ship and smoke

No migration. `checkActiveJobs`, then one bare `git push origin main` on the owner's go; the three deploys as usual (the Keepa service and the worker restart with no change in them). Smoke, owner as admin: department only; two leaf picks; one custom category; each combined with monthly sold and reviews; the Category column; then Claude with a department search and a custom-category search, and a non-admin connector still not seeing the tools.

## 9. Out of scope and follow-ups

- **Brand Analytics broad category on products.** Feasible as a keyword-context filter: add the code to `keyword_top_asins` (one column per keyword and slot, one index), rebuild the current week, a 102-entry dropdown from a facet query, filter "products clicked under keywords filed as X" with any-of semantics. About a day; a small arc of its own.
- Keyword-derived categories at query time (joining the reverse table per page) — rejected: breaks the page-first sorts.
- Narrowing the typeahead to the chosen department; a server-side typeahead if the 1.9 MB option list (about 200 KB compressed, resent on every filter change like the Explorer's 1.2 MB) ever drags.
- Saved views for products.

## 10. Decisions log

- Leaf picks match the subtree (page rule) and custom categories match exactly (Explorer rule): the two differ only for a stored path that is also a parent, and the exact form is the one that stays one index scan at 2,000 paths.
- Unowned custom ids match nothing instead of widening.
- The option list comes from the catalog (22,693 paths), cached per department.
- The broad filter is the Keepa department (36), not the Brand Analytics code (inconsistent per ASIN; not a product field).
- The Explorer's toggle block is copied, not extracted, so the Explorer sidebar carries no risk from this change.
- `cat` is dropped rather than aliased.
