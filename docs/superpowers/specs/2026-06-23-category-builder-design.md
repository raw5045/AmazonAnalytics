# Category Builder — Design Spec

**Date:** 2026-06-23
**Status:** Approved in brainstorming — ready for implementation plan
**Branch:** `feat/category-builder`

## Goal

A new **Category Builder** tab where a user browses the Amazon category tree
(Department → … → leaf, drill-down), assembles a **custom category** by adding all
leaves under any node, saves it, and reuses it as a filter in the Explorer and in
saved views.

## Key decisions (locked in brainstorming)

1. **Data-driven tree.** Reconstructed from `asin_weekly_data.category_path` — the
   ` › `-delimited Keepa breadcrumb we already store (99.2% populated). No new
   ingestion, no Keepa API calls. Current data spans **30 departments**; depth is
   **variable, 2–9 levels**.
2. **Name-based matching (v1).** A custom category is a **deduped set of leaf
   names**. It reuses the existing `kcs.top_clicked_leaf_category IN (...)` filter
   — **no migration to `keyword_current_summary`.** Known trade-off: ~1,161 leaf
   names appear under more than one branch and will over-match across departments.
   Path-precise matching is an explicit non-goal for v1 (see below).
3. **Drill-down navigation** (Amazon-style): one level at a time + breadcrumb.
4. **Filter integration by reference.** The filter stores custom-category **IDs**;
   the page loader expands them to leaf names at query time, so editing a category
   propagates everywhere that uses it (including saved views).
5. **Per-user**, capped at **25** custom categories, names unique per user.

## Architecture

### Data model

**Category tree (read-only, shared by all users)**
- `lib/categoryBuilder/buildTree.ts` — **pure**: takes the distinct `category_path`
  strings, splits on ` › `, and builds a nested tree. Exposes a
  `collectDescendantLeaves(node)` helper returning the deduped set of **all leaf
  names** in a node's subtree — every distinct *terminal segment* beneath it. A node
  that is the last segment of some products' paths contributes its own name even if
  it also has children (Keepa paths vary in depth, so the same node can be terminal
  for one product and a parent for another).
- `lib/categoryBuilder/loadTree.ts` — server-only: queries the distinct
  `category_path` values for the **current snapshot**, calls `buildTree`, and
  caches the result **keyed by `snapshot_version`** (from
  `keyword_current_summary_meta`), so it rebuilds automatically once a week when the
  refresh swaps in a new snapshot. No cron.
- For v1 the tree is built from **all** current-week distinct paths. (Refinement,
  not v1: prune to leaves actually present on `kcs.top_clicked_leaf_category` so
  there are zero dead leaves.)

**`custom_categories` table** (hand-numbered **migration 0038**, raw SQL — the
drizzle journal is frozen at 0026, so this is applied directly, not via
`db:migrate`):

```
custom_categories
  id          uuid pk default gen_random_uuid()
  user_id     uuid not null references users(id) on delete cascade
  name        varchar(80) not null
  leaf_names  jsonb not null            -- deduped string[] of leaf-category names
  created_at  timestamptz not null default now()
  updated_at  timestamptz not null default now()
  unique (user_id, lower(name))         -- names unique per user (case-insensitive)
```

- `db/schema/customCategories.ts` — drizzle schema mirroring `savedViews.ts` /
  `watchlistItems.ts`.

### Category Builder page (`/category-builder`)

- New **Category Builder** tab in `app/(app)/TabNav.tsx`, after Watchlist.
- `app/(app)/category-builder/page.tsx` — server component: loads the tree
  (`loadTree`) and the user's custom categories, hands both to the client.
- Client components:
  - **Drill-down browser** — breadcrumb (click a crumb to climb), a
    **"＋ Add all of \<current>"** button, and a row per child: name · **Add** · a
    **›** chevron when it has children (click the row/chevron to drill in). Leaf
    rows show only **Add**.
  - **Build panel** — name input, the deduped list of added leaf names (each with
    ✕ to remove), live count, **Save Custom Category**, **Clear**.
  - **Your custom categories** — each saved one with **Edit** (loads it back into
    the Build panel for rename/adjust → Save updates it) and **Delete**.
- **Add semantics:** collects the node's descendant leaf names into the cart,
  deduped; brief "Added N leaves" confirmation. Adding a parent pulls everything
  beneath, recursively.
- **Performance:** the tree is handed to the client once; drilling and Add are
  **client-side** (no per-click round-trips). ~12k paths gzip small. (Fallback if
  it ever feels heavy: lazy-load each department's subtree.)

### Explorer filter + saved-views integration

- `app/(app)/explorer/FilterSidebar.tsx` — a **Leaf | Custom** segmented toggle on
  the "Leaf categories" field (styled like the Whole-word/Broad toggle). **Custom**
  mode = multi-select the user's custom categories; the applied filter is the union
  of their leaves.
- `lib/explorer/types.ts` + `parseFilters.ts` — new `customCategoryIds: string[]`,
  parsed from a `custom=<id>,<id>` URL param.
- **Expansion (the "by reference" glue):** the explorer page loader, when
  `customCategoryIds` is non-empty, loads those categories for the current user via
  `lib/customCategories/expand.ts`, unions their `leaf_names` into
  `filters.leafCategories`, **then** calls `runExplorerQuery`. **`buildQuery` is
  unchanged** — it still receives a flat list of leaf names.
- `lib/savedViews/validation.ts` — serialize/restore the `custom` IDs in the
  saved-view blob. A deleted category resolves to nothing and drops out gracefully
  (the view still works, minus those leaves).

### APIs (mirror the saved-views routes exactly)

- `app/api/category-builder/custom/route.ts` — `GET` (list the user's categories),
  `POST` (create: name + leaf_names).
- `app/api/category-builder/custom/[id]/route.ts` — `PATCH` (rename / edit leaves),
  `DELETE`.
- `lib/customCategories/validation.ts` — name (≤80, unique per user),
  `leaf_names` (array, deduped), 25-per-user cap.

## Data flow

1. **Builder:** page → `loadTree` (cached per snapshot) + list user categories →
   client drill-down → Add collects descendant leaf names → Save = `POST`/`PATCH`.
2. **Explorer filter:** Custom mode → select categories → `custom=<ids>` in URL →
   page loader expands IDs → leaf names (union with any `leaf` names) →
   `runExplorerQuery` → existing `top_clicked_leaf_category IN (...)`.
3. **Saved views:** serialize the `custom` IDs into the blob → on load, re-expand.

## Testing

- **Pure unit (TDD):** `buildTree` (paths → tree, `collectDescendantLeaves`, dedup,
  variable/odd depths), `validation` (cap / name / dedup / uniqueness),
  `expand` (IDs → leaves, missing or deleted ID → graceful empty), `parseFilters`
  custom param, saved-views custom round-trip.
- **Integration:** the CRUD routes; a `loadTree` smoke against real data.
- **Manual E2E:** build a category → save → filter the Explorer by it → save a
  view → edit the category → confirm the view's results shift.

## Rollout

- **One prod gate:** apply **migration 0038** to Neon (a new empty table — **no
  backfill**). Everything else is code; standard Vercel + Railway deploy. No env
  changes. (Heed: the new page goes live on the next Production deploy.)

## Non-goals / future

- **Path-precise matching** (denormalize `category_path` onto `kcs` + a path-based
  filter) — removes the leaf-name ambiguity. Deferred.
- **Normalized `categories` table** with stable Keepa category IDs.
- **Lazy tree loading** / precomputing the tree during the weekly refresh.
- **Sharing** custom categories between users.
