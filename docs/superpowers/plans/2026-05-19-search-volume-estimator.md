# Search volume estimator from SFR + POE calibration

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Before starting, run `superpowers:brainstorming` to lock in any open questions (see "Open questions" section).

**Goal:** Convert weekly SFR (Search Frequency Rank) values into estimated weekly and monthly search volume for every keyword in the dataset. Calibrated via two complementary signals:

1. **Primary path — 30-day direct pairs:** For a sample of keywords where we have both Amazon's monthly POE (Product Opportunity Explorer) search volume AND Amazon's monthly BA SFR for the same window, we get clean 1:1 (rank, volume) calibration pairs at the granularity we care about. No aggregation, no allocation — directly observed empirical points.
2. **Secondary path — 360-day POE:** For higher-volume keywords where the monthly POE isn't available, we fall back to 360-day POE + 52-week SFR aggregation via a power-law model. This anchors the high-volume end of the curve where the direct pairs are sparse.

**Architecture:** Build an empirical rank-to-volume curve from the 30-day direct pairs. Smooth it (or fit a parametric form once we see the shape). Apply across the full keyword corpus to produce per-(keyword, month) volume estimates. Also fit a power-law model `annual_volume = A × Σ(weekly_SFR^-β)` as a cross-validation and high-volume anchor. Estimates stored on `keyword_weekly_metrics` (weekly) and `keyword_current_summary` (current + trailing-month). Where we have POE data, use it directly; only use the model where POE isn't available.

**Tech Stack:** Postgres 17 (Neon), node-postgres + drizzle for the backfill + refresh path, plain TypeScript for the model fitter (no Python — keep the toolchain unified), vitest for unit tests on the math.

---

## Context — what we're building and why

Today, our explorer surfaces SFR rank (1 = top searched, higher = less searched) — useful for relative ordering but abstract. A user looking at "rank 5,000 for 'magnesium glycinate'" can't easily reason about whether that's worth pursuing without intuition for what 5,000 means in absolute search-volume terms.

Amazon's POE (Product Opportunity Explorer) gives actual 360-day search volumes for individual keywords, but only retail-account holders can pull POE, and only one keyword at a time — so we have it for a sample, not the full ~3M-row corpus.

We can use the POE sample to **calibrate a rank-to-volume model**: for the ~1K-5K keywords with POE data, fit a power-law that maps weekly SFR history to annual volume. Then apply that model to every keyword in the corpus to estimate weekly and monthly volume. The result is a column in the explorer that turns "rank 5,000" into "~12,000 searches/month" — concrete, decision-useful.

**Why power law:** Amazon search distributions empirically follow Zipfian / power-law patterns. The right framework is `V ≈ A × rank^-β` per week, summed across the 52-week year. Averaging ranks (e.g., "average SFR over 52 weeks") is conceptually wrong because rank-to-volume is non-linear — a week at rank 100 contributes far more than a week at rank 10,000, but arithmetic averaging treats them as if their weighted contribution were `(rank_1 + rank_2) / 2`, which is meaningless. The power-law sum accounts for this.

**Why fit in log space:** search volumes are lognormal. Fitting `log(V) = log(A) - β × log(Σ SFR^-β)` in least-squares matches the noise distribution and stops the fit from being dominated by the top-1K keywords (which have 100,000× the volume of long-tail terms).

**Order of operations vs Keepa enrichment:** independent workstreams. Both touch `keyword_current_summary` for their respective columns; no shared state.

---

## File Structure

**Created:**
- `db/migrations/00XX_monthly_sfr.sql` — `monthly_sfr` table + `import_duplicate_search_terms` extension to support monthly uploads
- `db/migrations/00XX_poe_calibration_data.sql` — POE calibration sample table + model history table
- `db/migrations/00XX_estimated_volume_columns.sql` — new columns on kwm + kcs for storing estimates
- `db/schema/monthlySfr.ts` — drizzle table def for monthly SFR
- `db/schema/poeCalibrationData.ts` — drizzle table def for POE sample
- `db/schema/modelCalibrationRuns.ts` — drizzle table def for model history
- `scripts/ingestMonthlySfr.ts` — CSV → monthly_sfr, mirrors weekly dedup CTE
- `scripts/ingestPoeCalibration.ts` — CSV → poe_calibration_data
- `scripts/runVolumeModelEda.ts` — log-log scatter + basic stats on the calibration sample
- `scripts/fitVolumeModel.ts` — fit empirical curve through 30-day pairs + power-law on 360-day data, validate by rank band
- `scripts/backfillEstimatedVolumes.ts` — one-shot population of kwm.estimated_weekly_volume
- `lib/analytics/volumeModel.ts` — pure functions `estimateWeeklyVolume`, `estimateMonthlyVolume`
- `lib/analytics/volumeModel.test.ts` — vitest unit tests
- `app/explorer/EstimatedVolumeCell.tsx` — formatter for the explorer column (e.g. "~12.3K/mo")

**Modified:**
- `db/schema/importDuplicateSearchTerms.ts` — add `month_end_date` column + `period_type` discriminator
- `inngest/functions/refreshSummary.ts` — populate the `*_current` estimated-volume columns during the kcs stage build, using the latest model parameters
- `app/explorer/page.tsx` — add the estimated-monthly-volume column (always-on default)
- `app/explorer/keyword/[id]/page.tsx` — surface estimated volume on the detail page
- `lib/explorer/runQuery.ts` — return the new column in the explorer query

---

## Locked-in decisions reference

| Decision | Value | Notes |
|---|---|---|
| Model family | Single-β power law | Piecewise-by-rank-band only if EDA shows curvature (Task 4 decides) |
| Fit objective | Log-space least-squares on annual POE volume | Matches lognormal noise; prevents top-1K dominance |
| Calibration window | 52 weeks → 360-day POE | Day-alignment correction (Task 4) is v2 polish |
| Granularity | Per-(keyword, week) | Monthly = derived sum of 4 most recent weeks |
| When to use POE directly | Whenever available | Model only runs for keywords without POE |
| Missing-week handling | Treat as below-threshold | Use `max_reported_rank × 1.25` as a placeholder; flag estimate as lower-confidence |
| Storage | New columns on kwm + kcs | No separate "estimates" table — keep adjacency to the source data |
| Recompute trigger | Inside refreshSummary | Same place as existing per-row computed fields |

---

## Open questions (resolve via brainstorming before starting)

1. **POE CSV format.** Confirm columns. Minimum: `search_term`, `poe_360_day_volume`. Optional: 30/60/90/180-day periods if the user has them. Affects ingest script.
2. **Term-matching strategy.** Exact match on `search_term_normalized` (lowercase, trim, drop apostrophes) is the safe v1. Fuzzy match (loose) only after we see how the exact match performs.
3. **UI placement.** Always-on column in explorer, or opt-in like the Keepa review/rating columns? My lean: always-on (it's the most decision-useful single column we'd add).
4. **Recalibration cadence.** Re-fit β quarterly? On every POE refresh? Manual trigger? Affects scope of Task 5.
5. **Confidence indicator.** Do we want to flag low-confidence estimates (high missing-week count, sparse SFR history)? Adds UI complexity; possibly v2.

---

## Task 0: Monthly SFR upload pipeline (precondition for calibration)

**Why this comes first:** The primary calibration path is 30-day BA-vs-POE pairs. That requires Amazon's monthly BA SFR data in our database to JOIN against the POE sample. Amazon publishes monthly BA reports as a separate export from the weekly ones we currently ingest (different time granularity, different file). Without this, we can't build the (rank, volume) pairs the model fits to.

**Design philosophy:** Mirror the weekly dedup logic *exactly* — same `ROW_NUMBER() OVER (PARTITION BY ... ORDER BY actual_rank ASC, had_unicode_noise ASC, source_row_number ASC)` pattern. Use a temp staging table inside the script and run the dedup CTE in Postgres so the SQL is identical to the weekly path, just against a different permanent destination table. No drift between weekly and monthly normalization/dedup math.

**Files:**
- Create: `db/migrations/00XX_monthly_sfr.sql`
- Create: `db/schema/monthlySfr.ts`
- Create: `scripts/ingestMonthlySfr.ts`
- Modify: `db/schema/importDuplicateSearchTerms.ts` (add `month_end_date` + `period_type`)

- [ ] **Step 0.1: Write the migration**

```sql
-- Monthly SFR snapshot from Amazon Brand Analytics. Separate from
-- weekly because the file format is different (monthly aggregate) and
-- the cadence is different (uploaded ad-hoc for calibration, not as
-- the app's regular heartbeat).
--
-- Primary use: paired with poe_calibration_data on (normalized_term,
-- month_end_date) to build empirical (rank, volume) pairs for the
-- volume estimator's primary calibration path.
--
-- One row per (search_term_normalized, month_end_date). Dedup within
-- an upload (multiple raw terms collapsing to one normalized form)
-- uses the same ORDER BY priority as the weekly path:
--   1. actual_rank ASC (lowest = best)
--   2. had_unicode_noise ASC (false < true: prefer clean rows)
--   3. source_row_number ASC (earliest in CSV as final tiebreak)
-- See inngest/functions/importFile.ts lines 237-261 for the weekly
-- mirror.

CREATE TABLE monthly_sfr (
  search_term_normalized   text NOT NULL,
  month_end_date           date NOT NULL,
  actual_rank              integer NOT NULL,
  source_filename          text,
  imported_at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (search_term_normalized, month_end_date)
);

CREATE INDEX monthly_sfr_month_rank_idx
  ON monthly_sfr (month_end_date, actual_rank);

-- Extend the existing audit log so monthly uploads can use the same
-- table as weekly. period_type discriminator + month_end_date column;
-- existing weekly rows keep their week_end_date and get
-- period_type='weekly' as default.

ALTER TABLE import_duplicate_search_terms
  ADD COLUMN month_end_date date,
  ADD COLUMN period_type text NOT NULL DEFAULT 'weekly'
    CHECK (period_type IN ('weekly', 'monthly'));

-- Either week_end_date OR month_end_date must be set depending on
-- period_type — encoded as a CHECK constraint for safety.
ALTER TABLE import_duplicate_search_terms
  ADD CONSTRAINT import_duplicate_period_consistent CHECK (
    (period_type = 'weekly' AND week_end_date IS NOT NULL AND month_end_date IS NULL)
    OR
    (period_type = 'monthly' AND month_end_date IS NOT NULL AND week_end_date IS NULL)
  );
```

- [ ] **Step 0.2: Drizzle schema + journal + apply migration**

Standard pattern — `pgTable` for `monthly_sfr`, update `importDuplicateSearchTerms.ts` to include the new columns, append journal entry, `pnpm db:migrate`.

- [ ] **Step 0.3: Write `scripts/ingestMonthlySfr.ts`**

Argument shape:

```
pnpm tsx scripts/ingestMonthlySfr.ts data/monthly-ba-2026-04.csv 2026-04-30
```

(Path to CSV + explicit `month_end_date` since the CSV itself may not carry the date.)

Script flow:

```typescript
import { normalizeSearchTerm } from '@/lib/csv/normalization';  // same fn weekly uses

async function main() {
  const [csvPath, monthEndDateArg] = process.argv.slice(2);
  // validate args (path exists, date is YYYY-MM-DD)

  const pool = new Pool({ connectionString: process.env.DATABASE_URL! });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');

    // 1. Create temp staging table — exact shape mirror of the weekly
    //    columns needed for the dedup CTE.
    await c.query(`
      CREATE TEMP TABLE staging_monthly_sfr_tmp (
        source_row_number    int NOT NULL,
        search_term_raw      text NOT NULL,
        search_term_normalized text NOT NULL,
        actual_rank          int NOT NULL,
        had_unicode_noise    boolean NOT NULL DEFAULT false
      ) ON COMMIT DROP
    `);

    // 2. Parse CSV, normalize in JS, COPY (or chunked INSERT) into temp.
    //    Track source_row_number from the CSV line number.
    //    For v1, leave had_unicode_noise = false for all rows; the
    //    weekly path's unicode detector can be ported later if we
    //    ever see a real tie that needs it (rare with Amazon BA data).

    // 3. Audit duplicates — mirror inngest/functions/importFile.ts:213-233
    //    but with month_end_date instead of week_end_date, period_type='monthly'.
    await c.query(`
      INSERT INTO import_duplicate_search_terms (
        uploaded_file_id, month_end_date, period_type, search_term_id,
        search_term_normalized, duplicate_count, winning_rank,
        losing_ranks, raw_examples
      )
      SELECT
        NULL,                              -- no uploaded_file row for monthly v1
        $1::date,
        'monthly',
        st.id,
        s.search_term_normalized,
        COUNT(*)::int,
        MIN(s.actual_rank)::int,
        ARRAY_AGG(s.actual_rank ORDER BY s.actual_rank ASC),
        ARRAY_AGG(LEFT(s.search_term_raw, 200) ORDER BY s.actual_rank ASC)
      FROM staging_monthly_sfr_tmp s
      JOIN search_terms st ON st.search_term_normalized = s.search_term_normalized
      GROUP BY st.id, s.search_term_normalized
      HAVING COUNT(*) > 1
    `, [monthEndDate]);

    // 4. Dedup + INSERT — same ORDER BY as weekly importFile.ts:241-247
    const result = await c.query(`
      WITH dedup AS (
        SELECT
          search_term_normalized,
          actual_rank,
          ROW_NUMBER() OVER (
            PARTITION BY search_term_normalized
            ORDER BY
              actual_rank ASC,             -- prefer the row with the lower (better) rank
              had_unicode_noise ASC,       -- false < true: prefer clean rows
              source_row_number ASC        -- final deterministic tiebreak
          ) AS rn
        FROM staging_monthly_sfr_tmp
      )
      INSERT INTO monthly_sfr (
        search_term_normalized, month_end_date, actual_rank, source_filename
      )
      SELECT search_term_normalized, $1::date, actual_rank, $2
      FROM dedup
      WHERE rn = 1
      ON CONFLICT (search_term_normalized, month_end_date)
      DO UPDATE SET
        actual_rank      = EXCLUDED.actual_rank,
        source_filename  = EXCLUDED.source_filename,
        imported_at      = NOW()
    `, [monthEndDate, basename(csvPath)]);

    await c.query('COMMIT');
    console.log(`Inserted/updated ${result.rowCount} rows in monthly_sfr.`);
    // print summary stats: rows read from CSV, unique normalized terms,
    // duplicate groups, audit-log row count
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
    await pool.end();
  }
}
```

- [ ] **Step 0.4: Run on first monthly BA file**

```
pnpm tsx scripts/ingestMonthlySfr.ts data/monthly-ba-2026-04.csv 2026-04-30
```

Sanity check:
- `SELECT COUNT(*) FROM monthly_sfr WHERE month_end_date = '2026-04-30'` — expect ~3M rows minus dedup collisions
- `SELECT COUNT(*) FROM import_duplicate_search_terms WHERE month_end_date = '2026-04-30'` — expect a small number (typically <1% of terms)
- Spot-check a known keyword: `SELECT actual_rank FROM monthly_sfr WHERE search_term_normalized = 'magnesium glycinate' AND month_end_date = '2026-04-30'`

- [ ] **Step 0.5: Commit**

```
feat(db): monthly_sfr table + ingestion script

Separate ingestion path for Amazon's monthly Brand Analytics reports.
Uses the SAME dedup CTE shape as the weekly import path
(inngest/functions/importFile.ts lines 237-261) — ROW_NUMBER() OVER
(PARTITION BY ... ORDER BY actual_rank ASC, had_unicode_noise ASC,
source_row_number ASC). No drift between weekly and monthly dedup
semantics; if the weekly logic evolves we mirror.

Extends import_duplicate_search_terms with period_type discriminator
+ month_end_date column so weekly and monthly forensic audits coexist
in one table.

Primary use: provides the monthly SFR side of the (rank, volume)
calibration pairs against poe_calibration_data.
```

---

## Task 1: Migration — POE calibration + model history tables

**Files:**
- Create: `db/migrations/00XX_poe_calibration_data.sql`
- Create: `db/schema/poeCalibrationData.ts`
- Create: `db/schema/modelCalibrationRuns.ts`
- Modify: `db/schema/index.ts`

- [ ] **Step 1.1: Write the migration**

```sql
-- Calibration sample: keywords for which the user has pulled Amazon POE
-- (Product Opportunity Explorer) data. Used to fit the rank-to-volume
-- power-law model. Keyed by normalized search term so it joins cleanly
-- to search_terms.search_term_normalized.

CREATE TABLE poe_calibration_data (
  search_term_normalized   text PRIMARY KEY,
  poe_360_day_volume       bigint NOT NULL,
  -- Optional shorter-window POE volumes — fill what the user provides.
  poe_30_day_volume        bigint,
  poe_60_day_volume        bigint,
  poe_90_day_volume        bigint,
  poe_180_day_volume       bigint,
  -- Provenance + freshness
  source_filename          text,
  imported_at              timestamptz NOT NULL DEFAULT now()
);

-- One row per model-fit run. Latest row by fitted_at is the "live"
-- model used by refreshSummary. History lets us see whether β drifts
-- over time and compare model versions.

CREATE TABLE model_calibration_runs (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fitted_at                timestamptz NOT NULL DEFAULT now(),
  -- Fitted parameters
  beta                     numeric(6,4) NOT NULL,
  scale_factor             numeric(20,6) NOT NULL,
  -- Sample size + train/holdout split
  n_training_keywords      integer NOT NULL,
  n_holdout_keywords       integer NOT NULL,
  -- Validation metrics (median absolute % error by rank band)
  mape_overall             numeric(5,2),
  mape_top_1k              numeric(5,2),
  mape_1k_10k              numeric(5,2),
  mape_10k_100k            numeric(5,2),
  mape_above_100k          numeric(5,2),
  -- Free-form notes for the analyst
  notes                    text
);

CREATE INDEX model_calibration_runs_latest_idx
  ON model_calibration_runs (fitted_at DESC);
```

- [ ] **Step 1.2: Drizzle schema files + journal entry + apply migration**

Mirror the Task 1 pattern from the Keepa enrichment plan (drizzle defs, journal append, `pnpm db:migrate`).

- [ ] **Step 1.3: Commit**

```
feat(db): poe_calibration_data + model_calibration_runs tables

Foundation for the SFR-based search volume estimator. POE table holds
the user's calibration sample (keywords with known Amazon search
volume); runs table holds the history of fitted (β, A) parameters
so refreshSummary can always read the latest live model.
```

---

## Task 2: CSV ingestion script for POE data

**Files:**
- Create: `scripts/ingestPoeCalibration.ts`

- [ ] **Step 2.1: Write the script**

Reads a CSV from a path argument, validates columns, normalizes the search term using the same canonical form as `search_terms.search_term_normalized`, INSERTs/UPSERTs into `poe_calibration_data`. Reports rows inserted, rows updated, rows skipped due to validation errors. Idempotent (`ON CONFLICT (search_term_normalized) DO UPDATE`).

Expected CSV format (locked in via brainstorming):

```
search_term,poe_360_day_volume,poe_180_day_volume,poe_90_day_volume,poe_30_day_volume
"magnesium glycinate",450000,225000,112000,38000
"berberine supplement",380000,...
```

Validations:
- `search_term` non-empty after trim
- All `poe_*` columns non-negative integers (or null for missing)
- Duplicate `search_term_normalized` within the CSV → keep highest `poe_360_day_volume` (or error — TBD via brainstorming)

- [ ] **Step 2.2: Run ingestion on the user's sample**

```
pnpm tsx scripts/ingestPoeCalibration.ts data/poe-sample-2026-05-XX.csv
```

Expected: ~1K-5K rows inserted, near-zero validation failures.

- [ ] **Step 2.3: Commit**

---

## Task 3: EDA — log-log scatter and basic stats

**Files:**
- Create: `scripts/runVolumeModelEda.ts`

This is the **30-minute sanity check** before fitting anything. If the relationship between SFR-sum and POE volume isn't roughly linear on log-log axes, no fitting trickery saves the model — we'd need a different functional form (piecewise, logistic, exponential decay).

- [ ] **Step 3.1: Write the script**

For each keyword in `poe_calibration_data` with sufficient SFR history (≥40 of 52 weeks in `kwm`):

1. Compute `annual_signal = Σ(weekly_SFR^-β)` for a few candidate β values (0.5, 0.7, 0.9 — to see how the shape changes).
2. Output a TSV: `search_term, poe_360_day_volume, annual_signal_at_β_0.5, ..._β_0.7, ..._β_0.9, n_weeks_present`
3. Print summary stats: median POE volume, median signal value, Pearson correlation in log space.

Save as `out/volume-model-eda-{date}.tsv` for the analyst to plot externally (or pipe through a quick gnuplot / Python notebook).

- [ ] **Step 3.2: Run the EDA, eyeball the log-log plot**

Open the TSV in a notebook or spreadsheet, plot `log(POE)` vs `log(annual_signal_at_β_0.7)`. Look for:
- Roughly straight line → single-β power law fits. Proceed to Task 4.
- Clear curvature → piecewise β by rank band needed. Adjust Task 4 scope.
- High noise / no relationship → bigger problem; pause and consult.

- [ ] **Step 3.3: Commit**

---

## Task 4: Fit the model

**Files:**
- Create: `lib/analytics/volumeModel.ts`
- Create: `lib/analytics/volumeModel.test.ts`
- Create: `scripts/fitVolumeModel.ts`

- [ ] **Step 4.1: Write `lib/analytics/volumeModel.ts`**

Three pure functions:

```ts
// Compute the annual demand signal for a given keyword.
export function annualSignal(weeklySfrs: number[], beta: number): number;

// Given fitted (β, A), estimate annual volume for any keyword.
export function estimateAnnualVolume(weeklySfrs: number[], beta: number, scaleFactor: number): number;

// Given fitted (β, A) and a single week's SFR, estimate that week's volume.
export function estimateWeeklyVolume(weekSfr: number, beta: number, scaleFactor: number): number;
```

All pure. All unit-tested in `volumeModel.test.ts` with known inputs.

- [ ] **Step 4.2: Write `scripts/fitVolumeModel.ts`**

1. Load the calibration set: join `poe_calibration_data` ⋈ `kwm` on normalized term, collect 52 weekly SFRs per keyword. Filter to keywords with ≥40 of 52 weeks reported.
2. 70/30 train/holdout split, stratified by POE volume decile.
3. Grid-search β in [0.40, 1.20] step 0.025.
4. For each β candidate:
   - Compute `annual_signal_i = Σ SFR_w^-β` for each training keyword
   - Fit log-space linear regression: `log(POE_i) = log(A) - β' × log(annual_signal_i)` — but actually since β is already inside the signal, we just need `log(A)`: `log(POE_i) - log(annual_signal_i) = log(A)`, so `log(A) = mean(log(POE_i) - log(annual_signal_i))`.
   - Compute predicted volume on holdout. Compute MAPE overall and by rank band (top-1K / 1K-10K / 10K-100K / 100K+).
5. Choose β that minimizes holdout MAPE.
6. INSERT a row into `model_calibration_runs` with (β, A, n_training, n_holdout, MAPE_*).

Output a summary table to console.

- [ ] **Step 4.3: Validate**

Check the final `model_calibration_runs` row. Expectations from GPT analysis:
- β ∈ [0.60, 0.90] very likely
- MAPE ≤ 50% in the 1K-10K band would be a useful model; ≤ 30% would be excellent
- If MAPE > 100% in the band you care about, the model is not yet useful — investigate before proceeding

- [ ] **Step 4.4: Commit**

---

## Task 5: Schema additions — `estimated_weekly_volume` on kwm + `*_current` on kcs

**Files:**
- Create: `db/migrations/00XX_estimated_volume_columns.sql`
- Modify: `db/schema/keywordWeeklyMetrics.ts`
- Modify: `db/schema/keywordCurrentSummary.ts`

```sql
ALTER TABLE keyword_weekly_metrics
  ADD COLUMN estimated_weekly_volume bigint;

ALTER TABLE keyword_current_summary
  ADD COLUMN estimated_weekly_volume_current bigint,
  -- Trailing 4-week sum (the headline "monthly" estimate)
  ADD COLUMN estimated_monthly_volume_current bigint;

-- No index — these are read alongside other kwm columns via the
-- existing rank-covering indexes; adding a dedicated index would
-- bloat writes without speeding up our typical reads.
```

Drizzle defs, journal, migrate, commit.

---

## Task 6: Backfill — populate kwm.estimated_weekly_volume across all 52 weeks

**Files:**
- Create: `scripts/backfillEstimatedVolumes.ts`

- [ ] **Step 6.1: Write the script**

For every kwm row with a non-null `actual_rank`:
- Look up the latest (β, A) from `model_calibration_runs`
- Compute `estimateWeeklyVolume(actual_rank, β, A)`
- For keywords WITH `poe_calibration_data`: instead, allocate the POE annual volume across weeks using SFR-share: `weekly_share_w = SFR_w^-β / Σ SFR_all^-β`, then `weekly_volume = POE_360 × weekly_share`. Stamp those rows as POE-derived.
- UPDATE kwm with the result.

Chunked by week to keep transactions reasonable. ~3M rows expected; chunks of 100K. Maybe 10-20 min on Neon.

- [ ] **Step 6.2: Run + verify**

Spot-check: pick 5 keywords across rank bands, compare their estimated weekly + monthly volume to intuition / known POE values. Pick keywords WITH POE — those should match POE×SFR-share exactly.

- [ ] **Step 6.3: Commit**

---

## Task 7: Integrate into refreshSummary

**Files:**
- Modify: `inngest/functions/refreshSummary.ts`

Inside the kcs stage build, add population of `estimated_weekly_volume_current` and `estimated_monthly_volume_current`:

- `estimated_weekly_volume_current` = the `estimated_weekly_volume` from the most recent kwm row per term (already pulled in `latest_per_term` — just add the field)
- `estimated_monthly_volume_current` = sum of `estimated_weekly_volume` from the most recent 4 kwm rows per term

After the kcs swap, no extra step needed — the values are baked into kcs.

- [ ] **Step 7.1: Modify `stageLatestPerTerm`**

Add `k.estimated_weekly_volume` to the SELECT list.

- [ ] **Step 7.2: Add a new staging CTE for trailing-4-week sum**

```sql
CREATE TEMP TABLE trailing_4w_volume ON COMMIT DROP AS
WITH ref AS (
  SELECT MAX(week_end_date)::date AS current_week
  FROM reporting_weeks WHERE is_complete = true
)
SELECT
  k.search_term_id,
  SUM(k.estimated_weekly_volume)::bigint AS volume_4w
FROM keyword_weekly_metrics k, ref
WHERE k.week_end_date >= ref.current_week - INTERVAL '21 days'
  AND k.week_end_date <= ref.current_week
GROUP BY 1;
CREATE INDEX ON trailing_4w_volume (search_term_id);
```

- [ ] **Step 7.3: Update the kcs stage INSERT to include both new columns**

- [ ] **Step 7.4: Commit + run an ad-hoc refresh to verify**

---

## Task 8: Explorer column

**Files:**
- Modify: `app/explorer/page.tsx`
- Modify: `lib/explorer/runQuery.ts`
- Create: `app/explorer/EstimatedVolumeCell.tsx`

- [ ] **Step 8.1: Add the column to the query**

`runQuery.ts` SELECTs `estimated_monthly_volume_current` from kcs.

- [ ] **Step 8.2: Create the formatter**

`EstimatedVolumeCell` formats `estimated_monthly_volume_current` as human-readable. Examples:
- `null` → `—`
- `0 - 999` → `<1K`
- `1,000 - 9,999` → `1.2K`
- `10,000 - 99,999` → `12K`
- `100,000+` → `120K` or `1.2M`

- [ ] **Step 8.3: Wire into the explorer table**

Add the column with header "Est. monthly searches" or similar. Sortable. Default visible.

- [ ] **Step 8.4: Commit**

---

## Task 9: Detail page surface

**Files:**
- Modify: `app/explorer/keyword/[id]/page.tsx`

- [ ] **Step 9.1: Pull `estimated_weekly_volume` for this keyword from kwm (all 52 weeks)**

Already there — just include in the existing kwm fetch.

- [ ] **Step 9.2: Render headline numbers**

Above the existing rank chart, show:
- "Est. searches this week: 12,340"
- "Est. searches last 30 days: 47,200"

Could also add a tiny sparkline of weekly volume across the 52 weeks. Optional polish.

- [ ] **Step 9.3: Commit**

---

## Constraints / non-goals

- **No machine learning beyond power-law fitting.** No neural nets, no gradient boosters. The signal is monotonic and well-modeled by a simple power law; complex models would add noise without value at this sample size (~1K-5K calibration keywords).
- **No fuzzy term matching in v1.** Exact match on `search_term_normalized`. Fuzzy via `looseMatch` only if exact-match misses too much of the calibration set.
- **No seasonality adjustment in v1.** A "rank 100 in December" is treated equivalently to "rank 100 in May." Known limitation; revisit if predictions are systematically off for seasonal categories.
- **No confidence intervals shown to users in v1.** The model gives a point estimate. Showing CIs would require a different fitting approach (Bayesian or bootstrap) and more UI work.
- **No POE upload UI in v1.** CSV → script → ingest. UI upload is v2 polish.
- **Recalibration is manual in v1.** Run `fitVolumeModel.ts` whenever the analyst wants. No automatic re-fit cadence.

---

## Future work (out of scope for this plan)

- **POE upload UI** flow (mirroring the SFR upload).
- **Automatic re-fit cadence** (e.g., monthly, after fresh POE data ingestion).
- **Piecewise-β model** if EDA shows curvature.
- **Confidence intervals** as a visible signal.
- **Day-aligned 360-day windowing** for cleaner POE matching.
- **Seasonality-adjusted weekly signal** for categories where week-to-week absolute volume varies a lot.
- **Cross-validation by category** to surface where the model fits well vs poorly.

---

## What success looks like

- `poe_calibration_data` populated with ~1K-5K rows from the user's sample.
- `model_calibration_runs` has at least one row; `β` is in a plausible range (0.6–0.9); MAPE on the 1K-10K rank band is ≤ 50%.
- Every kwm row with a non-null `actual_rank` has a populated `estimated_weekly_volume`.
- Explorer table shows estimated monthly search volume as a default column, formatted readably.
- Keyword detail page shows current-week and trailing-month estimated volumes prominently.
- Spot-check: 5 known keywords (with POE values for cross-reference) report estimated volumes within 25% of their POE-derived expectations.
- Re-running `fitVolumeModel.ts` is idempotent (writes a new row to `model_calibration_runs`, doesn't break the live model).
