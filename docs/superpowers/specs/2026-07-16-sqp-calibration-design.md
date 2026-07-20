# SQP-Primary Rank→Volume Recalibration — Design Spec

**Date:** 2026-07-16
**Status:** Approved (brainstormed with the owner; EDA-driven)
**Scope:** Add the owner's Brand Analytics **Search Query Performance (SQP)** monthly
export as a first-party calibration source, make it the training source for the
rank→volume fit (POE demoted to validation-only), and refit. No explorer/UI changes —
recalibrated estimates flow into every consumer (kcs refresh, detail pages, Δ-vol
sorts) through the existing fit machinery.

## Evidence (EDA, week ending 2026-07-11 — `scripts/edaSqp0711.ts`, throwaway)

Owner's brand (Double Wood Supplements) SQP weekly export, 960 unique queries,
**848 matched (88.3%)** that week's SFR across every band (16 pairs ≤1k incl. ranks
12/29; 78 in 1k–10k; 754 beyond). Findings that drive this design:

- **Head is shape-correct, level ~25% hot:** rank 12 ("magnesium glycinate") SQP
  ⇒ ~2.0M/mo vs our 2.49M (ratio 1.24); band ≤100 ratio 1.26; 101–1k ratio 1.32.
  SQP's own head slope (−0.42, rank ≤1k) matches the production head shape.
- **Mid-tail is the real overshoot:** ratios 1.76 (1k–10k), 1.92 (10k–100k),
  1.64 (>100k) — inherited from POE, whose volumes run 1.5–1.75× hotter than SQP
  in those bands. At the head the two sources agree within 4%.
- Production fit's calibration month is 2026-04-30 (stale).
- SQP's "Search Query Volume" is marketplace-wide unique-customer query counts
  (not brand-scoped); monthly exports count uniques over the month directly, so no
  weekly→monthly approximation is needed.

## Decisions (owner-approved)

| Question | Decision |
|---|---|
| Truth source | **SQP-primary**: fit trains on SQP ⋈ monthly_sfr pairs; **POE becomes validation-only** (secondary MAPE in the run report, never training) |
| Cadence | **Monthly SQP exports**, paired via the existing `monthly_sfr` table — same pipeline shape as POE today |
| Fit shape | Unchanged: anchored 4-segment piecewise power law, breakpoints 1k/10k/100k, iterative outlier trimming, Fresh-category exclusions, 70/30 holdout, MAPE by rank band |
| Anchor | Lowest-SFR **SQP** pair of the calibration month (rank ~12-class, first-party) instead of the lowest POE pair |
| Ingestion UX | New SQP file slot on the existing admin calibration-upload page, alongside BA monthly SFR + POE |
| Go-live | Fit runs support **dry-run** (compute + full report, no persist). Persisting a run is the owner-gated go-live step: `pickFitForWeek`/refresh/detail pages read persisted runs, so a persisted fit affects detail-page renders immediately and kcs at the next weekly refresh |

## Part 1 — Schema (migration 0045)

`sqp_calibration_data`, a structural mirror of `poe_calibration_data`:

```sql
CREATE TABLE sqp_calibration_data (
  search_term_normalized text NOT NULL,
  month_end_date         date NOT NULL,
  sqp_monthly_volume     bigint NOT NULL,
  source_filename        text,
  imported_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (search_term_normalized, month_end_date)
);
CREATE INDEX sqp_calibration_volume_idx ON sqp_calibration_data (sqp_monthly_volume);
CREATE INDEX sqp_calibration_month_idx  ON sqp_calibration_data (month_end_date);
```

Drizzle schema `db/schema/sqpCalibrationData.ts` + index.ts export. Hand-numbered
raw-SQL migration + gated apply script per convention (owner applies).

## Part 2 — SQP CSV parser + ingestion

Format (validated against the owner's real export today):
line 1 = metadata (`Brand=[…],Reporting Range=[…],Select week=[…]`), line 2 = quoted
header incl. `"Search Query"` and `"Search Query Volume"`, then quoted data rows.
Parser: RFC-4180 quoted-field handling; term → `normalizeForMatch`; volume →
integer (strip commas defensively); on duplicate normalized terms keep MAX volume.
Reject files missing either required column. Monthly exports carry a
`Select month` metadata key — parse the month when present and surface it as the
suggested `month_end_date`; the admin form field remains authoritative (mirroring
how the POE upload assigns its month).

Ingestion mirrors the POE path: upsert by PK (idempotent re-upload), provenance
filename, admin upload slot on the existing calibration page with the same
month-selector the BA+POE flow uses. The auto-fit-after-upload hook moves to the
SQP upload (in dry-run→report mode; see Part 3); the old POE-triggered auto-fit is
retired — a POE upload now just stores validation data (POE no longer trains).

## Part 3 — Fit orchestrator changes (`lib/volumeModel/fitOrchestrator.ts`)

- Training pairs: `sqp_calibration_data ⋈ monthly_sfr` on (term, month) — replacing
  the POE join. Category exclusions (`EXCLUDED_CATEGORIES_FROM_FIT`) still apply.
- Anchor: lowest-SFR SQP pair of the month.
- Validation additions to the result/report: alongside the existing holdout MAPE
  bands, compute **MAPE vs POE pairs of the same month** (when present) as a
  secondary cross-category signal, and **per-band level delta vs the current
  production fit** (median predicted-volume ratio per band) so the owner sees
  exactly what will change before go-live.
- `persist` becomes explicit: dry-run computes everything and reports; persist
  writes `model_calibration_runs` (go-live). CLI (`scripts/fitVolumeModel.ts`) and
  the upload-triggered worker path both default to dry-run; persisting requires the
  explicit flag/action (owner-gated).
- **Head extrapolation above the anchor** (owner-raised): ranks better than the
  month's best SQP pair (~rank 12-class) are extrapolation territory — but small
  (≈11 terms marketplace-wide) and bounded (monotone by construction; with the
  measured head slope −0.42, rank 1 ≈ 2.8× the anchor). One principled exception
  to POE-never-trains: **POE pairs at ranks better than the SQP anchor are
  admitted as supplemental head training pairs** — the ≤100 band is where the two
  sources measured within 4% of each other, and SQP is structurally blind there
  (the owner's brand terms never include Amazon's overall top-10). This brackets
  extrapolation to roughly ranks 1–4 (POE's best pair is rank 5). The run report
  prints the implied rank-1 volume each month as the owner's gut-check.
- **Ultra-head damping (owner decision 2026-07-16, post-dry-run review):** the
  1-to-anchor zone is pure slope extrapolation and the available signals disagree
  (global head slope ⇒ #1 ≈ 6.8M; a literal anchor↔POE-rank-5 line ⇒ ≈10M; the
  owner's market judgment ⇒ 4–5M tops). Resolution: an explicit judgment
  parameter. After the anchored grid search, the fit gains an **ultra-head
  segment** covering ranks ≤ anchor.rank — breakpoint prepended at the anchor
  rank, β = `ultraHeadBeta` (default **0.30**, CLI `--ultra-head-beta`,
  `none`/null disables), scale factor continuity-matched to the fit's own value
  at the anchor (no seam). Recorded in `fit_params.ultraHeadBeta` (additive
  jsonb field; all consumers walk breakpoints/segments generically, zero reader
  changes). Reports print the damped implied rank-1 alongside the undamped
  value. Accepted trade: at β=0.30 the rank-5 prediction sits ~13% below POE's
  observed rank-5 point. Self-correcting: months where a brand term ranks
  higher shrink the judgment zone automatically. Skipped when anchor.rank ≤ 1.
- The trim heuristic (10× under-trim, tuned for POE under-reporting) is kept but
  its threshold becomes a named parameter recorded in `fit_params` (it already
  records `trimDropRatio`); the first SQP fit reports how many pairs it dropped so
  we can judge whether the heuristic still earns its keep on first-party data.

## Part 4 — Expected outcome + acceptance

- Level: head ~−20%, mid-tail ~−40–50% vs today (per the EDA ratios).
- Acceptance for go-live (owner judgment, informed by the report): holdout MAPE
  per band ≤ current production fit's recorded MAPEs where comparable; anchor is a
  sub-100-rank SQP pair; POE-validation MAPE reported (expected worse than holdout
  — different units — the signal is drift over months, not absolute level).
- After persist: detail pages reflect immediately; kcs estimates + Δ-vol sort at
  the next weekly refresh; `import_phase_timings` unaffected.

## Ship checklist (owner-gated)

1. Migration 0045 applied via gated script (DDL confirmation).
2. Owner pulls the **monthly SQP export** for the newest month with `monthly_sfr`
   loaded (June 2026 expected) and uploads via the new slot (or hands me the file).
3. Dry-run fit → review the report together (bands, anchor, trim count, POE MAPE,
   level deltas).
4. Owner approves → persist → spot-check a few detail pages + the Δ-vol sort's
   top improvements against SQP-console intuition.
5. Next weekly import: confirm kcs estimates moved as predicted.

## Non-goals

- No weekly-SQP ingestion path (monthly chosen; weekly stays an EDA/audit tool).
- No changes to explorer/watchlist UI, jump filters, digest, or the volume-delta
  sort machinery (it consumes recalibrated stored volumes untouched).
- No POE ingestion removal — POE uploads continue as validation data.
- No third-party "search volume" sources: Keepa is product-level only (no keyword
  volume), and tool-estimated volumes (Helium 10 etc.) are themselves modeled from
  BA SFR — circular against our SFR-based model. SQP is Amazon's own count.
