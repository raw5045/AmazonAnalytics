# Explorer Movement Filter + Volume Column Cleanup — Design

**Date:** 2026-06-15
**Status:** Approved (design); pending spec review → implementation plan
**Author:** raw5045 + Claude Opus 4.8

---

## 1. Goal

Declutter the keyword explorer's volume surface area:

1. **Table:** show only the current **Est. monthly volume** column; remove the four lookback volume columns (4w / 13w / 26w / 52w ago).
2. **Filters:** replace the eight per-horizon volume min/max inputs **and** the existing SFR threshold-jump with a single **Movement filter** that has a **Rank ⇄ Volume** metric toggle, a comparison **window**, and a **preset / custom** threshold-jump — all in one card.

## 2. Motivation

The lookback volume columns and eight min/max filters are noisy and clutter the page. Separately, because estimated volume is *derived from rank* via the model (and today there is a single calibration fit, so the rank→volume mapping is the same every week), a "volume jump" is mathematically the **same filter** as the rank threshold-jump — just expressed in searches/month. Its only added value is friendlier units. The clean answer is therefore one jump widget with a unit toggle, not two parallel filter families.

## 3. Scope

**In scope**
- Remove the 4 lookback volume columns + their sort headers from the results table (keep current volume).
- Remove the 8 volume min/max filter inputs and the 8 volume sort keys.
- Build the unified Movement filter (metric toggle + window + preset/custom jump).
- Add a `estimated_monthly_volume_1w_ago` column so Volume mode supports the full 1w/4w/13w/26w/52w window set (parity with Rank).
- Saved-view / URL back-compat for removed params.

**Out of scope**
- "Got worse" / decline-direction detection (the jump always means *improved*).
- Sorting by current volume (it stays a display-only column).
- Removing any kcs volume **data** columns — they back the filter and the detail-page chart.
- The pre-existing stage/live index asymmetry (tracked separately).

## 4. Part 1 — Results-table cleanup

- **Remove** from `ResultsTable.tsx`: the 4 lookback volume column headers (`vol_4w` / `vol_13w` / `vol_26w` / `vol_52w` sortable headers) and their 4 `<td>` cells.
- **Keep:** the single current **Est. monthly volume** column (display-only; not sortable, unchanged from today).
- **Remove** the 4 lookback fields from the explorer row contract — `ExplorerRow.estimatedMonthlyVolume{4w,13w,26w,52w}Ago`, the matching `RawRow` fields, the `SELECT` columns in `runQuery.ts` / `buildQuery.ts`, the mapper entries, and the parallel fields in `fetchExplorerRowsByIds.ts`. Keep `estimatedMonthlyVolumeCurrent` everywhere it appears.
- **Untouched:** the kcs lookback columns in the database and the detail-page `VolumeChart` (it computes its own per-week history; it does not read these explorer-row fields).

## 5. Part 2 — The Movement filter

A single filter card replacing the current jump section and the volume min/max section.

### 5.1 Controls

- **Metric toggle:** `Rank` (default) ⇄ `Volume` (est. searches/mo).
- **Window** (comparison horizon): `1w / 4w / 13w / 26w / 52w` for **both** metrics. This is the existing global `window` selector, relocated into the Movement card. It continues to drive the table's "vs N-ago" rank column and the improvement/decline sort, so the displayed comparison and the active filter stay on the same horizon.
- **Preset dropdown** (metric-specific) **+ Custom**:
  - **Rank presets** (unchanged): 500k→100k, 100k→50k, 100k→10k, 50k→10k.
  - **Volume presets** (new): under 5k→over 15k, under 15k→over 30k, under 30k→over 100k, under 15k→over 100k.
  - **Custom:** two threshold inputs with metric-appropriate labels.

### 5.2 Semantics ("got better" only)

Let `W` = selected window. The jump resolves a `(from, to)` pair (from the chosen preset, or the custom inputs) and emits:

- **Rank mode** — *was ranked worse than `from` AND is now better than `to`*:
  ```
  kcs.<rank_col(W)> > {from} AND kcs.current_rank < {to}
  ```
  where `rank_col(W)`: 1w→`prior_week_rank`, 4w→`rank_4w_ago`, 13w→`rank_13w_ago`, 26w→`rank_26w_ago`, 52w→`rank_52w_ago`. Custom requires `from > to` (worse number → better number).

- **Volume mode** — *had fewer than `from` searches/mo AND now has more than `to`*:
  ```
  kcs.<vol_col(W)> < {from} AND kcs.estimated_monthly_volume_current > {to}
  ```
  where `vol_col(W)`: 1w→`estimated_monthly_volume_1w_ago`, 4w→`estimated_monthly_volume_4w_ago`, 13w→`…_13w_ago`, 26w→`…_26w_ago`, 52w→`…_52w_ago`. Custom requires `from < to` (lower number → higher number).

An invalid custom pair (direction wrong for the metric) drops the jump clause, mirroring today's rank behavior.

### 5.3 Preset tables (exact)

| Rank preset id | from | to |
|---|---|---|
| `500k_to_100k` | 500000 | 100000 |
| `100k_to_50k` | 100000 | 50000 |
| `100k_to_10k` | 100000 | 10000 |
| `50k_to_10k` | 50000 | 10000 |

| Volume preset id | from | to | label |
|---|---|---|---|
| `v5k_to_15k` | 5000 | 15000 | under 5k → over 15k |
| `v15k_to_30k` | 15000 | 30000 | under 15k → over 30k |
| `v30k_to_100k` | 30000 | 100000 | under 30k → over 100k |
| `v15k_to_100k` | 15000 | 100000 | under 15k → over 100k |

## 6. Data model (`lib/explorer/types.ts`)

**Remove from `ExplorerFilters`:** `volume4wAgoMin/Max`, `volume13wAgoMin/Max`, `volume26wAgoMin/Max`, `volume52wAgoMin/Max` (8 fields).

**Remove from `SortKey`:** `vol_4w_asc/desc`, `vol_13w_asc/desc`, `vol_26w_asc/desc`, `vol_52w_asc/desc` (8 keys), plus their `buildOrderBy` cases.

**Add to `ExplorerFilters`:** `jumpMetric: 'rank' | 'volume'` (default `'rank'`).

**Keep:** `window`, `jump` (now a rank-preset id | volume-preset id | `'custom'` | `null`), `jumpFrom`, `jumpTo`.

**Remove from `ExplorerRow` / `RawRow`:** the 4 lookback volume fields (keep `estimatedMonthlyVolumeCurrent`).

Preset lookups live in two maps keyed by metric (`RANK_JUMP_PRESETS`, `VOLUME_JUMP_PRESETS`); `jumpMetric` selects which map to consult and which column family the jump targets.

## 7. Query builder (`lib/explorer/buildQuery.ts`)

- Add `WINDOW_TO_VOLUME_COLUMN` (the 1w→`estimated_monthly_volume_1w_ago` … 52w map).
- Replace the single rank jump branch with a metric-aware jump branch (§5.2): resolve `(from, to)` from preset or custom, then emit the rank or volume clause based on `jumpMetric`.
- **Delete** the volume min/max `WHERE` loop and the 8 volume `buildOrderBy` cases.
- **Delete** the 4 lookback volume columns from the `SELECT` list (keep `estimated_monthly_volume_current`).
- No change to the count-query join logic shipped earlier (the jump clause references `kcs` only, so the count still drops the `search_terms` join when there is no `q`).

## 8. New 1-week volume data

The 1-week-ago rank is already staged in the refresh (it is the source of `prior_week_rank`), and `buildVolumeExpressions` already turns any horizon's rank into a volume via the fit for that horizon's week. Adding 1w volume is therefore data we already have run through machinery already in place.

- **Migration** (`db/migrations/0035_kcs_volume_1w.sql`, shape identical to 0034): add `estimated_monthly_volume_1w_ago` (`bigint`) to **both** `keyword_current_summary` and `keyword_current_summary_stage`; create `kcs_est_vol_1w_idx` on the live table and `kcs_stage_est_vol_1w_idx` on the stage table, each `(current_week_end_date, estimated_monthly_volume_1w_ago)`.
- **Schema** (`db/schema/keywordCurrentSummary.ts`): add `estimatedMonthlyVolume1wAgo` column + `estVol1wIdx` index.
- **Refresh** (`inngest/functions/refreshSummary.ts`): add a 1-week horizon to `VOLUME_HORIZONS` whose `rankCol` is the 1-week-offset staged rank — the same staged value that already populates `prior_week_rank` (exact alias confirmed against `stageRankAtOffset(client, 1)` at plan time). Add `estimated_monthly_volume_1w_ago` to the INSERT column list + its `volume.exprs[…]` slot, and re-index the `exprs[]` positions to account for the inserted horizon.
- **Population:** the column is NULL until a refresh runs. It populates on the next weekly import; a manual refresh can populate it immediately at ship time.

## 9. Parsing, URL & saved views

- **`parseFilters.ts`:** parse `jumpMetric` (default `'rank'`); drop the 8 removed volume params and 8 removed sort keys from defaults/whitelists; validate custom `from/to` direction per metric (rank: `from > to`; volume: `from < to`), dropping the jump if invalid.
- **URL params:** add `jumpMetric=rank|volume` (omitted ⇒ `rank`). Volume preset ids (`v…`) and rank preset ids share the `jump` param; `jumpMetric` disambiguates.
- **Saved views (`lib/savedViews/validation.ts` + `loadServer.ts`):** serialize/deserialize `jumpMetric`; **ignore** the removed volume min/max params and removed `vol_*` sort keys when loading old views (unknown sort ⇒ default sort). Existing saved rank jumps (no `jumpMetric`) load as Rank mode unchanged.

## 10. UI (`app/(app)/explorer/`)

- **`FilterSidebar.tsx`:** delete the 4 volume min/max `FieldGroup` pairs; build the Movement card (metric toggle, relocated window dropdown, metric-aware preset dropdown, metric-aware custom inputs); drop the 4 volume options from the `SORTS` list. `PendingFilters` / `filtersToPending` / `pendingToParams` updated to add `jumpMetric` and drop the 8 volume fields.
- **`ResultsTable.tsx`:** delete the 4 lookback volume `SortableHeader`s and `<td>`s; header/cell counts stay balanced.

## 11. File inventory

| File | Change |
|---|---|
| `db/migrations/0035_kcs_volume_1w.sql` | **new** — 1w volume column + index on both swap tables |
| `db/schema/keywordCurrentSummary.ts` | add 1w volume column + index |
| `inngest/functions/refreshSummary.ts` | add 1w volume horizon + INSERT column |
| `lib/explorer/types.ts` | drop 8 volume fields + 8 sort keys; add `jumpMetric`; drop 4 row fields |
| `lib/explorer/parseFilters.ts` | `jumpMetric` parse/validate; remove volume params/sorts |
| `lib/explorer/buildQuery.ts` | metric-aware jump; remove volume min/max + volume sorts + lookback SELECT cols |
| `lib/explorer/runQuery.ts` | drop 4 lookback fields from RawRow/SELECT/mapper |
| `lib/explorer/fetchExplorerRowsByIds.ts` | drop 4 lookback fields from RawRow/SELECT/mapper |
| `lib/savedViews/validation.ts`, `loadServer.ts` | serialize `jumpMetric`; ignore removed params |
| `app/(app)/explorer/FilterSidebar.tsx` | Movement card; remove volume min/max + volume sorts |
| `app/(app)/explorer/ResultsTable.tsx` | remove 4 lookback volume columns |

## 12. Testing

- **`buildQuery.test.ts`:** rank jump unchanged; volume jump emits the right `vol_col(W) < from AND current > to` clause; preset resolution per metric; custom validation per metric; **no** volume min/max clauses; **no** volume sort cases; current-volume SELECT retained, lookback SELECT columns gone.
- **`parseFilters.test.ts`:** `jumpMetric` default + parse; removed params ignored; per-metric custom validation.
- **Saved-views tests:** `jumpMetric` round-trips; old views with removed params load without error and ignore them.
- **Component tests** (if present): `ResultsTable` column count; `FilterSidebar` Movement card renders the right presets per metric.
- Full `pnpm typecheck` + `pnpm test`.

## 13. Rollout

1. Migration 0035 applied to Neon (with explicit confirmation), mirroring the 0034 apply.
2. Ship code; populate 1w volume via a manual refresh (or the next weekly import).
3. The Movement filter's 1w Volume option returns data only after that refresh; everything else is live immediately.
