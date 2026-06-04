# Search Volume Lookback Horizons + Detail Graph — Design

**Status:** Approved (design); ready for implementation plan.
**Date:** 2026-06-04
**Author:** pairing session (raw5045 + Claude)

---

## 1. Summary

Make estimated **search volume** a first-class, historical signal in the app — not just a single current-week number. Concretely:

1. Add estimated monthly volume at the **same lookback horizons the explorer already tracks rank at** (current / 4w / 13w / 26w / 52w ago) to `keyword_current_summary` (kcs), so users can **filter and sort the explorer by volume level**, including lookbacks.
2. Add a **per-week volume chart** on the keyword detail page, mirroring the existing rank chart.

The motivation: many users don't think in Amazon SFR (search frequency rank); they think in search volume. Surfacing volume — current and historical — lets them use the app in the units they understand.

This is **Approach A** of three considered (see §4). It deliberately avoids a 140M-row backfill: it computes volume from data the weekly refresh **already** produces, so it is cheap, invisible to users, and **re-runs itself** every refresh.

---

## 2. Background — what exists today

- **The model.** A rank→volume power-law (piecewise) fit lives in `model_calibration_runs`, trained from `poe_calibration_data` (POE search-volume reference points) joined to monthly SFR. Helpers: `pickFitForWeek(weekEndDate, fits)` selects the applicable fit for a week (most-recent calibration month ≤ the week's month; else earliest fit flagged `isExtrapolated`); `buildPiecewiseSql(fit, rankExpr)` emits a SQL `CASE` mapping a rank expression → volume.
- **Where volume is applied today.** `refreshKeywordCurrentSummary` (the `summary_refresh` phase of every import) computes `estimated_monthly_volume_current` for the **current week only** and writes it to kcs. `keyword_weekly_metrics` (kwm) has **no** volume column; there is **no** volume-history table. So historical per-week volume is stored **nowhere**.
- **Detail page.** `fetchKeywordDetail` already fetches all fits and **computes per-week estimated volume at render time** for the 52-week history — but only the **rank** chart (`RankChart`) is drawn; the volume values are unused.
- **Explorer.** `estimated_monthly_volume_current` is already a sortable kcs column with an index (`kcs_est_vol_idx`).
- **Calibration coverage (as of 2026-06-04).** Exactly **one** calibration month exists: **April 2026** (`poe_calibration_data`: 5,480 rows, 1 distinct month; 3 fit variants, live fit is piecewise β=0.375, MAPE ≈ 32%). There are **59 weeks** of history (2025-04-19 → 2026-05-30). Because there is one calibration anchor, weeks before April 2026 (~50 of 59) resolve to the extrapolated fit.

---

## 3. Goals & non-goals

**Goals**
- Explorer: filter + sort by estimated volume **level** at current / 4w / 13w / 26w / 52w ago.
- Detail page: a per-week estimated-volume chart over the 52-week window.
- The whole thing recomputes automatically as calibration improves — **no manual backfill**.
- Stay **invisible to users** of the live site while it runs (no added DB contention).

**Non-goals (explicitly out of scope)**
- A full per-week volume materialization for the entire keyword universe (~140M rows) — that was Approach B; deferred unless a concrete need for *arbitrary-week, whole-universe* slicing appears.
- A volume column on `kwm` (Approach C) — rejected (see §4).
- Volume **movement/trend** filters (e.g. "volume up 50% over 13w") as stored, indexed columns — deferred (decision §5). Levels only for v1.
- An on-demand "recompute now" admin trigger — deferred (decision §5). The weekly refresh is the re-run mechanism.
- Improving the calibration itself (more POE months) — a separate, user-driven data effort. This design is built to benefit from it automatically when it happens.

---

## 4. Decision: Approach A, and why not B/C

| | **A — kcs horizon columns + detail graph (CHOSEN)** | B — full per-week history table | C — volume column on kwm |
|---|---|---|---|
| Rows touched | ~4M (kcs) | ~140M (new table) | ~140M (hot ingest table) |
| Backfill | none (computed in existing refresh) | ~20–30 min one-time | ~20–30 min one-time |
| Storage added | ~4 bigint cols + 4 indexes on 4M rows | ~1–3 GB + indexes | ~1–3 GB + indexes on hot table |
| Re-run as calibration improves | **automatic, every refresh** | manual table rebuild | 140M-row `UPDATE` → WAL/bloat/VACUUM churn |
| User-visibility risk | none (piggybacks on stage-and-swap refresh) | low (throttled/off-peak rebuild) | **higher** (contends with imports on the hot table) |
| Enables | volume filter/sort at standard horizons + detail graph | + arbitrary-week, whole-universe slicing | same as B |

Approach A delivers the user's stated goals (volume filters, lookbacks, detail graph) at a tiny fraction of B/C's cost, and its re-run story is the best possible: because the kcs refresh is a `TRUNCATE+INSERT` rebuild from the current fits on every import, adding calibration months **automatically** improves all volume figures with zero manual work. B/C were rejected for v1; C is rejected outright because repeatedly re-running it (the user's explicit intent as calibration improves) is precisely what bloats the hot ingest table.

---

## 5. Locked scope decisions

- **Levels only.** Ship filter/sort on the **absolute** volume at each horizon. Volume %-change may be computed for *display* at query time, but no stored/indexed change columns in v1. (Rationale: YAGNI; volume movement ≈ rank movement for ranking purposes, and dedicated movement filters can be added later if demand appears.)
- **No recompute trigger.** New calibration takes effect on the next weekly import's refresh. No separate admin "recompute now" button.

---

## 6. Data model

Add to `keyword_current_summary` (drizzle: `db/schema/keywordCurrentSummary.ts`; SQL migration applied directly to Neon after explicit user confirmation — the drizzle journal is stale, same handling as migration 0033):

```
estimated_monthly_volume_4w_ago   bigint  NULL
estimated_monthly_volume_13w_ago  bigint  NULL
estimated_monthly_volume_26w_ago  bigint  NULL
estimated_monthly_volume_52w_ago  bigint  NULL
```

Indexes mirroring the existing `kcs_est_vol_idx` (one per horizon), each `(current_week_end_date, estimated_monthly_volume_Nw_ago)`, so volume filters/sorts within the current snapshot use an index instead of a seq scan.

`NULL` semantics match the rank columns: `NULL` = unranked / no data that far back → no volume.

**Semantic clarity (important):** these are **lookback columns on the *current* active keyword set** — "of the keywords active now, what was each one's estimated volume 13 weeks ago." This is *not* a time-travel snapshot of the full population as it stood 13 weeks ago (that would be Approach B). This matches the intended "lookback filter" use.

---

## 7. Computation — the weekly refresh

In `refreshKeywordCurrentSummary` (`inngest/functions/refreshSummary.ts`):

- The stage build already computes the historical ranks (`rank_4w_ago`, `rank_13w_ago`, `rank_26w_ago`, `rank_52w_ago`) for the current snapshot.
- Extend the existing single current-week volume expression into **five** expressions (current + 4 horizons). For each horizon `N`:
  - Compute the horizon's week-end date = `currentWeekEndDate − N weeks`.
  - `fit_N = pickFitForWeek(horizonWeek, allFits)`.
  - `volume_N expr = buildPiecewiseSql(fit_N.fit, <rank_Nw_ago expression>)`.
  - `NULL` rank → `NULL` volume (piecewise SQL must be NULL-tolerant; verify/guard).
- Write the five values into the corresponding kcs columns in the same `TRUNCATE+INSERT` stage-and-swap. No extra passes, no extra user impact.
- Because `pickFitForWeek` is evaluated per horizon, as more calibration months land each horizon automatically resolves to its appropriate fit. Today (single April fit) all horizons use that fit; pre-April horizons carry the existing `isExtrapolated` semantics.

(Implementation note for the plan: factor the "for each horizon, pick fit + build expr" into a small helper rather than copy-pasting the current-week logic four times.)

**Performance impact on the refresh: negligible (~+1–3 min).** The `summary_refresh` phase currently runs **~95–105 min** on ~4M active terms (observed 5,656s and 6,201s on the last two weeks — the "5–8 min" estimate in the kcs schema comment is stale, predating the volume + Keepa-aggregate work; fix that comment when we touch the schema). The 4 new volume figures **reuse the `rank_Nw_ago` values the refresh already computes** (no new joins or scans) and add only ~4 scalar `POWER()`/`CASE` evaluations per row (~1s total across 4M rows). The only real added cost is maintaining the **4 new indexes** during the stage build — roughly **+1–3 min** (low-single-digit %). Lever if it ever matters: index fewer horizons, or drop the indexes and accept a sub-second-to-seconds scan on volume filters.

---

## 8. Explorer surface

Mirror the existing `estimated_monthly_volume_current` column + the rank-jump filter pattern (Plan 3.2 §8):

- **Query** (`lib/explorer/runQuery.ts`): SELECT the 4 new columns; add min/max filter predicates and sort support per horizon.
- **Filters** (filter sidebar config): a volume min/max input per horizon (current already exists; add 4w/13w/26w/52w). Exact config files to be enumerated in the plan.
- **Results table**: optional volume-at-horizon columns (display), consistent with how rank/improvement columns are shown.
- **Saved views**: include the new volume filters in the serialize/deserialize so they're saveable (parallels how existing filters are persisted).

---

## 9. Detail-page graph

- New component `VolumeChart` (sibling of `app/(app)/explorer/keyword/[id]/RankChart.tsx`), consuming the per-week `estimatedMonthlyVolume` (+ `isExtrapolated`) the detail loader already computes. Confirm `fetchKeywordDetail` returns those per-row values; surface them if not already.
- **Not a pure copy of RankChart:** rank charts invert the axis (lower rank = better, plotted higher); volume is a normal axis (higher = better). Gaps for unranked weeks (`NULL`), same as RankChart.
- Extrapolated weeks rendered distinctly (dashed/shaded) with the existing "extrapolated" tooltip.
- Place it on the detail page near RankChart.

---

## 10. Directional framing (honesty)

Volumes are **directional** estimates (live fit MAPE ≈ 32%), and most lookback horizons currently predate the single April-2026 calibration (flagged extrapolated). Surface this so numbers don't read as exact:
- Reuse the existing "~" / asterisk + tooltip treatment already used for `estimated_monthly_volume_current`.
- On the detail graph, visually distinguish extrapolated weeks.
- No new copywriting system; just consistent reuse of the existing extrapolation affordance.

---

## 11. Re-run model

No manual backfill and no separate trigger. The weekly import's `summary_refresh` rebuilds kcs from scratch using the current fits, so:
- Adding calibration months (via the existing calibration upload) → next refresh recomputes **all** volume figures (current + horizons) and the detail graph improves automatically.
- The user's "do it a 2nd/3rd time as calibration improves" happens continuously and for free.

---

## 12. Testing

- **Pure unit:** per-horizon fit selection (`pickFitForWeek` for current−Nw weeks) and piecewise prediction values; NULL-rank → NULL-volume.
- **Refresh integration:** after a refresh, kcs rows have the 4 new columns populated where ranks exist and NULL where they don't; current-week column unchanged.
- **Explorer:** filter + sort by each horizon volume returns correctly; saved view round-trips a volume filter.
- **Detail:** `VolumeChart` renders a series with gaps and an extrapolated segment; matches the weeks RankChart shows.

---

## 13. File inventory (for the plan)

**New**
- `db/migrations/0034_kcs_volume_lookback.sql` — 4 columns + 4 indexes (0034 = next free number after 0033).
- `app/(app)/explorer/keyword/[id]/VolumeChart.tsx` — per-week volume chart.

**Modified**
- `db/schema/keywordCurrentSummary.ts` — +4 columns, +4 indexes.
- `inngest/functions/refreshSummary.ts` — compute 5 volume expressions (helper for per-horizon fit+expr).
- `lib/explorer/runQuery.ts` — SELECT + filter + sort for the 4 columns.
- Explorer filter config / sidebar + results table column config — add volume-at-horizon filters/columns (exact files enumerated in the plan).
- Saved-views serialization — include volume filters.
- `lib/explorer/fetchKeywordDetail.ts` — ensure per-week volume (+ extrapolation) is returned.
- `app/(app)/explorer/keyword/[id]/page.tsx` — render `VolumeChart`.

**Tests** — per §12; follow existing mocked-db Vitest + component test patterns.

---

## 14. Open questions

None blocking. Two items intentionally deferred (may become follow-ups): stored volume-movement filter columns, and an on-demand recompute trigger.
