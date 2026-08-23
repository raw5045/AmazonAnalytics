# Category Covering Index — Design Spec

**Date:** 2026-08-23
**Status:** Approved direction (owner: "begin planning the best way to implement
this and proceed when ready"); details below pending owner spec review
**Scope:** Make category-scoped filtered explorer queries structurally fast
when cold: a covering index + a two-stage query shape so the filtering phase
reads dense, contiguous index pages instead of tens of thousands of scattered
heap pages. Plus a stored `word_count` column (replacing the query-time
expression) so word filters are coverable.

## Motivation — all measured on prod, 2026-08-23

- Owner-experienced 30–60s: custom-category + selective-filter searches after
  each weekly rebuild (and after each 6h series-sweep cache wipe).
- Mechanism: a 206-leaf category covers ~40k kcs rows scattered across ~36k
  heap pages (~281MB); selective filters must examine most of them; cold =
  one page fetch each.
- Cache cannot absorb it: Neon LFC = **819MB** vs kcs = **5.3GB** (heap 2.9GB)
  and series = 10GB; the 6h series sweep churns the entire LFC 4×/day.
- No cheaper warming target exists: heap↔rank correlation ≈ **0** (top-100k
  ranks span 585MB); ordinary rank-sorted browses already terminate after
  ~101 page touches and are fine cold.
- Warming was evaluated and REJECTED as a bridge (would consume 44% of LFC
  and scale badly); owner chose the structural fix instead.

## Decisions

| Question | Decision |
|---|---|
| Query shape | **Two-stage, category-scoped path only** (`leafPaths.length > 0`): inner index-only subquery filters + sorts + limits over covered columns and returns `search_term_id` (+ sort keys); outer query joins back to kcs by PK (≤101 rows) + search_terms for display columns. Counts run over the inner covered scan. Non-category queries keep today's single-stage shape unchanged |
| Coverage gate | The covered path is used ONLY when every active sort + filter is covered: sorts `rank`/`rank_desc`; filters severity (always on), rankMin/Max, reviewsMin/Max, wordsMin/Max. Anything else active (q, jumps, title filters, vol-delta/price/reviews/added sorts) → today's path. Explicit `categoryPathIsCovered(filters)` helper, unit-tested, defaulting safe |
| Index shape | `(current_week_end_date, top_clicked_category_path, current_rank) INCLUDE (fake_volume_severity_current, avg_reviews, word_count, search_term_id)` — keys make per-path entries rank-adjacent; includes cover the always-on severity predicate + the range filters + the join id. Est. 350–500MB (path keys dedup across ~13+ rows/path) |
| Twins | Index created on BOTH `keyword_current_summary` and `_stage` (0044 pattern — RENAME swaps table names, indexes ride along). Maintained incrementally during the stage INSERT first; if `import_phase_timings` shows unacceptable cost, fallback optimization = drop-before-load / rebuild-after (the trigram GIN already does this) |
| word_count | New `smallint` column on both tables, `NULL`able. Populated by the weekly refresh INSERT (spaces+1 on `search_term_normalized`); one-time gated batched backfill + VACUUM fills existing rows. The words filter predicate flips from the expression to `kcs.word_count` ONLY after the backfill verifies 0 NULLs (no window where the filter lies) |
| Visibility map | **Hard requirement**: index-only scans silently degrade to heap checks unless the table is vacuumed after bulk load. The refresh must run `VACUUM ANALYZE` on the stage table post-INSERT (verify existing step; add if missing). Probes assert `Heap Fetches: 0`-ish |
| Migration | 0046 (raw SQL + gated apply script per convention). `CREATE INDEX CONCURRENTLY` on the live table (no write lock); plain CREATE on stage (idle between refreshes) |

## Part 1 — Migration 0046 + backfill

1. `ALTER TABLE keyword_current_summary ADD COLUMN word_count smallint;`
   (same on `_stage`). Plain nullable add — instant, no rewrite.
2. Covering index on both tables (`kcs_cat_cover_idx` / `kcs_stage_cat_cover_idx`),
   CONCURRENTLY on live.
3. Drizzle schema updated (column; index breadcrumb comment — expression-free
   b-tree, so it CAN be declared in schema like the 0030-era indexes).
4. Separate gated backfill script: batched `UPDATE ... SET word_count = <expr>
   WHERE word_count IS NULL` (10–50k/batch), then `VACUUM ANALYZE` both
   tables, then assert 0 NULLs on live. (Batched + vacuumed per the July
   mass-UPDATE bloat lesson.)

## Part 2 — Refresh integration (`inngest/functions/refreshSummary.ts`)

- The stage INSERT's SELECT adds the word-count expression as `word_count`.
- Verify/add `VACUUM ANALYZE keyword_current_summary_stage` after the INSERT
  (before or after swap — the visibility map rides the RENAME).
- `import_phase_timings` will show the index-maintenance delta on the next
  import; report vs the ~272-minute baseline (vol-delta precedent: +36s for
  ten small partials; this one is bigger — expect single-digit minutes, and
  the drop/rebuild fallback exists if it surprises).

## Part 3 — Query builder (`lib/explorer/buildQuery.ts`)

- New covered path gated by `leafPaths.length > 0 && categoryPathIsCovered(f)`:

```sql
-- inner (index-only): filter + sort + page over covered cols
SELECT search_term_id, current_rank
FROM keyword_current_summary kcs
WHERE kcs.current_week_end_date = $1
  AND kcs.top_clicked_category_path IN (...)
  AND <severity predicate>            -- covered include
  AND <rank/reviews/word bounds>      -- covered includes/keys
ORDER BY kcs.current_rank ASC|DESC
LIMIT $n OFFSET $m
-- outer: PK join back for display columns + search_terms, preserving order
```

- Count = `SELECT COUNT(*)` over the same inner WHERE (capped subquery as
  today) — also index-only.
- The words predicate (all paths, not just covered) flips from
  `wordCountExpr(...)` to `kcs.word_count` (post-backfill deploy). The
  exported `wordCountExpr` remains ONLY inside the refresh INSERT and the
  backfill script.
- Canonical-string tests pin: the covered inner shape; the coverage gate
  falling back for each non-covered sort/filter; count parity; existing
  non-category paths byte-unchanged.

## Part 4 — Verification (pre-ship, prod)

1. EXPLAIN (ANALYZE, BUFFERS) on the owner's real combos (206-leaf category ×
   {3+ words + ≤500 reviews, 1-word + ≤500 reviews, no extra filters}):
   assert **Index Only Scan** on the covering index with Heap Fetches ≈ 0,
   and cold latency target **< 2s** (vs 30–60s today).
2. Fallback combos (category + vol-delta sort; category + q) still use
   today's plans (no regression).
3. Post-first-weekly-import re-probe: confirms the refresh VACUUM keeps
   index-only behavior on the fresh table (the silent-degrade trap).

## Non-goals (V1)

- No coverage of vol-delta/price/added sorts or jump/title filters in the
  covered path (fallback handles them; adding includes later = index v2).
- No change to broad-category (`category`) or non-category query paths.
- No cache warming (this arc removes the need).
- No word-count column exposure in UI/sorts (future freebie).

## Ship checklist (owner-gated)

1. Spec review (this doc) → plan → subagent-driven implementation.
2. Migration 0046 apply (owner-gated DDL; CONCURRENTLY on live).
3. Backfill script run (owner-gated; batched + VACUUM; assert 0 NULLs).
4. Code deploy (covered path + predicate flip) after 2–3 verified.
5. Prod probes (Part 4.1–4.2) reviewed with the owner — timings reported.
6. Next weekly import: refresh delta from `import_phase_timings` + Part 4.3
   re-probe reported.
