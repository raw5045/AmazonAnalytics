# Path-Aware Category Matching — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Match the explorer leaf-category filter and Category Builder custom categories by full Keepa category **path** instead of bare leaf **name**, eliminating cross- and intra-department over-match.

**Architecture:** Add one `top_clicked_category_path` column to `keyword_current_summary` (populated from the already-joined slot-1 ASIN row in `refreshSummary`), match against it everywhere, and store custom categories + the typeahead selection as full paths. No bare-name matching remains. Spec: `docs/superpowers/specs/2026-06-29-path-aware-categories-design.md`.

**Tech Stack:** Next.js 16 (App Router, Turbopack), Neon Postgres, Drizzle, Inngest, Vitest. Per `AGENTS.md`, read the relevant guide in `node_modules/next/dist/docs/` before writing Next.js code (route handlers, RSC, searchParams).

**Conventions:**
- Commit trailer (EXACT): `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- Migrations 0027+ are hand-numbered **raw SQL applied manually** against Neon — NOT `db:migrate`. Next number is **0039**.
- Do NOT apply DDL to Neon or run the backfill without explicit user confirmation (Task 7 is gated).
- Verify commands: `npm run typecheck` · `npm test` (or `npx vitest run <file>`) · `npm run build` · `npm run lint`.

---

## File Structure

**Pure helpers / types (Task 1)**
- Modify `lib/explorer/types.ts` — rename `ExplorerFilters.leafCategories` → `leafPaths`.
- Modify `lib/explorer/parseFilters.ts` — add `parseLeafPaths` (repeated-param, no comma-split); rename default.
- Modify `lib/customCategories/validation.ts` — rename `normalizeLeafNames` → `normalizePaths`.
- Create `lib/categoryBuilder/pathDisplay.ts` — pure `splitCategoryPath(path)`.
- Tests alongside each.

**Schema + migration (Task 2)**
- Modify `db/schema/keywordCurrentSummary.ts`, `db/schema/keywordCurrentSummaryLeafCategoryFacets.ts`, `db/schema/customCategories.ts`.
- Create `db/migrations/0039_path_aware_categories.sql`.

**Matching (Task 3)**
- Modify `lib/explorer/buildQuery.ts`, `lib/customCategories/expand.ts`, `lib/savedViews/validation.ts`.

**Refresh + loaders (Task 4)**
- Modify `inngest/functions/refreshSummary.ts`, `lib/categoryBuilder/loadTree.ts`, `lib/explorer/listLeafCategories.ts`.

**Custom-category API + DTO (Task 5)**
- Modify `lib/customCategories/loadServer.ts`, `app/api/category-builder/custom/route.ts`, `app/api/category-builder/custom/[id]/route.ts`.

**UI (Task 6)**
- Modify `app/(app)/explorer/LeafCategoryTypeahead.tsx`, `app/(app)/explorer/FilterSidebar.tsx`, `app/(app)/explorer/page.tsx`, `app/(app)/category-builder/CategoryBuilderClient.tsx`.

**Backfill + rollout (Task 7)**
- Create `scripts/backfillCategoryPaths.ts`. Gated rollout + manual E2E.

---

## Task 1: Pure core — types, parse, validation, path-display (TDD)

**Files:**
- Modify: `lib/explorer/types.ts`
- Modify: `lib/explorer/parseFilters.ts`, Test: `lib/explorer/parseFilters.test.ts`
- Modify: `lib/customCategories/validation.ts`, Test: `lib/customCategories/validation.test.ts`
- Create: `lib/categoryBuilder/pathDisplay.ts`, Test: `lib/categoryBuilder/pathDisplay.test.ts`

- [ ] **Step 1: Rename the filter field in `types.ts`**

In `lib/explorer/types.ts`, find `leafCategories: string[]` in the `ExplorerFilters` interface and rename to `leafPaths: string[]` (update the doc comment to "full Keepa category paths").

- [ ] **Step 2: Write failing test for `parseLeafPaths`**

In `lib/explorer/parseFilters.test.ts` add:

```ts
import { parseLeafPaths } from './parseFilters';

describe('parseLeafPaths', () => {
  it('returns [] for undefined', () => expect(parseLeafPaths(undefined)).toEqual([]));
  it('wraps a single string path', () =>
    expect(parseLeafPaths('Health & Household › Air Fresheners'))
      .toEqual(['Health & Household › Air Fresheners']));
  it('keeps repeated params as separate paths', () =>
    expect(parseLeafPaths(['A › B', 'C › D'])).toEqual(['A › B', 'C › D']));
  it('does NOT split on commas in department names', () =>
    expect(parseLeafPaths(['Clothing, Shoes & Jewelry › Pants']))
      .toEqual(['Clothing, Shoes & Jewelry › Pants']));
  it('trims and drops blanks', () =>
    expect(parseLeafPaths(['  A › B  ', '', '  '])).toEqual(['A › B']));
});
```

- [ ] **Step 3: Run it — expect FAIL** (`npx vitest run lib/explorer/parseFilters.test.ts`) — `parseLeafPaths is not a function`.

- [ ] **Step 4: Implement `parseLeafPaths` + wire into `parseExplorerFilters`**

In `lib/explorer/parseFilters.ts`:
- In `EXPLORER_DEFAULTS`, rename `leafCategories: []` → `leafPaths: []`.
- Add (keep the existing `parseLeafCategories`, still used for `custom`):

```ts
/**
 * Repeated `leaf` URL param(s) → string[] of full category paths. Each value is
 * one complete path. Department names contain commas ("Clothing, Shoes &
 * Jewelry"), so we do NOT comma-split — repeated params are the delimiter. Next
 * delivers repeated params as string[] and a lone one as string.
 */
export function parseLeafPaths(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  const arr = Array.isArray(value) ? value : [value];
  return arr.map((s) => s.trim()).filter((s) => s.length > 0);
}
```
- In the `parseExplorerFilters` return, replace `leafCategories: parseLeafCategories(getOne(searchParams.leaf))` with `leafPaths: parseLeafPaths(searchParams.leaf)` (pass the RAW value, not `getOne`). Leave `customCategoryIds: parseLeafCategories(getOne(searchParams.custom))` unchanged.

- [ ] **Step 5: Add a `parseExplorerFilters` integration assertion** in the same test file:

```ts
it('parseExplorerFilters reads repeated leaf params as leafPaths', () => {
  const f = parseExplorerFilters({ leaf: ['Clothing, Shoes & Jewelry › Pants', 'Books › Subjects › Self-Help › General'] });
  expect(f.leafPaths).toEqual(['Clothing, Shoes & Jewelry › Pants', 'Books › Subjects › Self-Help › General']);
});
```

- [ ] **Step 6: Run — expect PASS** (`npx vitest run lib/explorer/parseFilters.test.ts`).

- [ ] **Step 7: Rename `normalizeLeafNames` → `normalizePaths` (TDD)**

In `lib/customCategories/validation.test.ts` rename the `describe('normalizeLeafNames')` block to `describe('normalizePaths')`, import `normalizePaths`, and add one path case:
```ts
it('keeps full paths intact (no splitting)', () =>
  expect(normalizePaths(['A › B › C', 'A › B › C', 'X › Y'])).toEqual(['A › B › C', 'X › Y']));
```
Run → FAIL. Then in `lib/customCategories/validation.ts` rename the function `normalizeLeafNames` → `normalizePaths` (body unchanged — it's a generic dedupe; update the doc comment to "full category paths"). Run → PASS.

- [ ] **Step 8: Create `splitCategoryPath` (TDD)**

`lib/categoryBuilder/pathDisplay.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { splitCategoryPath } from './pathDisplay';

describe('splitCategoryPath', () => {
  it('splits a multi-segment path into leaf + prefix', () =>
    expect(splitCategoryPath('A › B › C')).toEqual({ leaf: 'C', prefix: 'A › B' }));
  it('handles a single-segment (department-only) path', () =>
    expect(splitCategoryPath('Books')).toEqual({ leaf: 'Books', prefix: '' }));
});
```
Run → FAIL. Then `lib/categoryBuilder/pathDisplay.ts`:
```ts
import { PATH_SEP } from './buildTree';

/** Split a full category path into its leaf (last segment) and parent prefix. */
export function splitCategoryPath(path: string): { leaf: string; prefix: string } {
  const segs = path.split(PATH_SEP);
  const leaf = segs[segs.length - 1] ?? path;
  const prefix = segs.slice(0, -1).join(PATH_SEP);
  return { leaf, prefix };
}
```
Run → PASS.

- [ ] **Step 9: Commit**
```bash
git add lib/explorer/types.ts lib/explorer/parseFilters.ts lib/explorer/parseFilters.test.ts \
  lib/customCategories/validation.ts lib/customCategories/validation.test.ts \
  lib/categoryBuilder/pathDisplay.ts lib/categoryBuilder/pathDisplay.test.ts
git commit -m "$(cat <<'EOF'
feat(categories): path-aware pure core — leafPaths, parseLeafPaths, normalizePaths, splitCategoryPath

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Schema + migration 0039

**Files:**
- Modify: `db/schema/keywordCurrentSummary.ts`, `db/schema/keywordCurrentSummaryLeafCategoryFacets.ts`, `db/schema/customCategories.ts`
- Create: `db/migrations/0039_path_aware_categories.sql`

> DDL is NOT applied here — only the schema source + migration file. Application is gated to Task 7.

- [ ] **Step 1: kcs schema** — in `db/schema/keywordCurrentSummary.ts`:
  - Add after `topClickedLeafCategory`: `topClickedCategoryPath: text('top_clicked_category_path'),` (with a doc comment: full Keepa path of the slot-1 ASIN; the path-aware filter key).
  - In the index block, add `leafPathIdx: index('kcs_leaf_path_idx').on(t.currentWeekEndDate, t.topClickedCategoryPath),` and **remove** the `leafCategoryIdx` line (the bare-leaf index is now dead).

- [ ] **Step 2: facet schema** — in `db/schema/keywordCurrentSummaryLeafCategoryFacets.ts`, rename the column field `leafCategory: text('leaf_category')` → `categoryPath: text('category_path')`, update the PK `columns: [t.snapshotVersion, t.categoryPath]`, and the exported type name comment. (Table name stays.)

- [ ] **Step 3: custom_categories schema** — in `db/schema/customCategories.ts`, rename `leafNames: jsonb('leaf_names')` → `leafPaths: jsonb('leaf_paths')` (update the doc comment to "full Keepa category paths").

- [ ] **Step 4: Write the migration SQL** — `db/migrations/0039_path_aware_categories.sql`:
```sql
-- 0039: path-aware category matching.
-- Add full-path column on the keyword side; switch the facet + custom-category
-- storage from bare leaf NAME to full category PATH. Wipe legacy bare-name
-- custom categories (cannot be auto-disambiguated; user re-creates them).

ALTER TABLE keyword_current_summary ADD COLUMN IF NOT EXISTS top_clicked_category_path text;

CREATE INDEX IF NOT EXISTS kcs_leaf_path_idx
  ON keyword_current_summary (current_week_end_date, top_clicked_category_path);
DROP INDEX IF EXISTS kcs_leaf_category_idx;

ALTER TABLE keyword_current_summary_leaf_category_facets
  RENAME COLUMN leaf_category TO category_path;

ALTER TABLE custom_categories RENAME COLUMN leaf_names TO leaf_paths;
DELETE FROM custom_categories;  -- wipe legacy bare-name rows (3 rows, one user)
```

- [ ] **Step 5: Typecheck** (`npm run typecheck`) — expect PASS once all downstream tasks land; at this point expect type errors at call sites referencing `leafCategory`/`leafNames`/`leafCategories`. That's expected — Tasks 3–6 fix them. Confirm the errors are ONLY the rename ripples (no schema syntax errors). Do NOT commit a broken typecheck alone — bundle this commit with Task 3, OR if committing now, note "schema only; call sites fixed in T3–T6".

- [ ] **Step 6: Commit** (schema + migration together)
```bash
git add db/schema/keywordCurrentSummary.ts db/schema/keywordCurrentSummaryLeafCategoryFacets.ts \
  db/schema/customCategories.ts db/migrations/0039_path_aware_categories.sql
git commit -m "$(cat <<'EOF'
feat(categories): schema + migration 0039 — kcs path column, facet/custom column renames

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Matching — buildQuery + expand + saved views (TDD)

**Files:**
- Modify: `lib/explorer/buildQuery.ts`, Test: the existing buildQuery test file (find it: `lib/explorer/buildQuery.test.ts`)
- Modify: `lib/customCategories/expand.ts`, Test: `lib/customCategories/expand.test.ts`
- Modify: `lib/savedViews/validation.ts` (+ check `lib/savedViews/validation.test.ts`)

- [ ] **Step 1: buildQuery test** — in the buildQuery test file, add/adjust a case asserting the path predicate:
```ts
it('filters by full category path when leafPaths set', () => {
  const built = buildExplorerQuery(
    { ...baseFilters, leafPaths: ['Automotive › Interior Accessories › Air Fresheners'] },
    '2026-06-20',
  );
  expect(built.sql).toContain('top_clicked_category_path IN');
  expect(built.args).toContain('Automotive › Interior Accessories › Air Fresheners');
});
```
(Reuse the test's existing `baseFilters`/defaults; if it builds filters via `parseExplorerFilters`, pass `{ leaf: ['…'] }`.) Run → FAIL.

- [ ] **Step 2: buildQuery implementation** — in `lib/explorer/buildQuery.ts`, in `pushKcsPredicates` replace the leaf block:
```ts
  if (filters.leafPaths.length > 0) {
    const ps = filters.leafPaths.map((c) => next(c)).join(', ');
    where.push(`kcs.top_clicked_category_path IN (${ps})`);
  }
```
Leave `KCS_DISPLAY_COLS` unchanged (it keeps `top_clicked_leaf_category` for display). Run → PASS.

- [ ] **Step 3: expand test** — in `lib/customCategories/expand.test.ts`, rename `mergeCustomLeaves` → `mergeCustomPaths`, change row shape to `leafPaths`, and use path values:
```ts
import { mergeCustomPaths } from './expand';
describe('mergeCustomPaths', () => {
  it('unions selected categories paths into the base set, deduped + sorted', () => {
    const rows = [
      { id: 'a', leafPaths: ['H › Collagen', 'H › Iron'] },
      { id: 'b', leafPaths: ['H › Iron', 'H › Zinc'] },
    ];
    expect(mergeCustomPaths(['H › Magnesium'], rows))
      .toEqual(['H › Collagen', 'H › Iron', 'H › Magnesium', 'H › Zinc']);
  });
  it('returns base unchanged when no rows', () =>
    expect(mergeCustomPaths(['H › Collagen'], [])).toEqual(['H › Collagen']));
});
```
Run → FAIL.

- [ ] **Step 4: expand implementation** — in `lib/customCategories/expand.ts`:
```ts
/** Pure: union base paths with each row's leafPaths, deduped + sorted. */
export function mergeCustomPaths(base: string[], rows: Array<{ leafPaths: string[] }>): string[] {
  const set = new Set(base);
  for (const r of rows) for (const n of r.leafPaths) set.add(n);
  return [...set].sort((a, b) => a.localeCompare(b));
}

export async function expandCustomCategories(
  userId: string,
  ids: string[],
  basePaths: string[],
): Promise<string[]> {
  if (ids.length === 0) return basePaths;
  const rows = await db
    .select({ leafPaths: customCategories.leafPaths })
    .from(customCategories)
    .where(and(eq(customCategories.userId, userId), inArray(customCategories.id, ids)));
  return mergeCustomPaths(basePaths, rows.map((r) => ({ leafPaths: (r.leafPaths as string[]) ?? [] })));
}
```
Run → PASS.

- [ ] **Step 5: saved views** — in `lib/savedViews/validation.ts`:
  - `normalizeFiltersBlob`: replace `leafCategories: Array.isArray(f.leafCategories) ? … : []` with `leafPaths: Array.isArray(f.leafPaths) ? (f.leafPaths as string[]) : []`. (Old blobs lack `leafPaths` → `[]` → filter drops, fails open.)
  - `filtersToSearchParams`: replace the `p.leaf = (f.leafCategories as string[]).join(',')` block with:
```ts
  if (Array.isArray(f.leafPaths) && f.leafPaths.length > 0) {
    p.leaf = f.leafPaths as string[]; // SearchParamsLike allows string[]
  }
```
  Check `lib/savedViews/validation.test.ts` for any `leafCategories` reference and update to `leafPaths`.

- [ ] **Step 6: Typecheck** (`npm run typecheck`) — remaining errors should now be only in `page.tsx` / `FilterSidebar` / UI / refresh (Tasks 4–6). Run the three pure test files → PASS.

- [ ] **Step 7: Commit**
```bash
git add lib/explorer/buildQuery.ts lib/explorer/buildQuery.test.ts lib/customCategories/expand.ts \
  lib/customCategories/expand.test.ts lib/savedViews/validation.ts lib/savedViews/validation.test.ts
git commit -m "$(cat <<'EOF'
feat(categories): match by top_clicked_category_path; expand + saved-views use leafPaths

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Weekly refresh + facet populate + loaders

**Files:**
- Modify: `inngest/functions/refreshSummary.ts`
- Modify: `lib/categoryBuilder/loadTree.ts`
- Modify: `lib/explorer/listLeafCategories.ts`

> No unit tests for these (SQL + cached loaders); rely on typecheck + Task 7 manual verification. Read `node_modules/next/dist/docs/` for `unstable_cache` semantics before editing the loaders.

- [ ] **Step 1: refresh — main kcs INSERT** — in `inngest/functions/refreshSummary.ts`:
  - Add `top_clicked_category_path,` to the INSERT column list (next to `top_clicked_leaf_category,` near line 305).
  - Add the matching SELECT expression next to `p1.category_leaf AS top_clicked_leaf_category,` (line ~382):
    `p1.category_path AS top_clicked_category_path,`
  - Confirm column-list order matches SELECT order exactly.

- [ ] **Step 2: refresh — facet populate** — in the `INSERT INTO keyword_current_summary_leaf_category_facets` block (lines ~520–532), change the column `leaf_category` → `category_path`, the selected `top_clicked_leaf_category` → `top_clicked_category_path`, the `WHERE top_clicked_leaf_category IS NOT NULL` → `WHERE top_clicked_category_path IS NOT NULL`, and `GROUP BY top_clicked_leaf_category` → `GROUP BY top_clicked_category_path`.

- [ ] **Step 3: loadLeavesUnderPath returns full paths** — in `lib/categoryBuilder/loadTree.ts`, in `buildCachedLeaves`, return the full `category_path` strings instead of reducing to last-segments:
```ts
const buildCachedLeaves = unstable_cache(
  async (_sv: string, wk: string, pathStr: string, prefix: string): Promise<string[]> => {
    const sql = neon(env.DATABASE_URL);
    const rows = (await sql`
      SELECT DISTINCT category_path FROM asin_weekly_data
      WHERE week_end_date = ${wk}::date
        AND (category_path = ${pathStr} OR starts_with(category_path, ${prefix}))
        AND category_path IS NOT NULL AND category_path <> ''
    `) as Array<{ category_path: string }>;
    return rows
      .map((r) => r.category_path)
      .sort((a, b) => a.localeCompare(b));
  },
  ['category-builder-leaves-v2'], // BUMPED key — old cache holds bare names
  { revalidate: REVALIDATE, tags: TAGS },
);
```
(Only the SELECT-reduction and the cache-key string change.)

- [ ] **Step 4: listLeafCategories reads paths + key bump** — in `lib/explorer/listLeafCategories.ts`:
  - Primary query: `SELECT category_path FROM keyword_current_summary_leaf_category_facets WHERE snapshot_version = … ORDER BY category_path`, mapping `r.category_path`.
  - Legacy fallback: `SELECT DISTINCT top_clicked_category_path AS category_path FROM keyword_current_summary WHERE top_clicked_category_path IS NOT NULL ORDER BY top_clicked_category_path`.
  - Bump the cache key `['explorer-leaf-categories']` → `['explorer-leaf-categories-v2']`.

- [ ] **Step 5: Typecheck** (`npm run typecheck`) — expect remaining errors only in UI (Task 6).

- [ ] **Step 6: Commit**
```bash
git add inngest/functions/refreshSummary.ts lib/categoryBuilder/loadTree.ts lib/explorer/listLeafCategories.ts
git commit -m "$(cat <<'EOF'
feat(categories): refresh populates top_clicked_category_path; loaders serve full paths

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Custom-category API + DTO

**Files:**
- Modify: `lib/customCategories/loadServer.ts`
- Modify: `app/api/category-builder/custom/route.ts`
- Modify: `app/api/category-builder/custom/[id]/route.ts`

> Read `node_modules/next/dist/docs/` route-handler guide before editing the routes.

- [ ] **Step 1: DTO** — in `lib/customCategories/loadServer.ts`, rename `CustomCategoryDTO.leafNames` → `leafPaths` and in `rowToDTO` map `leafPaths: (r.leafPaths as string[]) ?? []`.

- [ ] **Step 2: POST route** — in `app/api/category-builder/custom/route.ts`:
  - Import `normalizePaths` (instead of `normalizeLeafNames`).
  - `const leafPaths = normalizePaths(body.leafPaths);` and the empty-check error stays.
  - `.values({ userId: user.id, name: nameResult.name, leafPaths })`.
  - Body type: `{ name?: unknown; leafPaths?: unknown }`.

- [ ] **Step 3: PATCH route** — in `app/api/category-builder/custom/[id]/route.ts`: same swap — `normalizePaths`, `body.leafPaths`, `.set({ name: …, leafPaths, updatedAt: new Date() })`.

- [ ] **Step 4: Typecheck** (`npm run typecheck`) — PASS for these files (UI still pending).

- [ ] **Step 5: Commit**
```bash
git add lib/customCategories/loadServer.ts app/api/category-builder/custom/route.ts \
  "app/api/category-builder/custom/[id]/route.ts"
git commit -m "$(cat <<'EOF'
feat(categories): custom-category API stores leafPaths (full paths)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: UI — typeahead, sidebar, page, builder

**Files:**
- Modify: `app/(app)/explorer/LeafCategoryTypeahead.tsx`
- Modify: `app/(app)/explorer/FilterSidebar.tsx`
- Modify: `app/(app)/explorer/page.tsx`
- Modify: `app/(app)/category-builder/CategoryBuilderClient.tsx`

> Read `node_modules/next/dist/docs/` (Client Components / RSC) before editing. No unit tests — verified manually in Task 7. Keep edits minimal; TypeScript guides the renames.

- [ ] **Step 1: page.tsx wiring** — in `app/(app)/explorer/page.tsx`:
  - Line ~96–97: `expandCustomCategories(user.id, filters.customCategoryIds, filters.leafPaths)` and `queryFilters = { ...filters, leafPaths: merged }`.
  - Line ~289 (hasActiveFilters): `f.leafPaths.length > 0`.
  - The `leafCategories` options variable (from `listLeafCategories()`) and the `leafCategories={leafCategories}` prop on `FilterSidebar` stay as-is — they now carry full paths (the prop is the *options* list).

- [ ] **Step 2: FilterSidebar — field + serialize + control** — in `app/(app)/explorer/FilterSidebar.tsx`:
  - Pending type (line ~65): `leafCategories: string[]` → `leafPaths: string[]`.
  - Seed (line ~88): `leafPaths: f.leafPaths`.
  - `leafMode` derive (line ~89): unchanged.
  - Serialize (lines ~119–120): replace `params.set('leaf', p.leafCategories.join(','))` with:
    ```ts
    } else if (p.leafPaths.length > 0) {
      for (const path of p.leafPaths) params.append('leaf', path);
    }
    ```
  - The typeahead block (lines ~459–462): `selected={pending.leafPaths}` and `onChange={(next) => set('leafPaths', next)}`. Keep `options={leafCategories}` (the options prop).
  - `customCategories` prop type (line ~150) and the two reads (`c.leafNames` at ~494, ~504): rename to `leafPaths`.

- [ ] **Step 3: LeafCategoryTypeahead — path-aware display** — in `app/(app)/explorer/LeafCategoryTypeahead.tsx`:
  - Import `splitCategoryPath` from `@/lib/categoryBuilder/pathDisplay`.
  - Chips: render the leaf (last segment) as the visible label, full path as `title`:
    ```tsx
    {selected.map((cat) => {
      const { leaf } = splitCategoryPath(cat);
      return (
        <span key={cat} className="…">
          <span className="max-w-[180px] truncate" title={cat}>{leaf}</span>
          <button …>×</button>
        </span>
      );
    })}
    ```
  - Dropdown option rows: leaf bold + parent prefix muted underneath:
    ```tsx
    {matches.map((cat, i) => {
      const { leaf, prefix } = splitCategoryPath(cat);
      return (
        <li key={cat} role="option" aria-selected={i === highlight}
            onMouseDown={(e) => { e.preventDefault(); addCategory(cat); }}
            onMouseEnter={() => setHighlight(i)}
            className={`px-2 py-1 cursor-pointer ${i === highlight ? 'bg-blue-100' : 'hover:bg-gray-50'}`}>
          <div className="font-medium text-gray-800">{leaf}</div>
          {prefix && <div className="text-[11px] text-gray-400 truncate" title={cat}>{prefix}</div>}
        </li>
      );
    })}
    ```
  - Substring match stays on the full `opt` string (so typing a department narrows too) — no change to `matches`.
  - Update placeholder copy to "Type to search 11k+ categories…".

- [ ] **Step 4: CategoryBuilderClient — cart holds paths** — in `app/(app)/category-builder/CategoryBuilderClient.tsx`:
  - Import `splitCategoryPath`.
  - `addUnderPath`: `/leaves` now returns full paths — `addLeaves(json.leaves)` adds paths unchanged (the cart is now paths). No code change beyond intent; the `leaves` array is paths.
  - Cart rows (the `cart.map((leaf) => …)` list ~line 391): render `splitCategoryPath(path)` → leaf bold + muted prefix; keep `title={path}`; `removeFromCart(path)`. Rename the map var `leaf` → `path` for clarity.
  - `startEditing(c)`: `setCart(c.leafPaths)`.
  - `handleSave` body: `JSON.stringify({ name: name.trim(), leafPaths: cart })`.
  - Saved-list "N leaves" labels and `CustomCategoryDTO` reads: `c.leafPaths.length`. Copy "leaf(s)" → "categories" where it reads naturally.

- [ ] **Step 5: Verify build + full suite**
  - `npm run typecheck` → PASS (0 errors).
  - `npm test` → PASS (pre-existing `importFile.test.ts` failure from the uncommitted `vitest.config.ts` is the only allowed red; confirm nothing new).
  - `npm run build` → exit 0.
  - `npm run lint` → no NEW errors in changed files.

- [ ] **Step 6: Commit**
```bash
git add "app/(app)/explorer/LeafCategoryTypeahead.tsx" "app/(app)/explorer/FilterSidebar.tsx" \
  "app/(app)/explorer/page.tsx" "app/(app)/category-builder/CategoryBuilderClient.tsx"
git commit -m "$(cat <<'EOF'
feat(categories): path-aware builder + filter UI (leaf-bold/path-muted, repeated leaf params)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Backfill script + gated rollout + manual E2E  ⚠️ USER HANDS REQUIRED

**Files:**
- Create: `scripts/backfillCategoryPaths.ts`

> ⚠️ Steps 2–4 mutate production (DDL + UPDATE) and deploy. PAUSE and get explicit user confirmation before each. Pattern mirrors prior prod-gated backfills (e.g. v2-D).

- [ ] **Step 1: Write the backfill script** — `scripts/backfillCategoryPaths.ts`:
```ts
/**
 * One-time backfill so the path-aware filter is live without waiting for the
 * next weekly refresh. Fills kcs.top_clicked_category_path for the current
 * snapshot week from the slot-1 ASIN's asin_weekly_data.category_path, then
 * repopulates the path-facet rows for the current snapshot_version.
 *
 * Gated: requires CONFIRM_BACKFILL=1. Run:
 *   CONFIRM_BACKFILL=1 node --env-file=.env.local --import tsx scripts/backfillCategoryPaths.ts
 */
import { neon } from '@neondatabase/serverless';

if (process.env.CONFIRM_BACKFILL !== '1') {
  console.error('Refusing to run without CONFIRM_BACKFILL=1');
  process.exit(1);
}
const sql = neon(process.env.DATABASE_URL!);

(async () => {
  const meta = (await sql`
    SELECT current_week_end_date::text AS wk, snapshot_version::text AS sv
    FROM keyword_current_summary_meta WHERE singleton = true
  `) as Array<{ wk: string; sv: string }>;
  const { wk, sv } = meta[0] ?? {};
  if (!wk || !sv) { console.error('No snapshot meta'); process.exit(1); }
  console.log(`Backfilling category paths for week ${wk} (snapshot ${sv})`);

  const upd = (await sql`
    UPDATE keyword_current_summary k
    SET top_clicked_category_path = a.category_path
    FROM asin_weekly_data a
    WHERE a.asin = k.top_clicked_product_1_asin_current
      AND a.week_end_date = ${wk}::date
      AND k.top_clicked_category_path IS NULL
  ` ) as unknown as { rowCount?: number };
  console.log('kcs rows updated:', (upd as any).rowCount ?? '(n/a)');

  // Repopulate path facets for the current snapshot.
  await sql`DELETE FROM keyword_current_summary_leaf_category_facets WHERE snapshot_version = ${sv}::uuid`;
  await sql`
    INSERT INTO keyword_current_summary_leaf_category_facets
      (snapshot_version, category_path, default_severity_count, all_count)
    SELECT ${sv}::uuid, top_clicked_category_path,
      COUNT(*) FILTER (WHERE fake_volume_severity_current IS NULL
        OR fake_volume_severity_current IN ('none','warning'))::int,
      COUNT(*)::int
    FROM keyword_current_summary
    WHERE top_clicked_category_path IS NOT NULL
    GROUP BY top_clicked_category_path
  `;
  const facets = (await sql`SELECT COUNT(*)::int AS n FROM keyword_current_summary_leaf_category_facets WHERE snapshot_version = ${sv}::uuid`) as Array<{ n: number }>;
  console.log('path-facet rows:', facets[0].n);
  console.log('Done.');
})();
```
Commit the script (does not run it):
```bash
git add scripts/backfillCategoryPaths.ts
git commit -m "$(cat <<'EOF'
chore(categories): prod-gated backfill for top_clicked_category_path + path facets

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 2: Apply migration 0039 (USER-CONFIRMED DDL).** Present the SQL; on explicit confirmation, run it against Neon (raw SQL, not `db:migrate`). Verify: column exists, `kcs_leaf_path_idx` present, facet column renamed, `custom_categories` empty.

- [ ] **Step 3: Deploy code.** Branch + open PR or push to main per the user's instruction (push requires explicit per-turn authorization). Vercel (web/Inngest) + Railway (worker) pick it up.

- [ ] **Step 4: Run the backfill (USER-CONFIRMED).** `CONFIRM_BACKFILL=1 node --env-file=.env.local --import tsx scripts/backfillCategoryPaths.ts`. Confirm rows updated + facet count (~11k).

- [ ] **Step 5: Manual E2E.**
  - Builder: drill to `Automotive › … › Air Fresheners`, add it; build a custom category; in the explorer, Custom mode → that category → confirm ONLY Automotive keywords (no Health/Industrial). Repeat picking the Health & Household "Air Fresheners" → only Health keywords.
  - Plain Leaf typeahead: search "air freshener" → three distinct department-qualified options; pick one → results match only that path.
  - A path with a comma in the department (`Clothing, Shoes & Jewelry › …`) round-trips through the URL (shareable link works).
  - An old saved view that had a leaf filter loads without error (leaf clause dropped).
  - Re-create your prior custom categories with the new picker.

- [ ] **Step 6: Update memory.** Mark `category-leaf-overlap.md` resolved (fix shipped: full-path matching), and note the result in `pre-launch-polishing.md` (this slotted before Batch 4).

---

## Self-Review notes
- **Spec coverage:** every spec section maps to a task (A→T2/T4, A2→T4, B→T1/T3, C→T2/T5, D→T4/T6, E→T2/T7, refresh→T4, tests→T1/T3, saved views→T3).
- **Type consistency:** field is `leafPaths` everywhere; helper `splitCategoryPath`; merge fn `mergeCustomPaths`; column `top_clicked_category_path` / `category_path` (facet) / `leaf_paths` (custom). DTO/body key `leafPaths`.
- **Rename ripple is TypeScript-guarded** — `npm run typecheck` is the safety net at each task boundary; full green only after Task 6.
