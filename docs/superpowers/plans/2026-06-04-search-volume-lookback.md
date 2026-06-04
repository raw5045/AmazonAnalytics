# Search Volume Lookback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add estimated search-volume at the 4 existing lookback horizons (4w/13w/26w/52w-ago) to the explorer as filterable + sortable columns, and a per-week volume chart on the keyword detail page.

**Architecture:** The weekly `summary_refresh` already computes each keyword's rank 4/13/26/52 weeks ago (the `rank_Nw_ago` kcs columns, sourced from `rank_at_Nw` temp tables). We reuse those rank values: for each horizon, pick the calibration fit for that horizon's week and apply the existing piecewise rank→volume SQL — writing 4 new `bigint` columns into kcs in the same stage-and-swap. No 140M-row backfill; it re-runs every refresh. The detail page already computes per-week volume at fetch time; we add a chart component to render it.

**Tech Stack:** Next.js 16 (App Router) on Vercel, Drizzle ORM + Neon Postgres, node-postgres on the Railway worker, recharts, Vitest. Spec: `docs/superpowers/specs/2026-06-04-search-volume-lookback-design.md`.

---

## File Structure

**New files:**
- `db/migrations/0034_kcs_volume_lookback.sql` — adds 4 columns + 4 indexes to BOTH `keyword_current_summary` and `keyword_current_summary_stage`.
- `app/(app)/explorer/keyword/[id]/VolumeChart.tsx` — per-week volume line chart (mirrors `RankChart`, non-reversed axis, green line, extrapolated dots distinct).
- `app/(app)/explorer/keyword/[id]/VolumeChart.test.tsx` — component render test.

**Test additions (these files already exist — APPEND, reuse their imports/helpers):**
- `lib/analytics/volumeModel.test.ts` — `weeksBeforeIso`, `buildPiecewiseSql`, `buildVolumeExpressions`.
- `lib/explorer/parseFilters.test.ts` — parsing the new `vol_Nw_min/max` params.
- `lib/explorer/buildQuery.test.ts` — the new WHERE / ORDER BY emission (reuse its `norm` helper).

**Modified files:**
- `db/schema/keywordCurrentSummary.ts` — +4 columns, +4 indexes.
- `lib/analytics/volumeModel.ts` — receive `buildPiecewiseSql` (moved here, exported), add `weeksBeforeIso` + `buildVolumeExpressions`.
- `inngest/functions/refreshSummary.ts` — call `buildVolumeExpressions`; add 4 columns to the stage INSERT; thread params.
- `lib/explorer/types.ts` — `SortKey` (+8), `ExplorerFilters` (+8 fields), `ExplorerRow` (+4 fields).
- `lib/explorer/parseFilters.ts` — `EXPLORER_DEFAULTS` (+8), `SORT_VALUES` (+8), parse (+8).
- `lib/explorer/buildQuery.ts` — WHERE (+8), SELECT (+4), `buildOrderBy` (+8 cases).
- `lib/explorer/runQuery.ts` — `RawRow` (+4), mapper (+4), `canUse*` count guards (+ volume null-checks).
- `app/(app)/explorer/FilterSidebar.tsx` — `PendingFilters` (+8), `filtersToPending` (+8), `pendingToParams` (+8), `SORTS` (+8), 4 new min/max `FieldGroup`s.
- `app/(app)/explorer/ResultsTable.tsx` — +4 sortable headers, +4 cells (reuse `formatVolume`).
- `app/(app)/explorer/page.tsx` — `filtersAreCustomized` (+ volume null-checks).
- `lib/savedViews/validation.ts` — `filtersToSearchParams` (+8 lines).
- `lib/savedViews/loadServer.ts` — `normalizeFiltersBlob` (+8 lines).

**Naming (use exactly, everywhere):** columns `estimated_monthly_volume_4w_ago`, `_13w_ago`, `_26w_ago`, `_52w_ago`; drizzle `estimatedMonthlyVolume4wAgo`/`13wAgo`/`26wAgo`/`52wAgo`; filter fields `volume4wAgoMin`/`Max`, `volume13wAgoMin`/`Max`, `volume26wAgoMin`/`Max`, `volume52wAgoMin`/`Max`; URL params `vol_4w_min`/`vol_4w_max`, `vol_13w_*`, `vol_26w_*`, `vol_52w_*`; sort keys `vol_4w_asc`/`vol_4w_desc`, `vol_13w_*`, `vol_26w_*`, `vol_52w_*`.

---

## Phase 1 — Schema + migration

### Task 1.1: Add 4 columns + 4 indexes to the kcs drizzle schema

**Files:**
- Modify: `db/schema/keywordCurrentSummary.ts`

- [ ] **Step 1: Add the columns.** After line 88 (`estimatedMonthlyVolumeCurrent: bigint('estimated_monthly_volume_current', { mode: 'number' }),`), add:

```ts
    // Lookback estimated monthly volume at the same horizons kcs stores
    // ranks (computed in refreshSummary from rank_Nw_ago + the fit for
    // that horizon's week). NULL when no fit exists or rank is NULL.
    estimatedMonthlyVolume4wAgo: bigint('estimated_monthly_volume_4w_ago', { mode: 'number' }),
    estimatedMonthlyVolume13wAgo: bigint('estimated_monthly_volume_13w_ago', { mode: 'number' }),
    estimatedMonthlyVolume26wAgo: bigint('estimated_monthly_volume_26w_ago', { mode: 'number' }),
    estimatedMonthlyVolume52wAgo: bigint('estimated_monthly_volume_52w_ago', { mode: 'number' }),
```

- [ ] **Step 2: Add the indexes.** In the index builder, after line 125 (`estVolIdx: index('kcs_est_vol_idx')...`), add:

```ts
    estVol4wIdx: index('kcs_est_vol_4w_idx').on(t.currentWeekEndDate, t.estimatedMonthlyVolume4wAgo),
    estVol13wIdx: index('kcs_est_vol_13w_idx').on(t.currentWeekEndDate, t.estimatedMonthlyVolume13wAgo),
    estVol26wIdx: index('kcs_est_vol_26w_idx').on(t.currentWeekEndDate, t.estimatedMonthlyVolume26wAgo),
    estVol52wIdx: index('kcs_est_vol_52w_idx').on(t.currentWeekEndDate, t.estimatedMonthlyVolume52wAgo),
```

- [ ] **Step 3: Typecheck.** Run: `npm run typecheck` — Expected: PASS (drizzle types updated; nothing consumes the new columns yet).

- [ ] **Step 4: Commit.**

```bash
git add db/schema/keywordCurrentSummary.ts
git commit -m "feat(volume): add kcs lookback-volume columns + indexes to schema

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 1.2: Migration SQL (apply to Neon)

**Files:**
- Create: `db/migrations/0034_kcs_volume_lookback.sql`

> **Why both tables:** `refreshSummary` builds into `keyword_current_summary_stage` then RENAME-swaps it with the live table (migration 0012). Both tables must have identical structure or the stage INSERT (Phase 2) fails. The migration alters BOTH.

- [ ] **Step 1: Write the migration.** Create `db/migrations/0034_kcs_volume_lookback.sql`:

```sql
-- 0034: estimated-volume lookback columns on keyword_current_summary.
-- Mirrors the rank_Nw_ago horizons; populated by refreshSummary.
-- Both the live table and the stage table (migration 0012) must match.

ALTER TABLE keyword_current_summary
  ADD COLUMN IF NOT EXISTS estimated_monthly_volume_4w_ago  bigint,
  ADD COLUMN IF NOT EXISTS estimated_monthly_volume_13w_ago bigint,
  ADD COLUMN IF NOT EXISTS estimated_monthly_volume_26w_ago bigint,
  ADD COLUMN IF NOT EXISTS estimated_monthly_volume_52w_ago bigint;

ALTER TABLE keyword_current_summary_stage
  ADD COLUMN IF NOT EXISTS estimated_monthly_volume_4w_ago  bigint,
  ADD COLUMN IF NOT EXISTS estimated_monthly_volume_13w_ago bigint,
  ADD COLUMN IF NOT EXISTS estimated_monthly_volume_26w_ago bigint,
  ADD COLUMN IF NOT EXISTS estimated_monthly_volume_52w_ago bigint;

CREATE INDEX IF NOT EXISTS kcs_est_vol_4w_idx  ON keyword_current_summary (current_week_end_date, estimated_monthly_volume_4w_ago);
CREATE INDEX IF NOT EXISTS kcs_est_vol_13w_idx ON keyword_current_summary (current_week_end_date, estimated_monthly_volume_13w_ago);
CREATE INDEX IF NOT EXISTS kcs_est_vol_26w_idx ON keyword_current_summary (current_week_end_date, estimated_monthly_volume_26w_ago);
CREATE INDEX IF NOT EXISTS kcs_est_vol_52w_idx ON keyword_current_summary (current_week_end_date, estimated_monthly_volume_52w_ago);
```

- [ ] **Step 2: PAUSE — get user confirmation before applying.** The drizzle journal is stale; `npm run db:migrate` no-ops new migrations. This project applies migrations directly to Neon. **Do not apply without explicit user OK** (matches the migration-0033 handling). Ask the user: "Apply migration 0034 directly to Neon now?" When confirmed, apply via a throwaway script (transaction + verify, then delete it) or `psql`. Verify with:

```sql
SELECT column_name FROM information_schema.columns
 WHERE table_name = 'keyword_current_summary' AND column_name LIKE 'estimated_monthly_volume_%w_ago'
 ORDER BY column_name;
-- Expect 4 rows: _13w_ago, _26w_ago, _4w_ago, _52w_ago
```

- [ ] **Step 3: Commit the migration file.**

```bash
git add db/migrations/0034_kcs_volume_lookback.sql
git commit -m "feat(volume): migration 0034 — kcs lookback-volume columns + indexes (live + stage)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Phase 2 — Refresh computation (the core logic)

### Task 2.1: Move `buildPiecewiseSql` into volumeModel.ts + add `weeksBeforeIso` (TDD)

**Files:**
- Modify: `lib/analytics/volumeModel.ts` (add `buildPiecewiseSql`, `weeksBeforeIso`)
- Modify: `inngest/functions/refreshSummary.ts` (remove local `buildPiecewiseSql`, import from volumeModel)
- Test: `lib/analytics/volumeModel.test.ts`

> **Why move it:** `buildPiecewiseSql` is a pure (SQL-string + params) function. Moving it next to the other volume-model pure functions lets us unit-test it and the new horizon builder. It currently lives at `inngest/functions/refreshSummary.ts:598-640` and is called once at line 130.

- [ ] **Step 1: Write the failing test.** `lib/analytics/volumeModel.test.ts` already exists — **append** these `describe` blocks (add the new symbols to the existing `./volumeModel` import):

```ts
import {
  weeksBeforeIso,
  buildPiecewiseSql,
  type FitParams,
} from './volumeModel';

describe('weeksBeforeIso', () => {
  it('subtracts whole weeks (UTC, no tz drift)', () => {
    expect(weeksBeforeIso('2026-05-30', 4)).toBe('2026-05-02');
    expect(weeksBeforeIso('2026-05-30', 13)).toBe('2026-02-28');
    expect(weeksBeforeIso('2026-05-30', 52)).toBe('2025-05-31');
  });
  it('throws on bad format', () => {
    expect(() => weeksBeforeIso('2026/05/30', 4)).toThrow();
  });
});

describe('buildPiecewiseSql', () => {
  const single: FitParams = {
    calibrationMonthEndDate: '2026-04-30', fittedAt: '2026-05-21',
    beta: 0.5, scaleFactor: 1000, breakpoints: [], segments: [{ beta: 0.5, scaleFactor: 1000 }],
  };
  it('single segment uses two sequential params from startParamIdx', () => {
    const { sql, params } = buildPiecewiseSql(single, 'l.actual_rank', 2);
    expect(sql).toBe('($3::numeric * power(l.actual_rank::numeric, -$2::numeric))::bigint');
    expect(params).toEqual(['0.500000', '1000.000000']);
  });
  it('piecewise chains breakpoint+beta+scale params', () => {
    const pw: FitParams = {
      calibrationMonthEndDate: '2026-04-30', fittedAt: '2026-05-21',
      beta: 0.4, scaleFactor: 2000, breakpoints: [1000],
      segments: [{ beta: 0.4, scaleFactor: 2000 }, { beta: 0.6, scaleFactor: 3000 }],
    };
    const { sql, params } = buildPiecewiseSql(pw, 'r4.actual_rank', 5);
    // seg0: $5=bp, $6=beta, $7=scale ; seg1(last): $8=beta, $9=scale
    expect(sql).toContain('WHEN r4.actual_rank <= $5::int');
    expect(sql).toContain('$7::numeric * power(r4.actual_rank::numeric, -$6::numeric)');
    expect(sql).toContain('ELSE ($9::numeric * power(r4.actual_rank::numeric, -$8::numeric))');
    expect(params).toEqual([1000, '0.400000', '2000.000000', '0.600000', '3000.000000']);
  });
});
```

- [ ] **Step 2: Run — verify it fails.** Run: `npx vitest run lib/analytics/volumeModel.test.ts` — Expected: FAIL (`weeksBeforeIso`, `buildPiecewiseSql` not exported from volumeModel).

- [ ] **Step 3: Implement.** In `lib/analytics/volumeModel.ts`, append:

```ts
/** Subtract whole weeks from a YYYY-MM-DD date (UTC). */
export function weeksBeforeIso(yyyyMmDd: string, weeks: number): string {
  const m = yyyyMmDd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`Invalid date format: ${yyyyMmDd}`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  d.setUTCDate(d.getUTCDate() - weeks * 7);
  return d.toISOString().slice(0, 10);
}

/**
 * Build a SQL expression (+ bound params) mapping a rank column to
 * estimated volume for the given fit. Params are positional starting
 * at `startParamIdx`. Moved here from refreshSummary so it's unit-
 * testable. Returns `NULL::bigint` with no params for an empty fit.
 */
export function buildPiecewiseSql(
  fit: PiecewiseFit,
  rankCol: string,
  startParamIdx: number,
): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  let nextIdx = startParamIdx;
  if (fit.segments.length === 0) {
    return { sql: 'NULL::bigint', params: [] };
  }
  if (fit.segments.length === 1) {
    const s = fit.segments[0];
    params.push(s.beta.toFixed(6), s.scaleFactor.toFixed(6));
    const bIdx = nextIdx++;
    const aIdx = nextIdx++;
    return {
      sql: `($${aIdx}::numeric * power(${rankCol}::numeric, -$${bIdx}::numeric))::bigint`,
      params,
    };
  }
  const whenClauses: string[] = [];
  for (let i = 0; i < fit.segments.length - 1; i++) {
    const seg = fit.segments[i];
    const bp = fit.breakpoints[i];
    params.push(bp, seg.beta.toFixed(6), seg.scaleFactor.toFixed(6));
    const bpIdx = nextIdx++;
    const bIdx = nextIdx++;
    const aIdx = nextIdx++;
    whenClauses.push(
      `WHEN ${rankCol} <= $${bpIdx}::int THEN ($${aIdx}::numeric * power(${rankCol}::numeric, -$${bIdx}::numeric))::bigint`,
    );
  }
  const last = fit.segments[fit.segments.length - 1];
  params.push(last.beta.toFixed(6), last.scaleFactor.toFixed(6));
  const lastBIdx = nextIdx++;
  const lastAIdx = nextIdx++;
  const elseClause = `ELSE ($${lastAIdx}::numeric * power(${rankCol}::numeric, -$${lastBIdx}::numeric))::bigint`;
  return { sql: `CASE ${whenClauses.join(' ')} ${elseClause} END`, params };
}
```

- [ ] **Step 4: Remove the local copy from refreshSummary.** In `inngest/functions/refreshSummary.ts`, delete the `function buildPiecewiseSql(...)` definition (lines 598-640). Add `buildPiecewiseSql` and `weeksBeforeIso` to the existing import from `@/lib/analytics/volumeModel` (the file already imports `pickFitForWeek`).

- [ ] **Step 5: Run tests + typecheck.** Run: `npx vitest run lib/analytics/volumeModel.test.ts` — Expected: PASS. Run: `npm run typecheck` — Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add lib/analytics/volumeModel.ts lib/analytics/volumeModel.test.ts inngest/functions/refreshSummary.ts
git commit -m "refactor(volume): move buildPiecewiseSql to volumeModel + add weeksBeforeIso

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 2.2: `buildVolumeExpressions` helper (TDD)

**Files:**
- Modify: `lib/analytics/volumeModel.ts`
- Test: `lib/analytics/volumeModel.test.ts`

- [ ] **Step 1: Write the failing test.** Add to `lib/analytics/volumeModel.test.ts`:

```ts
import { buildVolumeExpressions } from './volumeModel';

describe('buildVolumeExpressions', () => {
  const fit: FitParams = {
    calibrationMonthEndDate: '2026-04-30', fittedAt: '2026-05-21',
    beta: 0.5, scaleFactor: 1000, breakpoints: [], segments: [{ beta: 0.5, scaleFactor: 1000 }],
  };
  const horizons = [
    { weeks: 0, rankCol: 'l.actual_rank' },
    { weeks: 4, rankCol: 'r4.actual_rank' },
  ];
  it('produces one expr per horizon with chained param indices', () => {
    const { exprs, params } = buildVolumeExpressions('2026-05-30', [fit], horizons, 2);
    expect(exprs).toHaveLength(2);
    // current: $2/$3 on l.actual_rank ; 4w: $4/$5 on r4.actual_rank
    expect(exprs[0]).toBe('($3::numeric * power(l.actual_rank::numeric, -$2::numeric))::bigint');
    expect(exprs[1]).toBe('($5::numeric * power(r4.actual_rank::numeric, -$4::numeric))::bigint');
    expect(params).toEqual(['0.500000', '1000.000000', '0.500000', '1000.000000']);
  });
  it('emits NULL::bigint (no params) when no fits exist', () => {
    const { exprs, params } = buildVolumeExpressions('2026-05-30', [], horizons, 2);
    expect(exprs).toEqual(['NULL::bigint', 'NULL::bigint']);
    expect(params).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — verify it fails.** Run: `npx vitest run lib/analytics/volumeModel.test.ts -t buildVolumeExpressions` — Expected: FAIL (not exported).

- [ ] **Step 3: Implement.** Append to `lib/analytics/volumeModel.ts`:

```ts
/**
 * Build the current-week + lookback volume SQL expressions for the kcs
 * refresh. For each horizon, pick the fit for that horizon's week
 * (weeks=0 means the current week) and emit the piecewise SQL applied
 * to that horizon's rank column. Positional params chain across all
 * horizons starting at `startParamIdx`. Pure — unit tested.
 */
export function buildVolumeExpressions(
  currentWeekEndDate: string,
  fits: ReadonlyArray<FitParams>,
  horizons: ReadonlyArray<{ weeks: number; rankCol: string }>,
  startParamIdx: number,
): { exprs: string[]; params: unknown[] } {
  const exprs: string[] = [];
  const params: unknown[] = [];
  let idx = startParamIdx;
  for (const h of horizons) {
    const week = h.weeks === 0 ? currentWeekEndDate : weeksBeforeIso(currentWeekEndDate, h.weeks);
    const sel = pickFitForWeek(week, fits);
    if (!sel) {
      exprs.push('NULL::bigint');
      continue;
    }
    const pw = buildPiecewiseSql(sel.fit, h.rankCol, idx);
    exprs.push(pw.sql);
    params.push(...pw.params);
    idx += pw.params.length;
  }
  return { exprs, params };
}
```

- [ ] **Step 4: Run tests.** Run: `npx vitest run lib/analytics/volumeModel.test.ts` — Expected: PASS (all volume-model tests).

- [ ] **Step 5: Commit.**

```bash
git add lib/analytics/volumeModel.ts lib/analytics/volumeModel.test.ts
git commit -m "feat(volume): buildVolumeExpressions — current + lookback volume SQL

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 2.3: Wire the 4 columns into refreshSummary

**Files:**
- Modify: `inngest/functions/refreshSummary.ts`

- [ ] **Step 1: Replace the current-week-only volume build.** Replace lines 126-131 (the `piecewiseSql = volumeSelection ? buildPiecewiseSql(...) : null` block) with:

```ts
    // Build the current-week + 4 lookback volume expressions in one pass.
    // Param indices start at $2 ($1 is currentWeekEndDate). rankCol aliases
    // mirror the LEFT JOINs in the INSERT below (l = latest_per_term,
    // rN = rank_at_Nw).
    const VOLUME_HORIZONS = [
      { weeks: 0, rankCol: 'l.actual_rank' },
      { weeks: 4, rankCol: 'r4.actual_rank' },
      { weeks: 13, rankCol: 'r13.actual_rank' },
      { weeks: 26, rankCol: 'r26.actual_rank' },
      { weeks: 52, rankCol: 'r52.actual_rank' },
    ] as const;
    const volume = buildVolumeExpressions(currentWeekEndDate, fits, VOLUME_HORIZONS, 2);
    // volume.exprs[0]=current, [1]=4w, [2]=13w, [3]=26w, [4]=52w
```

> Keep the `volumeSelection` / `chosenFitRunId` / `chosenIsExtrapolated` lines (116-124) — they still feed `keyword_current_summary_meta`. Only the `piecewiseSql` block is replaced.

- [ ] **Step 2: Add `buildVolumeExpressions` to the volumeModel import** at the top of `refreshSummary.ts`.

- [ ] **Step 3: Add the 4 columns to the INSERT column list.** In the INSERT (after `estimated_monthly_volume_current,` at line 213), add:

```
        estimated_monthly_volume_4w_ago, estimated_monthly_volume_13w_ago,
        estimated_monthly_volume_26w_ago, estimated_monthly_volume_52w_ago,
```

- [ ] **Step 4: Replace the SELECT volume expression.** Replace the `${volumeExpression} AS estimated_monthly_volume_current,` line (268) with:

```
        ${volume.exprs[0]} AS estimated_monthly_volume_current,
        ${volume.exprs[1]} AS estimated_monthly_volume_4w_ago,
        ${volume.exprs[2]} AS estimated_monthly_volume_13w_ago,
        ${volume.exprs[3]} AS estimated_monthly_volume_26w_ago,
        ${volume.exprs[4]} AS estimated_monthly_volume_52w_ago,
```

- [ ] **Step 5: Thread the params.** Change the INSERT param array (line 300) from `[currentWeekEndDate, ...volumeParams]` to:

```ts
      [currentWeekEndDate, ...volume.params],
```

(Delete the now-unused `volumeExpression` / `volumeParams` locals at lines 192-193.)

- [ ] **Step 6: Typecheck.** Run: `npm run typecheck` — Expected: PASS.

- [ ] **Step 7: Worker-boot smoke check.** refreshSummary runs on the Railway worker. Run: `npm run worker:check` — Expected: `worker-boot check OK — N Inngest function(s) import cleanly`. (Catches any import-time breakage before deploy.)

- [ ] **Step 8: Commit.**

```bash
git add inngest/functions/refreshSummary.ts
git commit -m "feat(volume): populate kcs lookback-volume columns in refresh

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Phase 3 — Explorer filter + sort wiring

### Task 3.1: Types — SortKey, ExplorerFilters, ExplorerRow

**Files:**
- Modify: `lib/explorer/types.ts`

- [ ] **Step 1: Extend `SortKey`.** Replace the `SortKey` union (lines 10-16) — add the 8 volume keys before the closing `;`:

```ts
export type SortKey =
  | 'rank' | 'rank_desc'
  | 'imp' | 'decline'
  | 'title_gap'
  | 'avg_price_asc' | 'avg_price_desc'
  | 'avg_reviews_asc' | 'avg_reviews_desc'
  | 'vol_4w_asc' | 'vol_4w_desc'
  | 'vol_13w_asc' | 'vol_13w_desc'
  | 'vol_26w_asc' | 'vol_26w_desc'
  | 'vol_52w_asc' | 'vol_52w_desc'
  | 'added_asc' | 'added_desc';
```

- [ ] **Step 2: Add filter fields.** In `ExplorerFilters`, after `rankMax: number | null;` (line 53), add:

```ts
  volume4wAgoMin: number | null;
  volume4wAgoMax: number | null;
  volume13wAgoMin: number | null;
  volume13wAgoMax: number | null;
  volume26wAgoMin: number | null;
  volume26wAgoMax: number | null;
  volume52wAgoMin: number | null;
  volume52wAgoMax: number | null;
```

- [ ] **Step 3: Add row fields.** In `ExplorerRow`, after `estimatedMonthlyVolumeCurrent: number | null;` (line 109), add:

```ts
  estimatedMonthlyVolume4wAgo: number | null;
  estimatedMonthlyVolume13wAgo: number | null;
  estimatedMonthlyVolume26wAgo: number | null;
  estimatedMonthlyVolume52wAgo: number | null;
```

- [ ] **Step 4: Typecheck (expect ERRORS — this is the tripwire).** Run: `npm run typecheck` — Expected: FAIL with errors in `parseFilters.ts` (EXPLORER_DEFAULTS missing fields), `buildQuery.ts` (buildOrderBy non-exhaustive switch), `runQuery.ts` (mapper missing fields), `loadServer.ts` (object literal missing fields). These are resolved by the next tasks. Do NOT commit yet — proceed to 3.2.

### Task 3.2: parseFilters — defaults, SORT_VALUES, parse (TDD)

**Files:**
- Modify: `lib/explorer/parseFilters.ts`
- Test: `lib/explorer/parseFilters.test.ts`

- [ ] **Step 1: Write the failing test.** `lib/explorer/parseFilters.test.ts` already exists — **append** this `describe` block (it already imports `parseExplorerFilters`):

```ts
describe('parseExplorerFilters — volume lookback', () => {
  it('parses vol_Nw_min / vol_Nw_max', () => {
    const f = parseExplorerFilters({ vol_4w_min: '500', vol_13w_max: '20000' });
    expect(f.volume4wAgoMin).toBe(500);
    expect(f.volume4wAgoMax).toBeNull();
    expect(f.volume13wAgoMax).toBe(20000);
  });
  it('accepts the new sort keys', () => {
    expect(parseExplorerFilters({ sort: 'vol_26w_desc' }).sort).toBe('vol_26w_desc');
  });
  it('rejects unknown sort, falls back to default', () => {
    expect(parseExplorerFilters({ sort: 'nope' }).sort).toBe('rank');
  });
});
```

- [ ] **Step 2: Run — verify it fails.** Run: `npx vitest run lib/explorer/parseFilters.test.ts` — Expected: FAIL.

- [ ] **Step 3: Add defaults.** In `EXPLORER_DEFAULTS`, after `rankMax: null,` (line 24), add the 8 fields:

```ts
  volume4wAgoMin: null,
  volume4wAgoMax: null,
  volume13wAgoMin: null,
  volume13wAgoMax: null,
  volume26wAgoMin: null,
  volume26wAgoMax: null,
  volume52wAgoMin: null,
  volume52wAgoMax: null,
```

- [ ] **Step 4: Add sort values.** In `SORT_VALUES` (lines 42-49), add the 8 keys (after `'avg_reviews_desc',`):

```ts
  'vol_4w_asc', 'vol_4w_desc',
  'vol_13w_asc', 'vol_13w_desc',
  'vol_26w_asc', 'vol_26w_desc',
  'vol_52w_asc', 'vol_52w_desc',
```

- [ ] **Step 5: Parse the params.** Near line 128 (after `const rankMax = parsePositiveInt(...)`), add:

```ts
  const volume4wAgoMin = parsePositiveInt(getOne(searchParams.vol_4w_min));
  const volume4wAgoMax = parsePositiveInt(getOne(searchParams.vol_4w_max));
  const volume13wAgoMin = parsePositiveInt(getOne(searchParams.vol_13w_min));
  const volume13wAgoMax = parsePositiveInt(getOne(searchParams.vol_13w_max));
  const volume26wAgoMin = parsePositiveInt(getOne(searchParams.vol_26w_min));
  const volume26wAgoMax = parsePositiveInt(getOne(searchParams.vol_26w_max));
  const volume52wAgoMin = parsePositiveInt(getOne(searchParams.vol_52w_min));
  const volume52wAgoMax = parsePositiveInt(getOne(searchParams.vol_52w_max));
```

And in the returned object (near line 142, after `rankMax,`):

```ts
    volume4wAgoMin, volume4wAgoMax,
    volume13wAgoMin, volume13wAgoMax,
    volume26wAgoMin, volume26wAgoMax,
    volume52wAgoMin, volume52wAgoMax,
```

- [ ] **Step 6: Run tests.** Run: `npx vitest run lib/explorer/parseFilters.test.ts` — Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add lib/explorer/types.ts lib/explorer/parseFilters.ts lib/explorer/parseFilters.test.ts
git commit -m "feat(volume): explorer filter types + URL parsing for lookback volume

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 3.3: buildQuery — WHERE, SELECT, ORDER BY (TDD)

**Files:**
- Modify: `lib/explorer/buildQuery.ts`
- Test: `lib/explorer/buildQuery.test.ts`

- [ ] **Step 1: Write the failing test.** `lib/explorer/buildQuery.test.ts` already exists and imports `buildExplorerQuery` + `EXPLORER_DEFAULTS` and defines `const norm = (s) => s.replace(/\s+/g, ' ').trim();`. **Append** this `describe` block (reusing the existing `norm` helper + imports):

```ts
describe('buildExplorerQuery — volume lookback', () => {
  it('emits a WHERE for a volume min filter', () => {
    const { sql } = buildExplorerQuery({ ...EXPLORER_DEFAULTS, volume4wAgoMin: 1000 });
    expect(norm(sql)).toContain('kcs.estimated_monthly_volume_4w_ago >=');
  });
  it('selects the lookback volume columns', () => {
    const { sql } = buildExplorerQuery({ ...EXPLORER_DEFAULTS });
    expect(norm(sql)).toContain('kcs.estimated_monthly_volume_52w_ago');
  });
  it('orders by a volume sort key', () => {
    const { sql } = buildExplorerQuery({ ...EXPLORER_DEFAULTS, sort: 'vol_13w_desc' });
    expect(norm(sql)).toContain('ORDER BY kcs.estimated_monthly_volume_13w_ago DESC NULLS LAST');
  });
});
```

> Confirmed signature: `buildExplorerQuery(filters: ExplorerFilters, currentWeekEndDate?: string): BuiltExplorerQuery` → `{ sql, args, countSql, countArgs }`.

- [ ] **Step 2: Run — verify it fails.** Run: `npx vitest run lib/explorer/buildQuery.test.ts` — Expected: FAIL.

- [ ] **Step 3: Add WHERE blocks.** After the `rankMax` block (line 104), add:

```ts
  // 1.3b — lookback volume min/max (one pair per horizon)
  const volCols: Array<[number | null, number | null, string]> = [
    [filters.volume4wAgoMin, filters.volume4wAgoMax, 'estimated_monthly_volume_4w_ago'],
    [filters.volume13wAgoMin, filters.volume13wAgoMax, 'estimated_monthly_volume_13w_ago'],
    [filters.volume26wAgoMin, filters.volume26wAgoMax, 'estimated_monthly_volume_26w_ago'],
    [filters.volume52wAgoMin, filters.volume52wAgoMax, 'estimated_monthly_volume_52w_ago'],
  ];
  for (const [min, max, col] of volCols) {
    if (min !== null) where.push(`kcs.${col} >= ${next(min)}`);
    if (max !== null) where.push(`kcs.${col} <= ${next(max)}`);
  }
```

- [ ] **Step 4: Add to the SELECT list.** After `kcs.estimated_monthly_volume_current,` (line 190), add:

```
      kcs.estimated_monthly_volume_4w_ago,
      kcs.estimated_monthly_volume_13w_ago,
      kcs.estimated_monthly_volume_26w_ago,
      kcs.estimated_monthly_volume_52w_ago,
```

- [ ] **Step 5: Add ORDER BY cases.** In `buildOrderBy`, before the `added_asc:` case (line 268), add:

```ts
    case 'vol_4w_asc':  return 'ORDER BY kcs.estimated_monthly_volume_4w_ago ASC NULLS LAST';
    case 'vol_4w_desc': return 'ORDER BY kcs.estimated_monthly_volume_4w_ago DESC NULLS LAST';
    case 'vol_13w_asc':  return 'ORDER BY kcs.estimated_monthly_volume_13w_ago ASC NULLS LAST';
    case 'vol_13w_desc': return 'ORDER BY kcs.estimated_monthly_volume_13w_ago DESC NULLS LAST';
    case 'vol_26w_asc':  return 'ORDER BY kcs.estimated_monthly_volume_26w_ago ASC NULLS LAST';
    case 'vol_26w_desc': return 'ORDER BY kcs.estimated_monthly_volume_26w_ago DESC NULLS LAST';
    case 'vol_52w_asc':  return 'ORDER BY kcs.estimated_monthly_volume_52w_ago ASC NULLS LAST';
    case 'vol_52w_desc': return 'ORDER BY kcs.estimated_monthly_volume_52w_ago DESC NULLS LAST';
```

- [ ] **Step 6: Run tests.** Run: `npx vitest run lib/explorer/buildQuery.test.ts` — Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add lib/explorer/buildQuery.ts lib/explorer/buildQuery.test.ts
git commit -m "feat(volume): explorer WHERE/SELECT/ORDER BY for lookback volume

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 3.4: runQuery — raw row, mapper, count guards

**Files:**
- Modify: `lib/explorer/runQuery.ts`

- [ ] **Step 1: Add to `RawRow`.** After `estimated_monthly_volume_current: string | number | null;` (line 85), add:

```ts
  estimated_monthly_volume_4w_ago: string | number | null;
  estimated_monthly_volume_13w_ago: string | number | null;
  estimated_monthly_volume_26w_ago: string | number | null;
  estimated_monthly_volume_52w_ago: string | number | null;
```

- [ ] **Step 2: Map the rows.** After `estimatedMonthlyVolumeCurrent: parseBigint(r.estimated_monthly_volume_current),` (line 291), add:

```ts
    estimatedMonthlyVolume4wAgo: parseBigint(r.estimated_monthly_volume_4w_ago),
    estimatedMonthlyVolume13wAgo: parseBigint(r.estimated_monthly_volume_13w_ago),
    estimatedMonthlyVolume26wAgo: parseBigint(r.estimated_monthly_volume_26w_ago),
    estimatedMonthlyVolume52wAgo: parseBigint(r.estimated_monthly_volume_52w_ago),
```

- [ ] **Step 3: Guard the precomputed-count short-circuits.** In each of `canUseDefaultTotal` (line 120), `canUseCategoryFacet` (~138), `canUseLeafCategoryFacet` (~157), add to the boolean chain (so a volume filter forces a live COUNT):

```ts
    && f.volume4wAgoMin === null && f.volume4wAgoMax === null
    && f.volume13wAgoMin === null && f.volume13wAgoMax === null
    && f.volume26wAgoMin === null && f.volume26wAgoMax === null
    && f.volume52wAgoMin === null && f.volume52wAgoMax === null
```

- [ ] **Step 4: Typecheck.** Run: `npm run typecheck` — Expected: PASS (mapper now satisfies `ExplorerRow`). 

- [ ] **Step 5: Commit.**

```bash
git add lib/explorer/runQuery.ts
git commit -m "feat(volume): map lookback-volume columns + count-guard in runQuery

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 3.5: FilterSidebar — pending state, serialization, inputs, sort options

**Files:**
- Modify: `app/(app)/explorer/FilterSidebar.tsx`

- [ ] **Step 1: Extend `PendingFilters`.** After `rankWorst: string;` (line 61), add 8 string fields:

```ts
  volume4wAgoMin: string; volume4wAgoMax: string;
  volume13wAgoMin: string; volume13wAgoMax: string;
  volume26wAgoMin: string; volume26wAgoMax: string;
  volume52wAgoMin: string; volume52wAgoMax: string;
```

- [ ] **Step 2: Map filters → pending.** In `filtersToPending`, after the `rankWorst:` line (81), add:

```ts
    volume4wAgoMin: f.volume4wAgoMin?.toString() ?? '',
    volume4wAgoMax: f.volume4wAgoMax?.toString() ?? '',
    volume13wAgoMin: f.volume13wAgoMin?.toString() ?? '',
    volume13wAgoMax: f.volume13wAgoMax?.toString() ?? '',
    volume26wAgoMin: f.volume26wAgoMin?.toString() ?? '',
    volume26wAgoMax: f.volume26wAgoMax?.toString() ?? '',
    volume52wAgoMin: f.volume52wAgoMin?.toString() ?? '',
    volume52wAgoMax: f.volume52wAgoMax?.toString() ?? '',
```

- [ ] **Step 3: Serialize pending → URL params.** In `pendingToParams`, after the `rank_max` line (101), add:

```ts
  if (p.volume4wAgoMin) params.set('vol_4w_min', p.volume4wAgoMin);
  if (p.volume4wAgoMax) params.set('vol_4w_max', p.volume4wAgoMax);
  if (p.volume13wAgoMin) params.set('vol_13w_min', p.volume13wAgoMin);
  if (p.volume13wAgoMax) params.set('vol_13w_max', p.volume13wAgoMax);
  if (p.volume26wAgoMin) params.set('vol_26w_min', p.volume26wAgoMin);
  if (p.volume26wAgoMax) params.set('vol_26w_max', p.volume26wAgoMax);
  if (p.volume52wAgoMin) params.set('vol_52w_min', p.volume52wAgoMin);
  if (p.volume52wAgoMax) params.set('vol_52w_max', p.volume52wAgoMax);
```

- [ ] **Step 4: Add the input UI.** After the Rank-range `FieldGroup` (line 265), add (one block; renders all 4 horizons):

```tsx
      {([
        ['4w', 'volume4wAgoMin', 'volume4wAgoMax'],
        ['13w', 'volume13wAgoMin', 'volume13wAgoMax'],
        ['26w', 'volume26wAgoMin', 'volume26wAgoMax'],
        ['52w', 'volume52wAgoMin', 'volume52wAgoMax'],
      ] as const).map(([label, minKey, maxKey]) => (
        <FieldGroup key={minKey} label={`Est. volume ${label} ago`}>
          <div className="flex gap-2">
            <input
              type="number" min={1}
              value={pending[minKey]}
              onChange={(e) => set(minKey, e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && apply()}
              placeholder="Min"
              className="filter-input flex-1"
              aria-label={`Min est. volume ${label} ago`}
            />
            <input
              type="number" min={1}
              value={pending[maxKey]}
              onChange={(e) => set(maxKey, e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && apply()}
              placeholder="Max"
              className="filter-input flex-1"
              aria-label={`Max est. volume ${label} ago`}
            />
          </div>
          <p className="text-xs text-gray-500 mt-1">Estimated monthly searches {label} ago (directional, ±~30%).</p>
        </FieldGroup>
      ))}
```

> `set(minKey, ...)` must accept the new keys — `set` is typed `(key: keyof PendingFilters, value: string) => void`; Step 1 made the keys valid. If `set` is narrower, widen it to `keyof PendingFilters`.

- [ ] **Step 5: Add sort options.** In `SORTS` (line 49), add before the closing `]`:

```ts
  { value: 'vol_4w_desc', label: 'Highest volume 4w ago' },
  { value: 'vol_13w_desc', label: 'Highest volume 13w ago' },
  { value: 'vol_26w_desc', label: 'Highest volume 26w ago' },
  { value: 'vol_52w_desc', label: 'Highest volume 52w ago' },
```

- [ ] **Step 6: Typecheck + commit.** Run: `npm run typecheck` — Expected: PASS.

```bash
git add "app/(app)/explorer/FilterSidebar.tsx"
git commit -m "feat(volume): lookback-volume filter inputs + sort options in sidebar

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 3.6: ResultsTable — sortable headers + cells

**Files:**
- Modify: `app/(app)/explorer/ResultsTable.tsx`

- [ ] **Step 1: Add 4 sortable headers.** After the `avg_reviews` `SortableHeader` (or after the "Est. monthly vol." `<th>`, ~line 91-100), add:

```tsx
            <SortableHeader label="Vol 4w ago" ascKey="vol_4w_asc" descKey="vol_4w_desc" firstClickKey="vol_4w_desc" currentSort={currentSort} align="right" title="Estimated monthly searches 4 weeks ago (directional, ±~30%). Click to sort — first click shows highest first." />
            <SortableHeader label="Vol 13w ago" ascKey="vol_13w_asc" descKey="vol_13w_desc" firstClickKey="vol_13w_desc" currentSort={currentSort} align="right" title="Estimated monthly searches 13 weeks ago." />
            <SortableHeader label="Vol 26w ago" ascKey="vol_26w_asc" descKey="vol_26w_desc" firstClickKey="vol_26w_desc" currentSort={currentSort} align="right" title="Estimated monthly searches 26 weeks ago." />
            <SortableHeader label="Vol 52w ago" ascKey="vol_52w_asc" descKey="vol_52w_desc" firstClickKey="vol_52w_desc" currentSort={currentSort} align="right" title="Estimated monthly searches 52 weeks ago." />
```

- [ ] **Step 2: Add 4 cells (reuse `formatVolume`).** After the `estimatedMonthlyVolumeCurrent` `<td>` (line 166-168), add (in the same column order as the headers):

```tsx
              <td className="p-2 text-right tabular-nums" title={r.estimatedMonthlyVolume4wAgo !== null ? `${r.estimatedMonthlyVolume4wAgo.toLocaleString()} searches / month (est., 4w ago)` : undefined}>{formatVolume(r.estimatedMonthlyVolume4wAgo)}</td>
              <td className="p-2 text-right tabular-nums" title={r.estimatedMonthlyVolume13wAgo !== null ? `${r.estimatedMonthlyVolume13wAgo.toLocaleString()} searches / month (est., 13w ago)` : undefined}>{formatVolume(r.estimatedMonthlyVolume13wAgo)}</td>
              <td className="p-2 text-right tabular-nums" title={r.estimatedMonthlyVolume26wAgo !== null ? `${r.estimatedMonthlyVolume26wAgo.toLocaleString()} searches / month (est., 26w ago)` : undefined}>{formatVolume(r.estimatedMonthlyVolume26wAgo)}</td>
              <td className="p-2 text-right tabular-nums" title={r.estimatedMonthlyVolume52wAgo !== null ? `${r.estimatedMonthlyVolume52wAgo.toLocaleString()} searches / month (est., 52w ago)` : undefined}>{formatVolume(r.estimatedMonthlyVolume52wAgo)}</td>
```

> Header count and cell count must match (`<th>`/`<td>` alignment). Verify the table still has equal columns per row after adding.

- [ ] **Step 3: Typecheck + commit.** Run: `npm run typecheck` — Expected: PASS.

```bash
git add "app/(app)/explorer/ResultsTable.tsx"
git commit -m "feat(volume): lookback-volume columns in results table

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 3.7: Saved views — serialize + deserialize

**Files:**
- Modify: `lib/savedViews/validation.ts`
- Modify: `lib/savedViews/loadServer.ts`

- [ ] **Step 1: Serialize on save.** In `filtersToSearchParams` (validation.ts), after the `rank_max` line (59), add:

```ts
  if (typeof f.volume4wAgoMin === 'number') p.vol_4w_min = String(f.volume4wAgoMin);
  if (typeof f.volume4wAgoMax === 'number') p.vol_4w_max = String(f.volume4wAgoMax);
  if (typeof f.volume13wAgoMin === 'number') p.vol_13w_min = String(f.volume13wAgoMin);
  if (typeof f.volume13wAgoMax === 'number') p.vol_13w_max = String(f.volume13wAgoMax);
  if (typeof f.volume26wAgoMin === 'number') p.vol_26w_min = String(f.volume26wAgoMin);
  if (typeof f.volume26wAgoMax === 'number') p.vol_26w_max = String(f.volume26wAgoMax);
  if (typeof f.volume52wAgoMin === 'number') p.vol_52w_min = String(f.volume52wAgoMin);
  if (typeof f.volume52wAgoMax === 'number') p.vol_52w_max = String(f.volume52wAgoMax);
```

- [ ] **Step 2: Deserialize on load.** In `normalizeFiltersBlob` (loadServer.ts), after the `rankMax:` line (75), add:

```ts
    volume4wAgoMin: typeof f.volume4wAgoMin === 'number' ? f.volume4wAgoMin : null,
    volume4wAgoMax: typeof f.volume4wAgoMax === 'number' ? f.volume4wAgoMax : null,
    volume13wAgoMin: typeof f.volume13wAgoMin === 'number' ? f.volume13wAgoMin : null,
    volume13wAgoMax: typeof f.volume13wAgoMax === 'number' ? f.volume13wAgoMax : null,
    volume26wAgoMin: typeof f.volume26wAgoMin === 'number' ? f.volume26wAgoMin : null,
    volume26wAgoMax: typeof f.volume26wAgoMax === 'number' ? f.volume26wAgoMax : null,
    volume52wAgoMin: typeof f.volume52wAgoMin === 'number' ? f.volume52wAgoMin : null,
    volume52wAgoMax: typeof f.volume52wAgoMax === 'number' ? f.volume52wAgoMax : null,
```

- [ ] **Step 3: Typecheck + commit.** Run: `npm run typecheck` — Expected: PASS.

```bash
git add lib/savedViews/validation.ts lib/savedViews/loadServer.ts
git commit -m "feat(volume): persist lookback-volume filters in saved views

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 3.8: page.tsx — reset-filters detector

**Files:**
- Modify: `app/(app)/explorer/page.tsx`

- [ ] **Step 1: Extend `filtersAreCustomized`.** After `f.rankMax !== null ||` (line 206), add:

```ts
    f.volume4wAgoMin !== null || f.volume4wAgoMax !== null ||
    f.volume13wAgoMin !== null || f.volume13wAgoMax !== null ||
    f.volume26wAgoMin !== null || f.volume26wAgoMax !== null ||
    f.volume52wAgoMin !== null || f.volume52wAgoMax !== null ||
```

- [ ] **Step 2: Typecheck + commit.** Run: `npm run typecheck` — Expected: PASS.

```bash
git add "app/(app)/explorer/page.tsx"
git commit -m "feat(volume): show reset-filters when a lookback-volume filter is active

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Phase 4 — Detail-page volume chart

### Task 4.1: VolumeChart component (TDD)

**Files:**
- Create: `app/(app)/explorer/keyword/[id]/VolumeChart.tsx`
- Test: `app/(app)/explorer/keyword/[id]/VolumeChart.test.tsx`

> The detail loader already returns `estimatedMonthlyVolume` + `estimatedMonthlyVolumeIsExtrapolated` per history row (see `KeywordDetailHistoryRow`), so this is pure rendering. `gapFillHistory` yields `{ weekEndDate, actualRank, raw }`; we read `raw.estimatedMonthlyVolume`. Distinct from `RankChart`: Y-axis NOT reversed (higher volume up), green line, extrapolated weeks drawn as hollow grey dots.

- [ ] **Step 1: Write the failing test.** Create `app/(app)/explorer/keyword/[id]/VolumeChart.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { VolumeChart } from './VolumeChart';
import type { KeywordDetailHistoryRow } from '@/lib/explorer/fetchKeywordDetail';

// recharts needs a sized container in jsdom; stub ResponsiveContainer.
vi.mock('recharts', async (orig) => {
  const actual = await orig<typeof import('recharts')>();
  return { ...actual, ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div style={{ width: 600, height: 280 }}>{children}</div> };
});

function row(week: string, vol: number | null, extrap = false): KeywordDetailHistoryRow {
  return {
    weekEndDate: week, actualRank: 100, topClickedProduct1Asin: null, topClickedProduct1Title: null,
    topClickedProduct1ClickShare: null, topClickedProduct1ConversionShare: null,
    topClickedProduct2Asin: null, topClickedProduct2Title: null, topClickedProduct3Asin: null,
    topClickedProduct3Title: null, topClickedCategory1: null, keywordInTitle1: null, keywordInTitle2: null,
    keywordInTitle3: null, keywordTitleMatchCount: null, keywordInTitle1Loose: null, keywordInTitle2Loose: null,
    keywordInTitle3Loose: null, keywordTitleMatchCountLoose: null, fakeVolumeSeverity: null, fakeVolumeEvalStatus: null,
    estimatedMonthlyVolume: vol, estimatedMonthlyVolumeIsExtrapolated: extrap, variants: null,
  };
}

describe('VolumeChart', () => {
  it('renders without crashing for a mix of values, gaps, and extrapolated', () => {
    const history = [row('2026-05-16', 1200), row('2026-05-23', null), row('2026-05-30', 1500, true)];
    const { container } = render(<VolumeChart history={history} latestWeek="2026-05-30" />);
    expect(container.querySelector('svg')).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run — verify it fails.** Run: `npx vitest run "app/(app)/explorer/keyword/[id]/VolumeChart.test.tsx"` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement `VolumeChart.tsx`:**

```tsx
'use client';

import { useState } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import type { TooltipContentProps } from 'recharts';
import type { KeywordDetailHistoryRow } from '@/lib/explorer/fetchKeywordDetail';
import { buildWeekCalendar, gapFillHistory } from '@/lib/explorer/formatHistory';

interface VolumePoint {
  weekEndDate: string;
  volume: number | null;
  isExtrapolated: boolean;
}

/**
 * 52-week estimated-volume trend. Mirrors RankChart but the axis is
 * NOT reversed (higher volume = up). Volumes are directional estimates;
 * weeks whose fit was extrapolated (predate calibration) render as
 * hollow grey dots and say so in the tooltip.
 */
export function VolumeChart({
  history,
  latestWeek,
}: {
  history: KeywordDetailHistoryRow[];
  latestWeek: string;
}) {
  const [scale, setScale] = useState<'log' | 'linear'>('log');
  const calendar = buildWeekCalendar(latestWeek, 52);
  const data: VolumePoint[] = gapFillHistory(history, calendar).map((d) => ({
    weekEndDate: d.weekEndDate,
    volume: d.raw?.estimatedMonthlyVolume ?? null,
    isExtrapolated: d.raw?.estimatedMonthlyVolumeIsExtrapolated ?? false,
  }));

  const vols = data.map((d) => d.volume).filter((v): v is number => v !== null && v > 0);
  const hasData = vols.length > 0;
  const logLower = hasData ? Math.max(1, Math.floor(Math.min(...vols) * 0.8)) : 1;
  const logUpper = hasData ? Math.ceil(Math.max(...vols) * 1.25) : 1_000;

  return (
    <div className="border rounded p-4">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-semibold text-gray-700">Est. volume trend (52w)</h2>
        <div className="flex items-center gap-3">
          <p className="text-xs text-gray-500">Directional (±~30%). Hollow dot = extrapolated.</p>
          <ScaleToggle scale={scale} onChange={setScale} />
        </div>
      </div>
      <ResponsiveContainer width="100%" height={280}>
        <LineChart data={data} margin={{ top: 8, right: 24, bottom: 8, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis
            dataKey="weekEndDate"
            tick={{ fontSize: 11 }}
            tickFormatter={formatWeekTick}
            interval={Math.max(0, Math.floor(data.length / 8))}
          />
          <YAxis
            scale={scale === 'log' ? 'log' : 'linear'}
            domain={scale === 'log' ? [logLower, logUpper] : ['auto', 'auto']}
            allowDataOverflow={false}
            tick={{ fontSize: 11 }}
            tickFormatter={formatVolTick}
            width={70}
          />
          <Tooltip content={VolumeTooltip} />
          <Line
            dataKey="volume"
            stroke="#16a34a"
            strokeWidth={2}
            dot={<VolumeDot />}
            connectNulls={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function VolumeDot(props: { cx?: number; cy?: number; payload?: VolumePoint }) {
  const { cx, cy, payload } = props;
  if (cx == null || cy == null || !payload || payload.volume == null) return null;
  return payload.isExtrapolated
    ? <circle cx={cx} cy={cy} r={2.5} fill="white" stroke="#9ca3af" strokeWidth={1} />
    : <circle cx={cx} cy={cy} r={2} fill="#16a34a" />;
}

function ScaleToggle({ scale, onChange }: { scale: 'log' | 'linear'; onChange: (s: 'log' | 'linear') => void }) {
  return (
    <div className="inline-flex rounded border border-gray-200 overflow-hidden text-xs">
      <button type="button" onClick={() => onChange('log')} aria-pressed={scale === 'log'}
        className={`px-2 py-0.5 ${scale === 'log' ? 'bg-green-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'}`}>Log</button>
      <button type="button" onClick={() => onChange('linear')} aria-pressed={scale === 'linear'}
        className={`px-2 py-0.5 border-l border-gray-200 ${scale === 'linear' ? 'bg-green-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'}`}>Linear</button>
    </div>
  );
}

function VolumeTooltip({ active, payload }: TooltipContentProps) {
  if (!active || !payload || payload.length === 0) return null;
  const datum = (payload[0] as { payload: VolumePoint }).payload;
  if (datum.volume === null) {
    return (
      <div className="bg-white border rounded shadow-sm px-3 py-2 text-xs">
        <div className="font-medium">{datum.weekEndDate}</div>
        <div className="text-gray-500 mt-1">no estimate</div>
      </div>
    );
  }
  return (
    <div className="bg-white border rounded shadow-sm px-3 py-2 text-xs">
      <div className="font-medium">{datum.weekEndDate}</div>
      <div className="font-mono mt-1">~{datum.volume.toLocaleString()} / mo</div>
      {datum.isExtrapolated && <div className="text-gray-500 mt-1">extrapolated (predates calibration)</div>}
    </div>
  );
}

function formatWeekTick(v: string): string {
  const [, m, d] = v.split('-');
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthIndex = parseInt(m, 10) - 1;
  if (monthIndex < 0 || monthIndex > 11) return v;
  return `${monthNames[monthIndex]} ${parseInt(d, 10)}`;
}

function formatVolTick(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v % 1_000_000 === 0 ? 0 : 1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(v % 1_000 === 0 ? 0 : 1)}k`;
  return v.toLocaleString();
}
```

- [ ] **Step 4: Run the test.** Run: `npx vitest run "app/(app)/explorer/keyword/[id]/VolumeChart.test.tsx"` — Expected: PASS. (If `@testing-library/react` isn't installed, mirror an existing component test's harness; if no component tests exist, simplify this test to import the module and assert `typeof VolumeChart === 'function'`.)

- [ ] **Step 5: Commit.**

```bash
git add "app/(app)/explorer/keyword/[id]/VolumeChart.tsx" "app/(app)/explorer/keyword/[id]/VolumeChart.test.tsx"
git commit -m "feat(volume): per-week VolumeChart for the detail page

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 4.2: Render VolumeChart on the detail page

**Files:**
- Modify: `app/(app)/explorer/keyword/[id]/page.tsx`

- [ ] **Step 1: Import it.** Near `import { RankChart } from './RankChart';` (line 20), add:

```ts
import { VolumeChart } from './VolumeChart';
```

- [ ] **Step 2: Render it after RankChart.** After the `<RankChart history={history} latestWeek={...} />` block (lines 149-151), add (use the SAME `latestWeek` expression RankChart receives):

```tsx
        <VolumeChart
          history={history}
          latestWeek={current?.currentWeekEndDate ?? lastSeenWeek}
        />
```

> Match RankChart's actual `latestWeek` prop expression (read lines 149-151 and copy it). The point: VolumeChart gets the same `history` + anchor week.

- [ ] **Step 3: Typecheck + commit.** Run: `npm run typecheck` — Expected: PASS.

```bash
git add "app/(app)/explorer/keyword/[id]/page.tsx"
git commit -m "feat(volume): show VolumeChart on the keyword detail page

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Phase 5 — Verify + ship

### Task 5.1: Full verification

- [ ] **Step 1: Typecheck.** Run: `npm run typecheck` — Expected: PASS.
- [ ] **Step 2: Full test suite.** Run: `npx vitest run` — Expected: PASS (the one pre-existing `importFile.test.ts` failure at importFile.ts:607 is a known unrelated harness issue; everything else green).
- [ ] **Step 3: Lint.** Run: `npm run lint` — Expected: PASS (watch for `react-hooks/purity` — no `Date.now()`/`Math.random()` in render).
- [ ] **Step 4: Worker-boot check.** Run: `npm run worker:check` — Expected: OK (refreshSummary imports cleanly under the worker runtime).
- [ ] **Step 5: Build.** Run: `npm run build` — Expected: PASS.

### Task 5.2: Manual end-to-end (against a real refresh)

> The new columns are only populated after a `summary_refresh` runs. Until the next import (or a manual `refreshSummaryOnce`), the 4 columns are NULL and the explorer shows "—" / the detail chart shows "no estimate". Decide with the user whether to trigger a manual refresh now or let the next weekly import populate them.

- [ ] **Step 1:** After a refresh has run, load `/explorer`, open the FilterSidebar, set "Est. volume 13w ago" Min, Apply — confirm rows filter and the URL gains `vol_13w_min`.
- [ ] **Step 2:** Sort by "Highest volume 4w ago" — confirm ordering + the `sort=vol_4w_desc` URL param.
- [ ] **Step 3:** Save a view with a volume filter, reload, re-open it — confirm the filter round-trips.
- [ ] **Step 4:** Open a keyword detail page — confirm the VolumeChart renders, with gaps for unranked weeks and hollow dots on extrapolated weeks.

### Task 5.3: Ship

- [ ] **Step 1:** Final review of the diff (`git log --oneline feat/search-volume-lookback`).
- [ ] **Step 2:** Use **superpowers:finishing-a-development-branch** to open a PR (or merge to main per the user's preference), and confirm the migration has been applied to Neon (Task 1.2) before the first production refresh runs.

---

## Self-review notes (gaps the implementer should watch)

- **Migration touches BOTH tables** (`keyword_current_summary` + `_stage`) — the stage INSERT fails otherwise.
- **Param-index chaining** is the only subtle bit; it's covered by `buildVolumeExpressions` unit tests — keep `$1` reserved for `currentWeekEndDate` (start at `2`).
- **Compile-time tripwires** force completeness: `buildOrderBy`'s exhaustive `switch`, the `ExplorerFilters` literals in `loadServer.ts`/`EXPLORER_DEFAULTS`, and the `ExplorerRow` mapper.
- **Header/cell count** in ResultsTable must stay balanced.
- **Test-harness adjustments:** the exact `buildQuery` export name and the component-test harness may differ — read the neighbouring test files and match them (noted inline).
