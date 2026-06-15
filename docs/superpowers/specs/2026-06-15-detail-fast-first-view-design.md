# Keyword Detail Page — Fast First View (Compact Chart Series) — Design

**Status:** Draft for review
**Date:** 2026-06-15
**Goal:** Make the keyword detail page's four trend charts load fast on the *first* (cold) view of a never-opened keyword, by reading a compact precomputed per-keyword series instead of 52 scattered cold rows from `keyword_weekly_metrics`.

---

## Background / Problem

Opening a keyword detail page runs `fetchKeywordDetail(id)`, whose dominant cost is the kwm 52-week history query. Measured against live Neon:

- **Cold: 47–74 seconds**; warm: ~24–57 ms. Reproduced across 4 keywords in different rank bands.
- `EXPLAIN (ANALYZE, BUFFERS)` on a fresh keyword: **69,347 ms, `read=68 dirtied=61`** — the query *plan* is optimal (index scan), but a keyword's 52 weeks live in **~68 physically scattered pages** (each weekly import appends that week's rows together, so one keyword's history is smeared one-row-per-page across a 93 GB + 44 GB partitioned table). Cold, each page is a ~1 s Neon storage fetch.
- **Narrowing `SELECT *` does NOT help** (`toast_size = 0`; the narrow projection touched the same 71 pages). Projection doesn't reduce page reads here.
- The volume work (`model_calibration_runs` fetch = 35 ms) is **not** the cause; it runs in parallel and is trivial.

Because a typical session opens many *new* keywords, caching/streaming alone is insufficient — the first view of each new keyword would still pay ~60 s for its charts. We must make the first view itself fast.

## Scope & Decisions

- **In scope:** the four 52-week charts (Rank, Volume, Fake-volume strip, Title-match history) load fast on first view.
- **Streamed (not in the fast path):** the wide "Weekly history" raw table — it genuinely needs the wide kwm rows (titles, ASINs, shares, categories). It streams in behind `<Suspense>` (below the fold).
- **Coverage:** **active keywords only** (same population as kcs, ~3.9M). Dormant keywords opened directly fall back to the existing (slow) kwm read.
- **Populate hook:** maintenance runs **inside the existing weekly refresh** (`refreshKeywordCurrentSummary`), alongside the kcs rebuild.
- **Out of scope (future pivot):** making the wide raw table instant too. The architecture supports it by widening the stored blob + re-backfilling; deferred.

## Architecture

### A. Data model — `keyword_chart_series`

A dedicated table (kept separate from `search_terms` to keep substring search lean, and from kcs which is active-only + rebuilt weekly):

```
keyword_chart_series (
  search_term_id  uuid PRIMARY KEY REFERENCES search_terms(id),
  series          jsonb       NOT NULL,   -- term's most-recent ≤52 weeks, chronological (oldest→newest)
  last_week       date        NOT NULL,   -- newest week_end_date in `series` (append guard)
  updated_at      timestamptz NOT NULL DEFAULT now()
)
```

`series` is a JSON array of compact per-week objects holding ONLY what the four charts read (short keys to stay small; target ≤ a couple kB, one row vs. ~68 pages):

| key | source column | used by |
|---|---|---|
| `w`  | `week_end_date` | all charts (x-axis) |
| `r`  | `actual_rank` | RankChart line; VolumeChart (volume derived); severity mask |
| `sev`| `fake_volume_severity` (raw; rank>100k mask applied at render) | RankChart tooltip, FakeVolumeStrip |
| `es` | `fake_volume_eval_status` | FakeVolumeStrip tooltip |
| `cs` | `top_clicked_product_1_click_share` | FakeVolumeStrip tooltip |
| `vs` | `top_clicked_product_1_conversion_share` | FakeVolumeStrip tooltip |
| `t`  | `[keyword_in_title_1, _2, _3]` (strict) | TitleMatchHistory |
| `tl` | `[keyword_in_title_1_loose, _2_loose, _3_loose]` | TitleMatchHistory |

**Volume is NOT stored** — it's derived at render from `r` + the current fits via `pickFitForWeek`/`predictVolumeFromFit` (stays fresh across recalibrations; rides on the fit-selection bug fix shipped in `fbded4f`). The `actual_rank > 100000 → severity 'none'` mask is applied at render (consistent with today's read-time masking), so the raw severity is stored.

### B. Populate

**One-time backfill (admin, off-peak):** build the series for all currently-active terms via a single **sequential** kwm scan over the last 52 weeks grouped by term (sequential ≫ the random reads that cause the 60 s page — Neon prefetches it). Throttled / off-peak per the standing "don't slow the site for other users" rule. Idempotent (upsert by `search_term_id`).

**Incremental maintenance (inside the weekly refresh):** the refresh already materializes `latest_per_term` (the current week's row per active term). After the kcs swap, in its own step:

1. **Append (cheap, set-based):** for terms whose `keyword_chart_series.last_week = previous week`, append the current week's fields (from `latest_per_term`), trim to the most-recent 52 entries, set `last_week = current_week`. One `UPDATE … FROM latest_per_term`.
2. **Targeted build (bounded):** for active terms with data this week but **no up-to-date series row** (brand-new, reappeared, or gapped), build their series from a targeted read of their available history. This subset is the per-week churn, off the user's critical path (background refresh). If churn proves large in practice, cap it and let the detail-page fallback (below) cover the overflow until the next refresh.

Never prune on the hot path; a separate optional cleanup can drop series for terms unseen for > 52 weeks.

### C. Detail page — split + stream + fallback

Split today's single `fetchKeywordDetail` so the fast and slow data are independent:

- **`fetchKeywordChartData(id)`** (fast): `search_terms` row, kcs `current`, the fits, the **series**, and the existing fast current-week product/enrichment queries. Renders the header, the four charts (from series-derived points), and the top-products table immediately.
- **`<Suspense fallback={<HistoryTableSkeleton/>}>` → `<WeeklyHistoryTable id={id}/>`**: an async server component that does the slow kwm 52-week read and streams the raw table in.
- **Fallback:** when `fetchKeywordChartData` finds no series row (dormant keyword, direct entry, or backfill not yet run for that term), the charts fall back to today's kwm read. So every rollout step is safe — correctness never depends on the series existing.

The chart components are unchanged: they already accept a `history`-shaped array; we build that array from the series (deriving volume per point) instead of from kwm.

## Files affected

- **Create:** `db/migrations/00NN_keyword_chart_series.sql`, `db/schema/keywordChartSeries.ts`
- **Create:** `lib/explorer/chartSeries.ts` (pure: kwm-row → series-entry, series → chart points, append/trim helpers — unit tested)
- **Create:** `scripts/backfillChartSeries.ts` (one-time, throttled)
- **Create:** `app/(app)/explorer/keyword/[id]/WeeklyHistoryTable.tsx` (streamed async server component)
- **Modify:** `inngest/functions/refreshSummary.ts` (append + targeted-build step)
- **Modify:** `lib/explorer/fetchKeywordDetail.ts` (split into chart-data vs. streamed history; series read + kwm fallback)
- **Modify:** `app/(app)/explorer/keyword/[id]/page.tsx` (Suspense boundary around the raw table)

## Error handling / edge cases

- **No series row →** charts fall back to the kwm read (safe).
- **Re-import / ReplaceWeek →** maintenance is keyed on `last_week`; replacing a week re-runs the append/build idempotently for affected terms.
- **Fit recalibration →** volume re-derived at render, so no stored-volume staleness.
- **Gapped weeks →** `gapFillHistory` already renders gaps; series stores only observed weeks.
- **Brand-new term →** short series (grows weekly); chart shows only observed weeks (correct).
- **Backfill vs. live reads →** backfill upserts; live reads tolerate missing rows via fallback, so the backfill can run incrementally without a maintenance window.

## Testing strategy

- **Pure helpers (`chartSeries.ts`):** kwm-row → entry mapping; append + trim-to-52; series → chart points incl. volume derivation + rank>100k severity mask. Unit tests (vitest).
- **Maintenance SQL:** integration test (against a test DB) — append advances `last_week`; targeted build seeds a newcomer; trim keeps ≤52.
- **Detail page:** chart rows identical whether sourced from series or the kwm fallback (golden comparison on a sample term).
- **Perf check:** re-run the cold-read diagnostic against a series-backed read to confirm first-view drops from ~60 s to low single digits.

## Rollout order

1. Migration + schema (additive; nothing reads it yet).
2. Pure helpers + tests.
3. Backfill script; run for active terms off-peak.
4. Refresh maintenance step (append + targeted build).
5. Detail-page split (charts from series **with kwm fallback**; raw table streamed).
6. Verify first-view latency; then optionally tighten/remove the fallback.

## Risks

- **Per-week churn size** (the targeted-build subset). If a large fraction of active terms are newly-active each week, the refresh's build step could be slow. Mitigation: measure churn during backfill; cap the per-refresh build and lean on the detail-page fallback for overflow. *(Validate during implementation.)*
- **Series size / TOAST.** ~52 × ~12 small fields may exceed the 2 kB inline threshold and TOAST (one extra page fetch — still ≪ 68). Mitigation: compact keys / bitmask flags if needed.
- **Refresh runtime.** The append is cheap; the targeted build is the variable cost (see churn). Stage-and-swap means readers are never blocked regardless.

## Out of scope / future

- **All-instant pivot:** widen `series` (or a sibling blob) with the wide per-week fields and point `WeeklyHistoryTable` at it; re-backfill. Code change is small; cost is a larger store + another backfill.
- **Stale calibration-fit cleanup** (delete the two non-production same-month fits) — separate hygiene task.
