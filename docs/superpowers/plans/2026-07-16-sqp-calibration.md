# SQP-Primary Recalibration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Monthly SQP exports become the training source for the rank→volume fit (POE demoted to validation + head-supplement), with an owner-gated dry-run→persist go-live.

**Architecture:** New `sqp_calibration_data` table (structural mirror of the POE table, migration 0045); a pure SQP CSV parser; `fitOrchestrator` re-pointed to SQP ⋈ monthly_sfr with a POE head-supplement (pairs ranked better than the SQP anchor), a `persist` flag, and three new report sections (POE-validation MAPE, per-band level delta vs production, implied rank-1 volume); ingestion wired into the existing admin calibration upload + worker auto-fit (moved from POE to SQP, dry-run mode); CLI gains `--persist`.

**Tech Stack:** Drizzle schema + hand-numbered raw-SQL migration (gated apply), vitest TDD for pure parts, pg Pool orchestration, existing admin upload page + worker job patterns.

**Spec:** `docs/superpowers/specs/2026-07-16-sqp-calibration-design.md` (incl. head-extrapolation amendment)

**Conventions (non-negotiable):** work on `main`; commit per task; **NEVER push**; trailer exactly `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`; `git add` named files only; **implementers never run DDL or fits against the database** — migration/fit execution is owner-gated in Task 6. `.env.local` is never printed or committed.

**Load-bearing semantics (from the spec, repeated for implementers):**
- Training pairs = SQP ⋈ monthly_sfr for the month, PLUS POE pairs whose rank is STRICTLY BETTER (lower) than the month's best SQP rank (head supplement — the ≤100 band is where the sources agree within 4%).
- Anchor = lowest-rank **SQP** pair (never a POE pair), so the level is pinned to first-party data while POE head pairs inform the slope above it.
- Category exclusions apply to ALL training pairs (both sources).
- `persist: false` (default) computes + reports everything, writes nothing. Only `persist: true` calls `recordRun` (go-live: detail pages immediately, kcs at next weekly refresh).
- POE-triggered auto-fit is retired; the SQP upload triggers a DRY-RUN fit report.

---

### Task 1: Migration 0045 + Drizzle schema + gated apply script (code only — DO NOT APPLY)

**Files:**
- Create: `db/migrations/0045_sqp_calibration.sql`
- Create: `db/schema/sqpCalibrationData.ts`
- Modify: `db/schema/index.ts` (one export line)
- Create: `scripts/applyMigration0045.ts`

- [ ] **Step 1:** Write `db/migrations/0045_sqp_calibration.sql`:

```sql
-- 0045: SQP calibration source (spec docs/superpowers/specs/2026-07-16-sqp-calibration-design.md).
-- Structural mirror of poe_calibration_data; joined to monthly_sfr on
-- (search_term_normalized, month_end_date) to build (rank, volume) pairs.
-- SQP volume = Brand Analytics "Search Query Volume" (marketplace-wide
-- unique-customer query count for the month).

CREATE TABLE IF NOT EXISTS sqp_calibration_data (
  search_term_normalized text NOT NULL,
  month_end_date         date NOT NULL,
  sqp_monthly_volume     bigint NOT NULL,
  source_filename        text,
  imported_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (search_term_normalized, month_end_date)
);
CREATE INDEX IF NOT EXISTS sqp_calibration_volume_idx ON sqp_calibration_data (sqp_monthly_volume);
CREATE INDEX IF NOT EXISTS sqp_calibration_month_idx  ON sqp_calibration_data (month_end_date);
```

- [ ] **Step 2:** Write `db/schema/sqpCalibrationData.ts` (mirror `db/schema/poeCalibrationData.ts`'s structure and comment voice — read it first):

```ts
import { pgTable, text, bigint, timestamp, date, index, primaryKey } from 'drizzle-orm/pg-core';

/**
 * SQP calibration sample — the owner's Brand Analytics Search Query
 * Performance monthly export. "Search Query Volume" is Amazon's
 * marketplace-wide unique-customer query count for the month (not
 * brand-scoped), which makes it the first-party truth source for the
 * rank→volume fit (spec 2026-07-16).
 *
 * Keyed by (search_term_normalized, month_end_date), joined to
 * `monthly_sfr` exactly like poe_calibration_data. POE remains stored
 * for validation + head-supplement pairs; SQP trains.
 *
 * See db/migrations/0045_sqp_calibration.sql.
 */
export const sqpCalibrationData = pgTable(
  'sqp_calibration_data',
  {
    searchTermNormalized: text('search_term_normalized').notNull(),
    /** Month this SQP export represents. Combined with search_term to form the PK. */
    monthEndDate: date('month_end_date').notNull(),
    sqpMonthlyVolume: bigint('sqp_monthly_volume', { mode: 'number' }).notNull(),
    sourceFilename: text('source_filename'),
    importedAt: timestamp('imported_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.searchTermNormalized, t.monthEndDate] }),
    volumeIdx: index('sqp_calibration_volume_idx').on(t.sqpMonthlyVolume),
    monthIdx: index('sqp_calibration_month_idx').on(t.monthEndDate),
  }),
);

export type SqpCalibrationRow = typeof sqpCalibrationData.$inferSelect;
```

Add to `db/schema/index.ts`, next to the poeCalibrationData export: `export * from './sqpCalibrationData';`

- [ ] **Step 3:** Write `scripts/applyMigration0045.ts` — replicate `scripts/applyMigration0044.ts`'s structure exactly (gate `APPLY_0045=yes`, file path swapped, assertion checks `information_schema.tables` for `sqp_calibration_data` + `pg_indexes` for the two index names; statement_timeout 60_000 is fine — empty-table DDL, follow 0043's value not 0044's).

- [ ] **Step 4:** `pnpm typecheck` green. Do NOT run the apply script.

- [ ] **Step 5:** Commit:

```bash
git add db/migrations/0045_sqp_calibration.sql db/schema/sqpCalibrationData.ts db/schema/index.ts scripts/applyMigration0045.ts
git commit -m "feat(db): migration 0045 — sqp_calibration_data mirror table (not yet applied)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: SQP CSV parser (TDD)

**Files:**
- Create: `lib/volumeModel/parseSqpCsv.ts`
- Test: `lib/volumeModel/parseSqpCsv.test.ts`

Real export format (validated 2026-07-16 against the owner's weekly file; monthly differs only in the metadata key):
line 1 metadata: `Brand=["Double Wood Supplements"],Reporting Range=["Weekly"],Select week=["Week 28 | 2026-07-05 - 2026-07-11 2026"]` (monthly: `Reporting Range=["Monthly"],Select month=["…"]`); line 2 quoted header incl. `"Search Query"`, `"Search Query Volume"`; then quoted data rows.

- [ ] **Step 1: Write failing tests** (`parseSqpCsv.test.ts`):

```ts
import { describe, expect, it } from 'vitest';
import { parseSqpCsv, SqpParseError } from './parseSqpCsv';

const HEADER = '"Search Query","Search Query Score","Search Query Volume","Impressions: Total Count","Reporting Date"';

const file = (meta: string, rows: string[]) => [meta, HEADER, ...rows].join('\n');

describe('parseSqpCsv', () => {
  it('parses rows, normalizes terms, and integers volumes', () => {
    const out = parseSqpCsv(file('Brand=["X"],Reporting Range=["Monthly"],Select month=["June | 2026-06-01 - 2026-06-30 2026"]', [
      '"collagen peptides","702","103376","2779737","2026-06-30"',
      '"Nature\'s Magnesium, Extra","1","1,234","10","2026-06-30"',
    ]));
    expect(out.rows).toEqual([
      { searchTermNormalized: 'collagen peptides', monthlyVolume: 103376 },
      { searchTermNormalized: 'natures magnesium extra', monthlyVolume: 1234 },
    ]);
  });

  it('keeps MAX volume on duplicate normalized terms', () => {
    const out = parseSqpCsv(file('Brand=["X"]', [
      '"vitamin d3","1","100","1","2026-06-30"',
      '"Vitamin D3","1","250","1","2026-06-30"',
    ]));
    expect(out.rows).toEqual([{ searchTermNormalized: 'vitamin d3', monthlyVolume: 250 }]);
  });

  it('extracts the suggested month end date from Select month metadata', () => {
    const out = parseSqpCsv(file('Reporting Range=["Monthly"],Select month=["June | 2026-06-01 - 2026-06-30 2026"]', [
      '"a term","1","10","1","2026-06-30"',
    ]));
    expect(out.suggestedMonthEndDate).toBe('2026-06-30');
  });

  it('suggests null for weekly files (no Select month)', () => {
    const out = parseSqpCsv(file('Reporting Range=["Weekly"],Select week=["Week 28 | 2026-07-05 - 2026-07-11 2026"]', [
      '"a term","1","10","1","2026-07-11"',
    ]));
    expect(out.suggestedMonthEndDate).toBeNull();
  });

  it('skips rows with empty terms or non-numeric volumes', () => {
    const out = parseSqpCsv(file('Brand=["X"]', [
      '"","1","10","1","2026-06-30"',
      '"ok term","1","not a number","1","2026-06-30"',
      '"good term","1","42","1","2026-06-30"',
    ]));
    expect(out.rows).toEqual([{ searchTermNormalized: 'good term', monthlyVolume: 42 }]);
  });

  it('throws SqpParseError when required columns are missing', () => {
    expect(() => parseSqpCsv(['meta', '"Search Query","Something Else"', '"a","1"'].join('\n')))
      .toThrow(SqpParseError);
  });

  it('handles quoted fields containing commas and escaped quotes', () => {
    const out = parseSqpCsv(file('Brand=["X"]', [
      '"magnesium ""extra"", strong","1","5,000","1","2026-06-30"',
    ]));
    expect(out.rows[0].searchTermNormalized).toBe('magnesium extra strong');
    expect(out.rows[0].monthlyVolume).toBe(5000);
  });
});
```

- [ ] **Step 2:** `pnpm vitest run lib/volumeModel/parseSqpCsv.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** `lib/volumeModel/parseSqpCsv.ts`:

```ts
/**
 * Parser for Brand Analytics Search Query Performance CSV exports
 * (spec docs/superpowers/specs/2026-07-16-sqp-calibration-design.md §2).
 *
 * Format: line 1 = metadata (Brand=[…],Reporting Range=[…],Select month=[…]),
 * line 2 = quoted header, then quoted data rows. "Search Query Volume" is the
 * marketplace-wide unique-customer query count for the period.
 */
import { normalizeForMatch } from '@/lib/analytics/derivedFields';

export class SqpParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SqpParseError';
  }
}

export interface ParsedSqpRow {
  searchTermNormalized: string;
  monthlyVolume: number;
}

export interface ParsedSqpFile {
  rows: ParsedSqpRow[];
  /**
   * Month-end date parsed from the `Select month=[…]` metadata (the second
   * ISO date in the bracket), or null (e.g. weekly files). The admin form's
   * month field stays authoritative; this only pre-fills it.
   */
  suggestedMonthEndDate: string | null;
  /** Raw metadata line, for provenance/debug display. */
  metadata: string;
}

/** Minimal RFC-4180 parser: quoted fields, embedded commas, doubled quotes. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

export function parseSqpCsv(text: string): ParsedSqpFile {
  const raw = parseCsv(text);
  if (raw.length < 2) throw new SqpParseError('File too short: expected metadata line + header');
  const metadata = raw[0].join(',');
  const header = raw[1];
  const qi = header.indexOf('Search Query');
  const vi = header.indexOf('Search Query Volume');
  if (qi < 0 || vi < 0) {
    throw new SqpParseError('Missing required columns "Search Query" / "Search Query Volume" — is this an SQP export?');
  }

  const byTerm = new Map<string, number>();
  for (const r of raw.slice(2)) {
    if (r.length <= Math.max(qi, vi)) continue;
    const term = normalizeForMatch(r[qi]);
    const volume = parseInt(r[vi].replace(/,/g, ''), 10);
    if (!term || !Number.isFinite(volume) || volume <= 0) continue;
    byTerm.set(term, Math.max(byTerm.get(term) ?? 0, volume));
  }

  // `Select month=["June | 2026-06-01 - 2026-06-30 2026"]` → second ISO date.
  let suggestedMonthEndDate: string | null = null;
  const m = metadata.match(/Select month=\["[^"]*?(\d{4}-\d{2}-\d{2})\s*-\s*(\d{4}-\d{2}-\d{2})/);
  if (m) suggestedMonthEndDate = m[2];

  return {
    rows: [...byTerm.entries()].map(([searchTermNormalized, monthlyVolume]) => ({ searchTermNormalized, monthlyVolume })),
    suggestedMonthEndDate,
    metadata,
  };
}
```

- [ ] **Step 4:** Tests pass; `pnpm typecheck` green. (Note: `normalizeForMatch` strips commas/quotes — the test expectations above encode its real behavior; if any assertion disagrees with the actual normalizer output, fix the TEST to the normalizer's truth and report it.)

- [ ] **Step 5:** Commit:

```bash
git add lib/volumeModel/parseSqpCsv.ts lib/volumeModel/parseSqpCsv.test.ts
git commit -m "feat(calibration): SQP CSV parser (TDD)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: fitOrchestrator — SQP-primary pairs, POE head supplement, dry-run/persist, report additions

**Files:**
- Modify: `lib/volumeModel/fitOrchestrator.ts`
- Test: `lib/volumeModel/fitOrchestrator.test.ts` (create if absent; pure helpers only — no DB in tests)

Read the whole file first. Changes:

- [ ] **Step 1: Pair fetching.** Replace `fetchPairs` with an SQP-primary version that returns tagged pairs. Keep the lateral-category exclusion pattern EXACTLY as it is today (same `EXCLUDED_CATEGORIES_FROM_FIT` handling, same NULL-category-not-excluded rule); the change is the sources. New SQL shape (one query; keep the `is_excluded` computed column and both-counts reporting):

```sql
WITH sqp_pairs AS (
  SELECT m.actual_rank, s.sqp_monthly_volume::text AS volume,
         m.search_term_normalized, 'sqp'::text AS source
  FROM monthly_sfr m
  JOIN sqp_calibration_data s
    ON s.search_term_normalized = m.search_term_normalized
   AND s.month_end_date = m.month_end_date
  WHERE m.month_end_date = $1::date AND m.actual_rank > 0 AND s.sqp_monthly_volume > 0
), sqp_best AS (
  SELECT COALESCE(MIN(actual_rank), 0) AS best_rank FROM sqp_pairs
), poe_head AS (
  -- Head supplement: POE pairs STRICTLY better-ranked than the best SQP pair
  -- (the ≤100 band is where the two sources measured within 4%; spec amendment).
  SELECT m.actual_rank, p.poe_30_day_volume::text AS volume,
         m.search_term_normalized, 'poe_head'::text AS source
  FROM monthly_sfr m
  JOIN poe_calibration_data p
    ON p.search_term_normalized = m.search_term_normalized
   AND p.month_end_date = m.month_end_date
  WHERE m.month_end_date = $1::date AND m.actual_rank > 0 AND p.poe_30_day_volume > 0
    AND m.actual_rank < (SELECT best_rank FROM sqp_best)
), all_pairs AS (
  SELECT * FROM sqp_pairs UNION ALL SELECT * FROM poe_head
)
SELECT a.actual_rank, a.volume, a.source,
       cat.top_clicked_category_1 AS category,
       (cat.top_clicked_category_1 IS NOT NULL
         AND cat.top_clicked_category_1 IN (<excludedList>)) AS is_excluded
FROM all_pairs a
JOIN search_terms st ON st.search_term_normalized = a.search_term_normalized
LEFT JOIN LATERAL (
  SELECT top_clicked_category_1
  FROM keyword_weekly_metrics
  WHERE search_term_id = st.id
  ORDER BY week_end_date DESC
  LIMIT 1
) cat ON true
```

`Pair` gains `source: 'sqp' | 'poe_head'`. Throw `FitInsufficientDataError` when the post-filter SQP pair count (not total) is < 20 — POE head pairs never satisfy the minimum on their own.

- [ ] **Step 2: Anchor = lowest-rank SQP pair** (never poe_head):

```ts
    const sqpPairs = pairs.filter((p) => p.source === 'sqp');
    const anchorPair = sqpPairs.reduce((best, p) => (p.rank < best.rank ? p : best), sqpPairs[0]);
    const anchor = { rank: anchorPair.rank, volume: anchorPair.volume };
```

Update the anchor's explanatory comment: level pinned to first-party SQP; POE head pairs (ranks above the anchor) inform the slope (spec amendment 2026-07-16). Training/holdout split and the grid search take ALL pairs (both sources) — the split, trim, and MAPE code treat `Pair` uniformly (they ignore `source`).

- [ ] **Step 3: `persist` flag.** `runFitOrchestration` args gain `persist?: boolean` (default `false`). Wrap the `recordRun` call in `if (args.persist)`; result gains `persisted: boolean` and `runId: string | null` (null when dry-run). Update the result doc comment: dry-run computes + reports everything; persist is go-live (detail pages read fits immediately; kcs at next weekly refresh).

- [ ] **Step 4: Report additions** (all computed in BOTH modes), added to `FitOrchestrationResult`:

```ts
  /** MAPE bands of the new fit against the month's POE pairs (validation only; expected worse than holdout — different source units). Null when no POE data for the month. */
  poeValidation: { overall: number | null; top1k: number | null; rank1kTo10k: number | null; rank10kTo100k: number | null; above100k: number | null } | null;
  /** Median predicted-volume ratio (new fit ÷ current production fit) at fixed probe ranks per band. Null when no production fit exists. */
  levelDeltaVsProduction: { top1k: number; rank1kTo10k: number; rank10kTo100k: number; above100k: number } | null;
  /** predictVolumeFromFit(1, fit) — the owner's monthly gut-check for the extrapolated top of the curve. */
  impliedRank1Volume: number;
  /** How many POE head-supplement pairs were admitted (spec amendment). */
  nPoeHeadPairs: number;
  /** The anchor pair used (always an SQP pair). */
  anchor: { rank: number; volume: number };
```

Implementation:
- `poeValidation`: fetch the month's POE⋈monthly_sfr pairs (the OLD fetchPairs query, unchanged — extract it as `fetchPoeValidationPairs`) and run the existing `stratifiedMapeFromFit` against the new fit.
- `levelDeltaVsProduction`: load the latest `model_calibration_runs` row (same query shape the EDA used); for probe ranks `[50, 300, 3_000, 30_000, 300_000]` compute `predictVolumeFromFit(r, newFit) / predictVolumeFromFit(r, prodFit)` and report per band (50+300 → top1k as their median; 3k → rank1kTo10k; 30k → rank10kTo100k; 300k → above100k).
- Pure helpers (`probeLevelDelta(newFit, prodFit)`, band mapping) go at module bottom and get unit tests in `fitOrchestrator.test.ts` with hand-built fits (no DB): assert a fit with half the scale factors reports ~0.5 everywhere; assert `impliedRank1Volume` equals the head segment's `A` (rank^−β at rank 1 = A).

- [ ] **Step 5: Trim ratio param.** Give `runFitOrchestration` `trimDropRatio?: number` (default 10) threaded into the grid search + `fit_params` (replacing the two hardcoded `10`s), so the first SQP fit can experiment without code edits.

- [ ] **Step 6:** `pnpm typecheck` green; `pnpm vitest run lib/volumeModel` green (new helper tests + parser tests). Compile-check the two existing callers (`scripts/fitVolumeModel.ts`, `worker/calibrationJobs.ts`) — if the signature change breaks them, add the minimal `persist: true` argument at their call sites to PRESERVE current behavior for now (Task 4 owns their real semantics) and report that you did.

- [ ] **Step 7:** Commit:

```bash
git add lib/volumeModel/fitOrchestrator.ts lib/volumeModel/fitOrchestrator.test.ts
git commit -m "feat(calibration): SQP-primary fit — POE head supplement, dry-run/persist, validation report

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

(Include the caller files in the commit only if Step 6 required the stopgap args.)

---

### Task 4: Ingestion — upload slot, API, worker auto-fit move

**Files (read each fully first; mirror the POE path's structure/voice):**
- Modify: `app/admin/upload-calibration/CalibrationUploader.tsx` (add SQP file input)
- Modify: the API route the uploader posts to (follow the component's fetch call to find it)
- Modify: `worker/calibrationJobs.ts` (auto-fit trigger moves POE→SQP, becomes dry-run)
- Possibly modify: whatever email/report builder the worker uses for fit results (extend, don't fork)

Behavior contract (exact code depends on the files — read first, keep diffs minimal and pattern-faithful):

- [ ] **Step 1: Uploader.** Add an optional "SQP monthly export (CSV)" file input beside the POE one, same styling/labels as existing inputs, with helper text naming the Brand Analytics source. The month selector stays shared. If the existing form requires POE, make BOTH POE and SQP individually optional but at least one file required (BA monthly SFR requirement unchanged — read what the form enforces today and preserve it for BA).
- [ ] **Step 2: API route.** Parse the SQP file with `parseSqpCsv`; upsert rows into `sqp_calibration_data` for the form's month (`ON CONFLICT (search_term_normalized, month_end_date) DO UPDATE SET sqp_monthly_volume = EXCLUDED.sqp_monthly_volume, source_filename = EXCLUDED.source_filename, imported_at = now()`), mirroring the POE upsert's batching/transaction pattern exactly. Reject with a clear 400 on `SqpParseError`. If the parser's `suggestedMonthEndDate` is non-null and ≠ the form month, include a warning string in the response (do not block).
- [ ] **Step 3: Worker auto-fit.** The auto-fit that today fires after a POE upload fires after an SQP upload instead, calling `runFitOrchestration({ monthEndDate, persist: false })` and reporting via the existing channel (email/console — extend the existing report builder with the new fields: anchor, nPoeHeadPairs, poeValidation bands, levelDeltaVsProduction, impliedRank1Volume, and a "DRY RUN — not persisted; use scripts/fitVolumeModel.ts --persist to go live" line). A POE-only upload stores data and does NOT fit.
- [ ] **Step 4:** `pnpm typecheck && pnpm test && pnpm build` all green.
- [ ] **Step 5:** Commit (named files):

```bash
git commit -m "feat(calibration): SQP upload slot + ingestion; auto-fit moves to SQP uploads (dry-run)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: CLI + full verification

**Files:**
- Modify: `scripts/fitVolumeModel.ts` (read first)

- [ ] **Step 1:** CLI defaults to dry-run; `--persist` flag opts into go-live. Print the full report incl. the Task-3 additions (anchor, nPoeHeadPairs, per-band holdout MAPE, poeValidation, levelDeltaVsProduction, impliedRank1Volume, trim drop count), with a loud trailing line stating whether the run was persisted. Keep existing month-selection args as they are.
- [ ] **Step 2:** `pnpm typecheck && pnpm test && pnpm build` — all green; report counts.
- [ ] **Step 3:** Commit:

```bash
git add scripts/fitVolumeModel.ts
git commit -m "feat(calibration): fit CLI dry-run by default, --persist gates go-live

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Ship — owner-gated checkpoints (controller + owner)

- [ ] **Step 1:** `npx tsx scripts/checkActiveJobs.ts` → quiet; owner authorizes push; push + deploy (Vercel + Railway worker both redeploy).
- [ ] **Step 2:** Owner green-lights DDL → `APPLY_0045=yes node --env-file=.env.local --import tsx scripts/applyMigration0045.ts` (instant — empty table).
- [ ] **Step 3:** Owner supplies the **monthly SQP export** for the newest month with `monthly_sfr` loaded (June 2026 expected) → upload via the new admin slot (or controller ingests via a one-off script if the UI path is inconvenient) → dry-run report arrives automatically.
- [ ] **Step 4:** Review the dry-run report together against the spec's acceptance: holdout MAPE bands ≤ production's recorded MAPEs where comparable; anchor is a sub-100-rank SQP pair; implied rank-1 volume passes the gut check; level deltas ≈ head −20% / mid-tail −40–50%.
- [ ] **Step 5:** Owner approves → `--persist` run → spot-check detail pages + the Δ-vol sort's top improvements against SQP-console intuition.
- [ ] **Step 6:** Next weekly import: confirm kcs estimates moved as predicted; update memory (fit swap date, new β/anchor, POE demotion).
