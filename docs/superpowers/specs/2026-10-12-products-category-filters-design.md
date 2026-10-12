# Products page: category filters — design

**Date:** 2026-10-12 · **Status:** approved; code complete 2026-10-12 (see §11 for the amendments as landed) · **Builds on:** `2026-10-09-products-page-design.md` (arc 7, live 2026-10-10)

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

`lib/products/filters.ts` (zod): `dept: z.string().trim().min(1).max(256).nullable()`, `leafPaths: z.array(z.string().trim().min(1).max(256)).max(2000)`, `customCategoryIds: z.array(z.uuid()).max(50)`. `parseProductFilters` reads `leaf` as a string or string[] (trimmed, length-filtered, first 2,000), `custom` as one comma list (trimmed, lower-cased, only values `z.uuid()` accepts — the same check the schema applies, so a parsed id can never fail the schema — first 50), `dept` as one value. The per-field fallback and the `ProductFiltersSchemaMatchesType` pin are unchanged.

### 4.3 Search statement and rows

`lib/products/searchProducts.ts`: `productSearchSql(f, scope)` and `searchProducts(run, f, scope)` take the scope next to the filters; the statement reads every non-category filter from `f` and the category predicate from `scope` only. `PAGE_COLUMNS` adds `a.category_path`; `ProductSummaryRow` gains `categoryPath: string | null`. The count statement shares the WHERE; the best-effort timeout handling is untouched.

### 4.4 Option lists

New `lib/products/listCategories.ts`, both cached one hour with `unstable_cache` like `lib/explorer/listLeafCategories.ts` (tag `product-categories`):

- `listProductDepartments(): Promise<string[]>` — `SELECT DISTINCT category_root FROM asin_products WHERE in_scope AND enrichment_status IN ('active','no_price') AND category_root IS NOT NULL ORDER BY category_root` (1.3 s uncached, 36 rows; re-sorted by code unit).
- `listProductCategoryPaths(): Promise<string[]>` — the departments, then one cached read per department in parallel: `SELECT DISTINCT category_path FROM asin_products WHERE in_scope AND category_path IS NOT NULL AND enrichment_status IN ('active','no_price') AND (category_path = $1 OR starts_with(category_path, $2)) ORDER BY category_path` with `$2` bound to `dept + PATH_SEP` (the path index serves it). The per-department entries are concatenated and sorted by plain code-unit comparison. Caching per department keeps every cache entry under Next's 2 MB data-cache limit (the full list is 1.9 MB; the largest department, Clothing, is roughly 0.5–1 MB); a fully cold fill is the departments scan followed by the parallel per-department reads.

Both lists refresh within the hour of a new department or path appearing. An empty result (fresh database) renders empty controls, never an error.

### 4.5 Page wiring

`app/(app)/products/(list)/page.tsx`: keep the `User` from `requireAdmin()`; expand the custom ids with the Explorer's helper `expandCustomCategories(user.id, filters.customCategoryIds, [])` (owner-scoped; unknown ids skipped), build the page scope, then run the search; the three lists (`listProductDepartments`, `listProductCategoryPaths`, `listCustomCategoriesForUser(user.id)`) load in parallel with that chain. The panel receives `departments`, `leafCategories`, `customCategories`; the table receives rows with `categoryPath`.

## 5. UI

### 5.1 Filter panel (`app/(app)/products/ProductFilterPanel.tsx`)

- **Department**: `<select id="pf-dept">` with "All departments" and the 36 names; a hand-edited URL value missing from the list is appended as an extra option (last, not sorted in) so the select shows what is applied.
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
- `department`: must be in `deps.departments()` (the cached list), else `ResearchError('CATEGORY_NOT_AVAILABLE', …)` whose message lists the valid names (`details` is `ResearchFieldIssue[]`, which cannot carry a list).
- custom `{ id }`: loaded with `loadCustomRows(actor.localUserId, ids)` (`lib/research/categories.ts`, owner-scoped); every id must resolve, else `CATEGORY_NOT_AVAILABLE` (the keyword tools' rule: never a silent skip); the stored paths become exact paths.
- taxonomy `{ path }` → a subtree path whatever `includeDescendants` says (`resolve_categories` marks keyword-side leaves as having no descendants, while the product catalog files products deeper — see §11); `leafPaths` → exact paths.
- Every taxonomy path and leaf path is checked against `deps.categoryPaths()` (the cached catalog list): an exact path must be an entry; a subtree path must be an entry or a proper prefix of one (`entry === p || entry.startsWith(p + PATH_SEP)`). A miss throws `CATEGORY_NOT_AVAILABLE` with the message that the path is not in the product catalog and that `resolve_categories` paths usually are.
- `scoped` = any selection or leaf path was given.

`ProductSummary` (response rows) inherits `categoryPath: string | null` from `ProductSummaryRow`. `ProductsDeps` gains `departments()`, `categoryPaths()` and `customRows(userId, ids)`, all injectable; the default deps wire the §4.4 loaders and `loadCustomRows`.

`lib/research/tools.ts`: the `search_products` description names department ("the product's Keepa storefront department, not a keyword row's broadCategory") and categories, and adds one sentence routing categories to `filters.categories` ("the same object search_keywords takes: resolve_categories selections (several = OR; a taxonomy selection includes everything under it, whatever includeDescendants says; a custom selection is that custom category's stored paths, exactly) and exact leafPaths. An unknown department, path or custom id fails with CATEGORY_NOT_AVAILABLE."). `lib/research/catalog.ts`: `PRODUCT_FILTER_DEFINITIONS` is generated from the schema's field descriptions, so `department` and `categories` carry `.describe()` texts in the same voice as the other filters and the `categoryPath` entry disappears with the field; `PRODUCT_RULES` gains three lines — the department rule (storefront departments, not a keyword row's broadCategory; the error message lists the valid names), the categories rule ("a taxonomy selection matches the path and everything under it whatever includeDescendants says … a custom selection matches the paths that custom category stores, exactly; leafPaths match exactly … an unknown path or custom id fails with CATEGORY_NOT_AVAILABLE, never an empty page") and the `categoryPath` disambiguation (a product row's, and `product.categoryPath` in get_product_details, is the product's own path; a keyword row's, in metrics, is the most-clicked product's path); `GUIDE_VERSION` 3 → 4. An empty department list (a fresh database) answers "The product catalog has no departments yet.". Ask AI changes nothing beyond the shared definitions (`lib/ask/tools.ts` consumes `RESEARCH_TOOLS`).

## 7. Testing

Unit (vitest, local):
- `categoryPredicate.test.ts`: null when empty; department alone; one and several subtree paths; exact array; the OR group with both; department AND group; `scoped` with no paths → `FALSE`; binding order.
- `filters.test.ts` / `filterParams.test.ts`: round trip of `dept`, repeated `leaf`, `custom`; caps; malformed and upper-case ids; `cat` ignored; the type pin still compiles.
- `searchProducts.test.ts`: the statement embeds the predicate and the new column; rows map `categoryPath`.
- `listCategories.test.ts`: per-department assembly and sorting; empty department list → empty paths.
- `ProductFilterPanel.test.tsx`: department select (including a value missing from the list), toggle, chips, checkboxes, mode derivation from applied filters, Apply URL in each mode, Reset.
- `ProductResultsTable.test.tsx`: the column and its title/dash.
- `lib/research/products.test.ts` + `contracts` tests: schema strictness and defaults, department validation and error details, custom resolution (unknown id → error), subtree/exact mapping, path validation, `categoryPath` in rows; `tools.test.ts` / `catalog.test.ts`: description and guide text, version 4; MCP and Ask AI listing tests unchanged in substance.

Integration (owner-gated, read-only; extend `tests/integration/productsQueries.test.ts`): EXPLAIN shows `asin_products_category_path_idx` for a department-only search (the smallest department), a leaf subtree (a mid-size, deepest path with badge-bearing rows), and the smallest custom category's exact-path array (its `leaf_paths` read directly, no emails, never through `expandCustomCategories`); the largest custom category is planned and run for timing only; direct SQL counts assert at least 20 departments and 10,000 distinct paths (the loaders themselves are not called: `unstable_cache` needs Next's request scope), the largest per-department cache entry stays under 1.5M characters, and the per-department loader statement is planned for the largest department.

## 8. Ship and smoke

No migration. `checkActiveJobs`, then one bare `git push origin main` on the owner's go; the three deploys as usual (the Keepa service and the worker restart with no change in them). Smoke, owner as admin: department only; two leaf picks; one custom category; each combined with monthly sold and reviews; the Category column; then Claude with a department search and a custom-category search, and a non-admin connector still not seeing the tools.

## 9. Out of scope and follow-ups

- **Brand Analytics broad category on products.** Feasible as a keyword-context filter: add the code to `keyword_top_asins` (one column per keyword and slot, one index), rebuild the current week, a 102-entry dropdown from a facet query, filter "products clicked under keywords filed as X" with any-of semantics. About a day; a small arc of its own.
- Keyword-derived categories at query time (joining the reverse table per page) — rejected: breaks the page-first sorts.
- Narrowing the typeahead to the chosen department; a server-side typeahead if the 1.9 MB option list (about 200 KB compressed, resent on every list navigation — Apply, a sort header, a page link — like the Explorer's 1.2 MB) ever drags.
- Saved views for products.

## 10. Decisions log

- Leaf picks match the subtree (page rule) and custom categories match exactly (Explorer rule): the two differ only for a stored path that is also a parent, and the exact form is the one that stays one index scan at 2,000 paths.
- Unowned custom ids match nothing instead of widening.
- The option list comes from the catalog (22,693 paths), cached per department.
- The broad filter is the Keepa department (36), not the Brand Analytics code (inconsistent per ASIN; not a product field).
- The Explorer's toggle block is copied, not extracted, so the Explorer sidebar carries no risk from this change.
- `cat` is dropped rather than aliased.

## 11. Amendments as landed (2026-10-12)

- **§3 / §4.2.** The parser deduplicates `leaf` values (before the cap) and drops `dept`/`leaf` values containing control characters; the schema lower-cases custom ids too (`z.uuid().toLowerCase()`); the caps are pinned to the Explorer's constants by a test. `ProductFilters`' array fields are copied into the panel's pending state (the defaults' arrays are shared, `Object.freeze` being shallow).
- **§4.1.** `ProductCategoryScope`'s array fields are `readonly string[]`; `EMPTY_CATEGORY_SCOPE` freezes its inner arrays; `pageCategoryScope` deduplicates. The predicate module's header states the planner precondition (the prefix bound as a plan-time constant) rather than "every form rides the index".
- **§4.4.** The page catches a failed department/path read and renders empty controls (the tools still reject); each cached callback holds its own statement because Next keys the entry on the callback's source. `listProductDepartments` is wrapped in React `cache()` so one page render runs the departments scan once (the page calls it directly and through `listProductCategoryPaths`); a failed per-department read rejects the whole list (never caught inside the cached function, or an empty list would be cached for an hour); the per-department split exists because Next's data cache skips entries over 2 MB (verified in the runtime) and the full list is ~1.9 MB. The departments statement names its column (`ORDER BY category_root`).
- **§5.1.** A custom id in the URL that the user no longer owns is shown as "N selected custom categor(y|ies) no longer exist(s) and match(es) nothing" with a Clear button (the Explorer leaves it invisible); the dirty check compares canonical (sorted) forms while Apply keeps the user's order; the toggle buttons carry a focus-visible ring and the field is a labelled group.
- **§5.2.** The tooltip sits on the cell (the whole cell is the hover target); a path whose last segment is blank shows the whole path.
- **§6.** On products every taxonomy selection is a subtree whatever `includeDescendants` says (the keyword-side resolver sets it from the keyword catalog, which lacks 8.1k product-only paths holding 27,828 products). The valid department names travel in the error message. A custom category that stores no paths, or whose stored paths are all absent from the catalog, scopes to nothing (zero products) rather than erroring; only unknown paths and ids error. The tool's test suite stubs the list loaders and `loadCustomRows`, so nothing reaches `next/cache` or the pool. The guide's products rules name `broadCategory` (what a keyword row carries) rather than "the keyword report's broad category", and state that a product row's `categoryPath` is the product's own path (the keyword metric of the same name is the most-clicked product's path).
- **§7.** The integration cases plan the predicates with direct SQL instead of calling the loaders (`unstable_cache` needs Next's request scope), use the smallest custom category for the index assertion and the largest for timing only, count only badge-bearing rows when picking the leaf path (the default sort hides the others), and add a per-department cache-entry size check (largest < 1.5M characters) plus the per-department loader statement's plan.
- **Plan collision noted for future plans.** Adding required fields to `ProductFilters` broke four full-literal sites the plan did not list (`toProductFilters`, `pendingToFilters`, two test fixtures); the same happened to `ProductSummaryRow` (`lib/research/service.test.ts`) and `ProductLoaders` (same file). A plan that changes a shared type must list every full-literal site.

### Follow-ups recorded
- The Explorer passed raw custom ids from its URL (and from stored saved-view blobs) into a uuid-typed query (`/explorer?custom=nope` failed with Postgres 22P02) — FIXED in 6238f82 (`parseCustomCategoryIds`: well-formed uuids only, lower-cased, deduplicated; the saved-view normaliser applies the same rule); rides with this push.
- The Explorer sidebar shares the stale-custom-id, order-sensitive dirty check and toggle a11y items fixed here; `LeafCategoryTypeahead`'s placeholder hard-codes "11k+" (a `placeholder` prop would let each page state its count).
- `compareCodeUnits` is exported from a server module and duplicated privately in `lib/research/categories.ts`; a shared selection walker could serve both resolvers.
- The exact-path array is uncapped (25 custom categories × 12,000 stored paths in theory; 2,349 stored paths today) — the largest-custom-category integration case measures it.
- Owner's choice: make `search_products` error, as `search_keywords` does, when a custom category's stored paths are all absent from the catalog.
