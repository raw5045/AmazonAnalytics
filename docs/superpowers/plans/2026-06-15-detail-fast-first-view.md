# Keyword Detail — Fast First View (Compact Chart Series) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the keyword detail page's four 52-week charts load fast on a cold first view by reading a compact per-keyword `keyword_chart_series` row instead of ~68 scattered cold kwm pages (~60 s → low single digits).

**Architecture:** New `keyword_chart_series` table (active-only) holds each term's last ≤52 weeks of the *small* chart fields. Backfilled once (off-peak sequential scan), then maintained inside the existing weekly refresh (cheap set-based append + targeted rebuild for newcomers). The detail page renders charts from the series (volume derived at render via the calibration fits); the wide "Weekly history" table streams behind `<Suspense>`; a kwm fallback covers any missing series row so every step is safe.

**Tech Stack:** Postgres + Drizzle (dual driver: neon-http on Vercel, node-postgres on the worker), Next.js 16 App Router (RSC + Suspense streaming), Inngest (refresh job), vitest.

**Spec:** `docs/superpowers/specs/2026-06-15-detail-fast-first-view-design.md`

---

## File Structure

- **Create** `db/migrations/0036_keyword_chart_series.sql` — the table (hand-written DDL, matching the named-migration convention).
- **Create** `db/schema/keywordChartSeries.ts` — Drizzle table + `ChartSeriesEntry` type.
- **Create** `lib/explorer/chartSeries.ts` — pure helpers: kwm-row→entry, append+trim, series→chart rows (volume derivation + severity mask). Unit tested.
- **Create** `lib/explorer/chartSeries.test.ts` — vitest unit tests.
- **Create** `scripts/backfillChartSeries.ts` — one-time, throttled, windowed backfill.
- **Modify** `inngest/functions/refreshSummary.ts` — append + targeted-rebuild maintenance step after the swap.
- **Modify** `lib/explorer/fetchKeywordDetail.ts` — split into `fetchKeywordChartData` (fast, series + fallback) and `fetchKeywordRawHistory` (slow, streamed).
- **Create** `app/(app)/explorer/keyword/[id]/WeeklyHistoryTable.tsx` — streamed async server component.
- **Modify** `app/(app)/explorer/keyword/[id]/page.tsx` — render charts from chart-data; `<Suspense>` around the raw table.

**Commit trailer (every commit):** `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

---

## Task 1: Migration + schema

**Files:**
- Create: `db/migrations/0036_keyword_chart_series.sql`
- Create: `db/schema/keywordChartSeries.ts`
- Modify: `db/schema/index.ts` (or wherever schemas are re-exported — match existing pattern)

- [ ] **Step 1: Write the migration SQL**

```sql
-- 0036_keyword_chart_series.sql
-- Compact per-keyword chart series for fast detail-page first view.
-- One row per ACTIVE search term; `series` is the term's most-recent
-- <=52 weeks of the small fields the four detail charts read.
CREATE TABLE IF NOT EXISTS keyword_chart_series (
  search_term_id uuid PRIMARY KEY REFERENCES search_terms(id) ON DELETE CASCADE,
  series         jsonb       NOT NULL,
  last_week      date        NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
```

- [ ] **Step 2: Add the Drizzle schema + entry type**

```ts
// db/schema/keywordChartSeries.ts
import { pgTable, uuid, jsonb, date, timestamp } from 'drizzle-orm/pg-core';
import { searchTerms } from './searchTerms'; // match the actual import path

/** One compact week in a keyword_chart_series.series array. Short keys to stay small. */
export interface ChartSeriesEntry {
  w: string;                                  // week_end_date YYYY-MM-DD
  r: number;                                  // actual_rank
  sev: string | null;                         // fake_volume_severity (raw; masked at render)
  es: string | null;                          // fake_volume_eval_status
  cs: string | null;                          // top_clicked_product_1_click_share
  vs: string | null;                          // top_clicked_product_1_conversion_share
  t: [boolean | null, boolean | null, boolean | null];   // keyword_in_title_1/2/3 (strict)
  tl: [boolean | null, boolean | null, boolean | null];  // keyword_in_title_1/2/3_loose
}

export const keywordChartSeries = pgTable('keyword_chart_series', {
  searchTermId: uuid('search_term_id').primaryKey().references(() => searchTerms.id, { onDelete: 'cascade' }),
  series: jsonb('series').$type<ChartSeriesEntry[]>().notNull(),
  lastWeek: date('last_week').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 3: Typecheck** — Run: `pnpm typecheck`. Expected: clean.
- [ ] **Step 4: Commit** (do NOT run `db:migrate` against Neon yet — applying DDL to prod needs explicit user confirmation; the controller will request it before the backfill task).

```bash
git add db/migrations/0036_keyword_chart_series.sql db/schema/keywordChartSeries.ts db/schema/index.ts
git commit -m "feat(detail): keyword_chart_series table + schema"
```

---

## Task 2: Pure helpers (TDD)

**Files:**
- Create: `lib/explorer/chartSeries.ts`
- Create: `lib/explorer/chartSeries.test.ts`

These are the load-bearing pure functions. TDD them.

**Interfaces:**
```ts
import type { ChartSeriesEntry } from '@/db/schema/keywordChartSeries';
import type { KeywordDetailHistoryRow } from './fetchKeywordDetail';
import type { FitParams } from '@/lib/analytics/volumeModel';

/** Map one kwm history row (raw DB shape) to a compact entry. */
export function kwmRowToEntry(row): ChartSeriesEntry;

/** Append an entry, dedupe by week (idempotent re-import), keep most-recent <=52, chronological. */
export function appendWeek(series: ChartSeriesEntry[], entry: ChartSeriesEntry, cap = 52): ChartSeriesEntry[];

/** Build the chart row shape the 4 charts consume, deriving volume from rank+fits
 *  and applying the rank>100000 -> 'none' severity mask. Raw-table-only fields are null. */
export function seriesToHistoryRows(series: ChartSeriesEntry[], fits: ReadonlyArray<FitParams>): KeywordDetailHistoryRow[];
```

- [ ] **Step 1: Write failing tests** (`chartSeries.test.ts`), covering:
  - `appendWeek` keeps the most-recent 52 when given 53 (drops oldest, stays chronological).
  - `appendWeek` is idempotent: appending an entry whose `w` already equals the last entry's `w` replaces it, not duplicates.
  - `seriesToHistoryRows` derives `estimatedMonthlyVolume` equal to `Math.round(predictVolumeFromFit(rank, pickFitForWeek(w, fits).fit))` and sets `estimatedMonthlyVolumeIsExtrapolated` from the selection.
  - `seriesToHistoryRows` masks severity to `'none'` when `r > 100000` (mirrors today's read-time mask) and maps `t`/`tl` into `keywordInTitle{1,2,3}` / `…Loose`.
- [ ] **Step 2: Run tests, verify they fail** — Run: `pnpm test chartSeries`. Expected: FAIL (functions not implemented).
- [ ] **Step 3: Implement `lib/explorer/chartSeries.ts`** to pass. Reuse `pickFitForWeek` + `predictVolumeFromFit` from `@/lib/analytics/volumeModel` for volume (identical to today's `mapHistory`). Raw-table-only `KeywordDetailHistoryRow` fields (product asins/titles, match counts, variants) are set to `null`/defaults — the four charts never read them.
- [ ] **Step 4: Run tests, verify pass** — Run: `pnpm test chartSeries`. Expected: PASS.
- [ ] **Step 5: Typecheck** — `pnpm typecheck`. Expected: clean.
- [ ] **Step 6: Commit**

```bash
git add lib/explorer/chartSeries.ts lib/explorer/chartSeries.test.ts
git commit -m "feat(detail): pure chart-series helpers (entry map, append/trim, series->rows)"
```

---

## Task 3: Backfill script

**Files:**
- Create: `scripts/backfillChartSeries.ts`

**Approach:** one **windowed sequential** read (not per-term random reads). Select the last 52 weeks of kwm for ACTIVE terms (active = `last_seen_week >= current_week - 28 days`; reuse the kcs active set), `ORDER BY search_term_id, week_end_date`, stream rows, group by term in JS, `appendWeek` into a series, and batch-`upsert` into `keyword_chart_series`. Throttle: bounded batch size + a short sleep between batches so the scan doesn't starve live readers (standing "don't slow the site" rule). Idempotent (`ON CONFLICT (search_term_id) DO UPDATE`).

- [ ] **Step 1: Write the script** using `pg.Pool` (mirror `scripts/diagStaleStats.ts` connection + `.env.local`). Use a server-side cursor or `LIMIT/OFFSET`-free keyset pagination by `(search_term_id, week_end_date)` to stream. Build each term's `ChartSeriesEntry[]` with `kwmRowToEntry` + `appendWeek`; flush per term (term boundary) in batches.
- [ ] **Step 2: Dry-run on a small slice** — add a `--limit-terms N` guard; run `pnpm tsx scripts/backfillChartSeries.ts --limit-terms 50`. Verify: 50 rows written; spot-check one series matches that term's kwm (rank per week) via a quick read.
- [ ] **Step 3: Commit** (the FULL backfill run is an operational step the controller schedules off-peak AFTER the migration is applied + user confirms — not part of this commit).

```bash
git add scripts/backfillChartSeries.ts
git commit -m "feat(detail): one-time chart-series backfill script (windowed, throttled)"
```

---

## Task 4: Refresh maintenance (append + targeted rebuild)

**Files:**
- Modify: `inngest/functions/refreshSummary.ts`

**Where:** after the stage↔live swap + meta update (the new series table is independent of the swap). Add `await maintainChartSeries(client, currentWeekEndDate)` near the end of the `try`. `latest_per_term` is dropped `ON COMMIT` — so either run maintenance before the first `COMMIT`, or re-derive the current-week rows. Simplest: read the current-week rows the maintenance needs directly from the just-swapped `keyword_current_summary` (it has current rank, severity, in-title flags, shares for the current week) — avoids depending on the temp table's lifetime.

**Two set-based steps inside `maintainChartSeries`:**

1. **Append** (contiguous terms): build the new entry from the current snapshot and append+trim in SQL.
```sql
UPDATE keyword_chart_series s
SET series = (CASE WHEN jsonb_array_length(s.series) >= 52 THEN s.series - 0 ELSE s.series END)
             || jsonb_build_array(jsonb_build_object(
                  'w',  to_char(k.current_week_end_date, 'YYYY-MM-DD'),
                  'r',  k.current_rank,
                  'sev', k.fake_volume_severity_current,
                  'es', NULL,
                  'cs', k.top_clicked_product_1_click_share_current,
                  'vs', k.top_clicked_product_1_conversion_share_current,
                  't',  jsonb_build_array(k.keyword_in_title_1_current, k.keyword_in_title_2_current, k.keyword_in_title_3_current),
                  'tl', jsonb_build_array(k.keyword_in_title_1_loose_current, k.keyword_in_title_2_loose_current, k.keyword_in_title_3_loose_current)
                )),
    last_week = k.current_week_end_date, updated_at = now()
FROM keyword_current_summary k
WHERE s.search_term_id = k.search_term_id
  AND s.last_week = (k.current_week_end_date - INTERVAL '7 days')::date;  -- contiguous only; idempotent (skips already-appended)
```
> NOTE: kcs does not store `fake_volume_eval_status`; `es` is set NULL on appended weeks (the strip's tooltip only needs it when severity is NULL, which the rank>100k mask already covers — acceptable; documented). If a non-null `es` is required, source it from a targeted kwm read instead.

2. **Targeted rebuild** (newcomers / gapped / missing): find active terms whose series is absent or not advanced to the current week, and rebuild them from kwm (their last ≤52 weeks), upsert. Reuse the backfill's per-term build logic over the filtered ID set.
```sql
-- terms needing rebuild
SELECT k.search_term_id
FROM keyword_current_summary k
LEFT JOIN keyword_chart_series s ON s.search_term_id = k.search_term_id
WHERE s.search_term_id IS NULL OR s.last_week <> k.current_week_end_date;
```

- [ ] **Step 1: Write a failing integration test** (`inngest/functions/refreshSummary.chartSeries.test.ts`, gated like other DB tests) seeding a tiny kwm + kcs + one existing series, asserting: append advances `last_week` and length stays ≤52; a newcomer (no series) gets built; re-running is idempotent.
- [ ] **Step 2: Run it, verify it fails.**
- [ ] **Step 3: Implement `maintainChartSeries`** + wire it into `refreshKeywordCurrentSummary`. Keep it fail-soft (a `try/catch` that logs and continues — a series-maintenance error must never fail the import/refresh, since the detail page has the kwm fallback).
- [ ] **Step 4: Run the test, verify pass; then `pnpm test refreshSummary`** (don't regress existing refresh tests) **+ `pnpm typecheck`.**
- [ ] **Step 5: Commit**

```bash
git add inngest/functions/refreshSummary.ts inngest/functions/refreshSummary.chartSeries.test.ts
git commit -m "feat(detail): maintain chart series in the weekly refresh (append + rebuild)"
```

---

## Task 5: Detail-page split + stream + fallback

**Files:**
- Modify: `lib/explorer/fetchKeywordDetail.ts`
- Create: `app/(app)/explorer/keyword/[id]/WeeklyHistoryTable.tsx`
- Modify: `app/(app)/explorer/keyword/[id]/page.tsx`

- [ ] **Step 1: Split the loader.** Add `fetchKeywordChartData(id)` returning `{ searchTermRaw, searchTermNormalized, firstSeenWeek, lastSeenWeek, current, chartHistory, enrichedProductsByAsin }`, where `chartHistory` comes from `keyword_chart_series` via `seriesToHistoryRows(series, fits)`. **Fallback:** if no series row, run today's kwm 52-week read and map as before — so charts always work. Keep the search_terms / kcs-current / fits / enriched queries as they are (all fast). Add `fetchKeywordRawHistory(id)` = today's slow kwm 52-week read (the full `KeywordDetailHistoryRow[]` for the raw table).
- [ ] **Step 2: Create `WeeklyHistoryTable`** — an async server component: `const rows = await fetchKeywordRawHistory(id); return <RawDataTable rows={rows} />`.
- [ ] **Step 3: Wire `page.tsx`** — header + `RankChart`/`VolumeChart`/`FakeVolumeStrip`/`TitleMatchHistory` + `TopProductsTable` render from `fetchKeywordChartData`. Replace the inline raw table with:
```tsx
<section className="mt-8">
  <h2 className="text-sm font-semibold text-gray-700 mb-2">Weekly history</h2>
  <Suspense fallback={<HistoryTableSkeleton />}>
    <WeeklyHistoryTable id={id} />
  </Suspense>
</section>
```
  The `TopProductsTable` ASINs come from the existing current-week enriched query (not the 52-week history) — confirm slots 2/3 are available there; if the current code sources them from `history.find(currentWeek)`, fetch the current-week kwm row in `fetchKeywordChartData` (one targeted row, fast) instead.
- [ ] **Step 4: Per AGENTS.md, re-confirm the Suspense/streaming pattern** against `node_modules/next/dist/docs/01-app/01-getting-started/04-linking-and-navigating.md` (streaming) and `…/02-guides/streaming.md` before finalizing.
- [ ] **Step 5: Test** — a golden test asserting `seriesToHistoryRows`-derived chart rows match the kwm-fallback rows for a sample term (same rank/severity/flags/derived-volume per week). `pnpm typecheck` + `pnpm lint` the touched files.
- [ ] **Step 6: Commit**

```bash
git add lib/explorer/fetchKeywordDetail.ts "app/(app)/explorer/keyword/[id]/WeeklyHistoryTable.tsx" "app/(app)/explorer/keyword/[id]/page.tsx"
git commit -m "feat(detail): charts from chart-series; stream the weekly history table"
```

---

## Task 6: Verify (perf + correctness)

- [ ] **Step 1:** Extend/clone `scripts/diagDetailColdRepro.ts` to time a **series-backed** chart read (PK lookup on `keyword_chart_series`) for 3 cold keywords; confirm low single-digit seconds (vs ~60 s).
- [ ] **Step 2:** After deploy, load a real detail page: header + 4 charts appear immediately; the weekly-history table streams in behind its skeleton; volume trend is monotonic-with-rank (the fit-selection fix).
- [ ] **Step 3:** No commit (verification only). Report findings to the controller.

---

## Operational steps (controller-run, outside subagent tasks)

1. After Task 1 commits: **request user confirmation**, then apply migration 0036 to Neon (`pnpm db:migrate` or direct DDL).
2. After Task 3 commits + migration applied: run the **full backfill** off-peak (`pnpm tsx scripts/backfillChartSeries.ts`).
3. Task 4's maintenance then keeps it current on each weekly import.

---

## Self-Review

- **Spec coverage:** data model (Task 1), populate = backfill (Task 3) + refresh maintenance (Task 4), detail split + stream + fallback (Task 5), verify (Task 6). All spec sections mapped.
- **Type consistency:** `ChartSeriesEntry` defined in Task 1 is the single source used by Tasks 2–5; `seriesToHistoryRows` returns `KeywordDetailHistoryRow[]` (existing type the charts already consume).
- **Risk (newcomer churn):** Task 4's targeted-rebuild is the variable cost; it's fail-soft and off the user's critical path, and Task 6 measures it. If large, cap per-refresh and lean on the Task 5 fallback.
- **Safety:** every step additive; charts fall back to kwm whenever a series row is missing, so partial rollout (e.g., backfill mid-flight) is always correct. DDL applied only after explicit user confirmation.

## Execution Handoff

Recommended: **subagent-driven-development** — fresh implementer per task with spec-compliance + code-quality review between tasks (the same flow used for the movement-filter feature).
