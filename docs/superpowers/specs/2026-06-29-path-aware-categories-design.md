# Path-Aware Category Matching — Design Spec

**Date:** 2026-06-29
**Status:** Approved (design); implementation plan to follow.
**Slots:** before pre-launch Batch 4 (see `pre-launch-polishing.md`).

## Goal

Make the explorer's leaf-category filter and the Category Builder's custom
categories match keywords by their **full Keepa category path** instead of the
bare leaf **name**, eliminating cross- and intra-department over-match (e.g. an
"Air Fresheners" pick currently pulls Automotive **and** Health & Household
**and** Industrial keywords).

## Background — the bug and the data

The taxonomy is the set of `' › '`-delimited paths in
`asin_weekly_data.category_path` for the current snapshot week. A "leaf" is the
last segment. Today:

- **Keyword side:** `keyword_current_summary.top_clicked_leaf_category` stores
  only the bare leaf (`refreshSummary` copies `p1.category_leaf` of the slot-1
  ASIN — `inngest/functions/refreshSummary.ts:382`).
- **Matching:** `buildQuery` does `kcs.top_clicked_leaf_category IN (bare names)`
  (`lib/explorer/buildQuery.ts:259`); custom categories union their bare
  `leaf_names` straight into that same list (`lib/customCategories/expand.ts`).
- **Storage:** `custom_categories.leaf_names` is a `string[]` of bare names.

So the bug is symmetric: bare storage matched against bare picks.

**Measured overlap** (snapshot week 2026-06-20, throwaway
`scripts/diagLeafOverlap.ts` + `scripts/diagIntraDeptOverlap.ts`):

- Cross-department: **7.0%** of leaf names span >1 department.
- Intra-department: **7.8%** of (department, leaf) pairs have a leaf name
  mapping to >1 path inside one department; **30.55%** of real keywords
  (486,625 / 1,593,005) sit on such a pair. Worst offenders are generic names —
  `[Books] "General"` spans **45** paths, `[Books] "Fiction"` 36,
  `[Clothing] "Pants"` 29.

Because intra-department residual is ~30% keyword-weighted (not negligible),
**department+leaf was rejected** in favour of **full path**.

**Key enabling fact:** in `refreshSummary` the slot-1 ASIN row `p1`
(`asin_weekly_data`) already carries `category_path` and `category_root`
alongside the `category_leaf` we copy today — verified non-null and exactly
equal to the first/last path segments for all 137,221 rows this week. So adding
the full path to the keyword side is **one column, zero new joins, one
backfill**.

## Decisions (locked)

1. **Match key = full category path.** Eliminates both overlap classes; simplest
   matching (single column, single-column `IN`). Accepted cost: a saved path
   silently stops matching if Keepa renames a *middle* segment between weekly
   snapshots (mitigation deferred — see Out of scope).
2. **Scope = both surfaces.** The plain leaf-category typeahead *and* custom
   categories become path-aware. No bare-name matching remains anywhere. This
   unifies everything on one full-path column with one predicate.
3. **Legacy data = wipe & rebuild.** The 3 existing custom categories (all one
   user) store bare names that can't be auto-disambiguated; drop them in the
   migration and re-create with the new picker.
4. **Results grid display = no change.** The read-only "Leaf category" column in
   `ResultsTable` keeps the bare leaf (the adjacent broad "Category" column
   already gives context). No department added, no new hover.

## Changes

### A. Keyword side (data model)

- **Add `keyword_current_summary.top_clicked_category_path text`** — the slot-1
  ASIN's full path. Keep `top_clicked_leaf_category` (display only).
- **Index** `kcs_leaf_path_idx (current_week_end_date, top_clicked_category_path)`
  mirroring the existing `kcs_leaf_category_idx`. **Drop** the now-dead
  `kcs_leaf_category_idx` (nothing filters bare leaf anymore).
- **Facet table:** rename
  `keyword_current_summary_leaf_category_facets.leaf_category → category_path`
  (PK stays valid). Drives the typeahead option list (11,150 paths vs 10,250
  names — same magnitude).

### A2. Weekly refresh (`refreshSummary`) — MANDATORY, not optional

`refreshSummary` rebuilds kcs from scratch every import (`TRUNCATE` + `INSERT`).
If it isn't updated, the **next weekly import wipes the backfilled
`top_clicked_category_path` back to NULL** and the filter breaks until the next
manual backfill. So these edits are required for the fix to survive past week 1:

1. **Main kcs INSERT** (`inngest/functions/refreshSummary.ts:305` column list +
   `:382` select): add `top_clicked_category_path` to the column list and
   `p1.category_path AS top_clicked_category_path` to the SELECT, beside the
   existing `p1.category_leaf AS top_clicked_leaf_category`. `p1`
   (`asin_enriched_current`) is already joined — **zero new joins**.
2. **Leaf-facet populate** (`refreshSummary.ts:520`–`532`): insert into the
   renamed `category_path` column and `GROUP BY top_clicked_category_path`
   instead of `top_clicked_leaf_category`.

### B. Matching (explorer)

- **Filter field rename** `ExplorerFilters.leafCategories → leafPaths` (full
  paths). Ripples through `types.ts`, `parseFilters.ts`, `buildQuery.ts`,
  `FilterSidebar.tsx`, `page.tsx`, saved-view serialize, `expand.ts`.
  TypeScript catches every site.
- **`buildQuery`:** `kcs.top_clicked_category_path IN (…)` replaces the bare-leaf
  predicate.
- **`expandCustomCategories`:** emits full paths; plain + custom merge into the
  one `leafPaths` list → one predicate (same architecture as today).
- **URL encoding fix (important):** the `leaf=` param is currently comma-joined
  (`parseLeafCategories` splits on `,`), but department names contain commas
  (`Clothing, Shoes & Jewelry`), which corrupts paths. Switch to **repeated
  params** (`leaf=<path>&leaf=<path>`). Verified mechanics:
  - `SearchParamsLike` is already `Record<string, string | string[] | undefined>`
    and Next delivers repeated query params as `string[]` — so a new
    `parseLeafPaths(raw: string | string[] | undefined)` reads the array (or a
    lone string) and **does not comma-split**. Pass the raw `searchParams.leaf`
    (not `getOne(...)`).
  - FilterSidebar serialize: `for (const p of paths) params.append('leaf', p)`
    instead of `set('leaf', join(','))`.
  - `custom` (UUIDs, comma-safe) keeps the existing comma encoding — only `leaf`
    changes. Keep the comma-split helper for `custom`.

### C. Storage (custom categories)

- **Rename `custom_categories.leaf_names → leaf_paths`** (jsonb of full paths).
  Wiping legacy rows means no data migration needed.
- **Validation:** `normalizeLeafNames → normalizePaths` (dedupe, non-empty
  strings; do not over-validate `' › '` presence). DTO (`loadServer.ts`),
  `expand.ts`, and `CustomCategoryDTO` follow the rename.

### D. Builder + filter UI (capture and show the path)

- **`loadLeavesUnderPath` + `/api/category-builder/leaves`:** return full
  `category_path` strings, not last-segments. The loader already selects
  `DISTINCT category_path` — just stop reducing to the leaf. **Bump the
  `unstable_cache` key** (`category-builder-leaves` → `…-v2`) so the deploy
  doesn't serve old bare-name arrays.
- **`CategoryBuilderClient`:** cart holds full paths; each cart row and each
  browser row renders **leaf bold + parent path muted** (split on `PATH_SEP`).
  POST/PATCH sends `{ name, leafPaths }`. "N leaves" → "N categories".
- **`LeafCategoryTypeahead`:** options are full-path strings (prop stays
  `string[]`). Display splits on `PATH_SEP` → leaf bold, prefix muted; chips
  show the last segment with the full path as `title`. Substring search stays on
  the whole path string (so typing a department also narrows).
- **`listLeafCategories`:** read `category_path` from the renamed facet table;
  update the legacy fallback to `DISTINCT top_clicked_category_path`. **Bump the
  cache key** (`explorer-leaf-categories` → `…-v2`).

### E. Migration 0039 + backfill (hand-numbered raw SQL)

Migration `db/migrations/0039_path_aware_categories.sql`:
```sql
ALTER TABLE keyword_current_summary ADD COLUMN top_clicked_category_path text;
CREATE INDEX kcs_leaf_path_idx
  ON keyword_current_summary (current_week_end_date, top_clicked_category_path);
DROP INDEX IF EXISTS kcs_leaf_category_idx;
ALTER TABLE keyword_current_summary_leaf_category_facets
  RENAME COLUMN leaf_category TO category_path;
ALTER TABLE custom_categories RENAME COLUMN leaf_names TO leaf_paths;
DELETE FROM custom_categories;  -- wipe legacy bare-name rows
```

Backfill (prod-gated script, the established pattern) so the fix is live without
waiting for the next 8-min refresh:
- `UPDATE keyword_current_summary k SET top_clicked_category_path = a.category_path
   FROM asin_weekly_data a
   WHERE a.asin = k.top_clicked_product_1_asin_current
     AND a.week_end_date = k.current_week_end_date;` (batched)
- Repopulate the path-facet rows for the current `snapshot_version`
  (DELETE + INSERT grouped by `top_clicked_category_path`).

`refreshSummary` handles both automatically every week thereafter.

## Risks & migration considerations

- **DDL on Neon** requires explicit user confirmation before running; backfill is
  prod-gated (matches prior rollouts).
- **Cache-shape staleness:** bump the two `unstable_cache` key identifiers
  (leaves loader, leaf-categories list) so post-deploy reads don't serve
  old-shaped arrays. The public route `Cache-Control` (s-maxage 3600) means CDN
  copies of `/leaves` age out within an hour — acceptable.
- **Saved views** store a structured `filters` jsonb blob read by
  `normalizeFiltersBlob`, which reads `f.leafCategories` directly. After the
  rename it reads `f.leafPaths`; old blobs have no `leafPaths`, so the leaf
  clause becomes empty and **fails open** (the view drops its leaf filter rather
  than matching nothing). No `saved_views` data migration needed — the user can
  re-save any affected view. Also update `normalizeFiltersBlob` (read
  `leafPaths`) and `filtersToSearchParams` (emit `p.leaf` as a `string[]`, which
  `SearchParamsLike` already allows).
- **Rollout order:** migration → deploy code (refreshSummary, buildQuery,
  listLeafCategories, builder, typeahead, parse/serialize) → run backfill. The
  column exists-but-NULL window is closed by the backfill.

## Testing (TDD)

- `expand.test.ts` — merges full paths into `leafPaths`.
- `validation.test.ts` — `normalizePaths` dedupe/trim.
- `buildQuery` test — emits `top_clicked_category_path IN`.
- `parseFilters` test — repeated-param decode, incl. a department-with-comma
  path round-trip (the regression this fixes).
- Loader/route — `loadLeavesUnderPath` returns full paths.
- Builder/sidebar render — leaf-bold/path-muted split is a pure helper, unit
  tested.

## Out of scope (follow-ups)

- **Stale-path flag** in the builder ("3 picks no longer in the current
  taxonomy — re-pick") for the Keepa mid-path-drift case. Worth adding once real
  users accumulate saved categories; not needed now (legacy is wiped, picks are
  fresh).
- Making the broad "Category" (BA top-clicked category) filter path-aware — it's
  a different, shallow taxonomy and wasn't part of the reported problem.
