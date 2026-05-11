# Loose-match backfill perf — update for review

## TL;DR

We implemented the loose-match logic + perf changes you recommended in
the prior RFC (search_term_normalized as the search-side input,
plural-candidate forms, exception-list guards, strict-true shortcut,
MATERIALIZED CTE, per-week temp title-token cache, count-based resume
marker). Functional correctness is solid — 20 cross-check fixtures
pass JS↔SQL.

But the **performance got worse, not better**. The single-week trial
ran for 35+ minutes still stuck building the per-week temp title
cache (it never reached the UPDATE), at which point we killed it.

Cost-component diagnostic on a 10k-row sample of one week:

| Step | What | Time | Per row |
|---|---|---|---|
| A | Pure compute (SELECT only, no writes), 2 slots | 13.4 sec | 1.34 ms |
| B | UPDATE 1 col to NULL — pure write cost | 11.4 sec | 1.14 ms |
| C | MATERIALIZED CTE shape (production-like) | 0.9 sec, 0 rows | (collateral — see below) |

Step A means just **computing** the loose flags for 2 slots costs
~1.34 ms/row. Extrapolated: 2.6M rows × ~2.0 ms/row (3 slots) ≈
~87 min/week of pure CPU. The wide-row write cost on top is another
~50 min/week if HOT fires. **~140 min/week × 55 weeks ≈ 130 hours**
in the worst case.

That's much worse than the original (buggy) backfill, which managed
14-16 min/week with inline regex and no temp tables. Our previous
estimate of "≤3 hours total" was off by 10–40×.

We want feedback on:

1. **Did we mis-implement** the title-cache + MATERIALIZED CTE
   approach, or is the diagnostic showing a real ceiling?
2. **Which option** below should we pursue?
3. **One real bug** we caught via the diagnostic: a partition-pruning
   problem in our UPDATE WHERE clause (described below). Is the fix
   we have in mind sufficient?

---

## What we built (per the prior RFC's plan)

- Migration 0015: five `IMMUTABLE PARALLEL SAFE` Postgres functions
  - `loose_token_forms(token text) → text[]` — plural candidates
  - `loose_search_tokens(normalized_term text) → text[]` — tokenize + stopword filter
  - `loose_title_forms(title text) → text[]` — normalize + tokenize + flatten plural candidates
  - `loose_match(text[], text[]) → boolean` — every search token (via any candidate) ∈ title forms
  - `loose_match_raw(text, text) → boolean` — convenience wrapper
- `lib/analytics/looseMatch.ts` — JS mirror; 20 vitest fixtures
- `scripts/verifyLooseMatchSql.ts` — JS↔SQL cross-check on those fixtures (all pass)
- Plural rules per your review: candidate forms, exact-word exceptions
  for `gas/news/hers/ours/yours/lens/series/species/keys`, suffix guards
  only on `ss/us/is` (`rs` and `as` dropped per your call).
- Import path refactored to use the new functions via a `prepared` +
  `with_flags` two-CTE structure that hoists search-side tokenization
  and computes `f1/f2/f3` once.
- Backfill script rewritten:

  ```sql
  -- Per week, in one TCP-pinned connection:
  CREATE TEMP TABLE tmp_title_forms ON COMMIT DROP AS
  WITH distinct_titles AS (
    SELECT top_clicked_product_1_title AS title FROM keyword_weekly_metrics WHERE week_end_date = $1 AND title IS NOT NULL
    UNION
    SELECT top_clicked_product_2_title FROM keyword_weekly_metrics WHERE week_end_date = $1 AND title IS NOT NULL
    UNION
    SELECT top_clicked_product_3_title FROM keyword_weekly_metrics WHERE week_end_date = $1 AND title IS NOT NULL
  )
  SELECT title, loose_title_forms(title) AS forms FROM distinct_titles;
  CREATE INDEX ON tmp_title_forms (title);
  ANALYZE tmp_title_forms;

  WITH computed AS MATERIALIZED (
    SELECT
      kwm.ctid,
      CASE WHEN kwm.top_clicked_product_1_title IS NULL THEN NULL
           WHEN kwm.keyword_in_title_1 IS TRUE THEN TRUE
           ELSE loose_match(loose_search_tokens(st.search_term_normalized), t1.forms)
      END AS f1,
      /* f2, f3 similarly */
    FROM keyword_weekly_metrics kwm
    JOIN search_terms st ON st.id = kwm.search_term_id
    LEFT JOIN tmp_title_forms t1 ON t1.title = kwm.top_clicked_product_1_title
    LEFT JOIN tmp_title_forms t2 ON t2.title = kwm.top_clicked_product_2_title
    LEFT JOIN tmp_title_forms t3 ON t3.title = kwm.top_clicked_product_3_title
    WHERE kwm.week_end_date = $1::date
      AND kwm.keyword_title_match_count_loose IS NULL
  )
  UPDATE keyword_weekly_metrics kwm
  SET keyword_in_title_1_loose = c.f1,
      keyword_in_title_2_loose = c.f2,
      keyword_in_title_3_loose = c.f3,
      keyword_title_match_count_loose = (
        COALESCE(c.f1::int,0) + COALESCE(c.f2::int,0) + COALESCE(c.f3::int,0)
      )::smallint
  FROM computed c
  WHERE kwm.ctid = c.ctid;  -- ← BUG: no partition pruning
  ```

- 6 already-buggy-backfilled weeks were reset (loose cols → NULL)
  before re-running. The reset itself took 68 min total (~11 min/week
  average); also a wide-row UPDATE.

## What happened on the trial run

Target: backfill week 2025-08-30 (~2.6M rows). Expected ≤5 min based
on "title cache 16-80× reduction in title-side CPU."

Result: at minute 35, still building the temp title cache (active
backend showed wait_event `Neon/FileCache_Write` during cache build,
then `Neon/Prefetch` during scan — never advanced to the UPDATE).
Killed it.

## Cost-component diagnostic

To understand where time was going, ran a 10k-row scoped diagnostic
on the same week — built a sample temp table, then ran:

  A. SELECT-only compute over the sample (no UPDATE)
  B. UPDATE one column to NULL (no compute — pure write cost)
  C. Production MATERIALIZED-CTE UPDATE on the sample

Results (10k rows):

  A. SELECT-only compute (2 slots):  13,394 ms = 1.34 ms/row
  B. UPDATE 1 col to NULL:           11,405 ms = 1.14 ms/row
  C. Production CTE shape:              876 ms = (rows=0)

(For Step C, the inner UPDATE matched 0 rows because Step B had
already moved the tuples to new ctids — a known property of MVCC. The
diagnostic intentionally rolls back at the end, so no data was
mutated permanently. But the 876ms cost is essentially the scan-only
cost since no actual writes happened — it's not directly comparable
to A or B.)

**Per-row cost interpretation:**

- Compute alone (3 slots): ~2.0 ms/row × 2.6M rows = ~87 min/week
- Write alone (assuming HOT fires): ~1.14 ms/row × 2.6M rows = ~50 min/week
- Without HOT (5 indexes/partition need updating): probably 2-3× slower writes

**Real-world floor: ~140 min/week ≈ 130 hours for 55 weeks.**

For comparison, the original (buggy) backfill achieved 14-16 min/week
using inline regex `regexp_replace(LOWER(text), '[^a-z0-9]+', ' ', 'g')`
without any temp table. That's ~13 hours total — way faster, but
wrong on apostrophes and lacking plurals.

So the new functions are ~10× slower per row than the old inline
regex, even before we add temp-table-build overhead.

---

## Why the title cache didn't pay off

Build query for one yearly partition (~80M rows, partition contains
~31 weeks):

```sql
SELECT ... FROM keyword_weekly_metrics WHERE week_end_date = $1::date AND title_N IS NOT NULL
UNION
SELECT ... -- same scan, slot 2
UNION
SELECT ... -- same scan, slot 3
```

Three independent scans, even with partition pruning on
`week_end_date = $1`. Each scan reads ~2.6M rows from the yearly
partition. `UNION` (not `UNION ALL`) deduplicates 7.8M strings ~100-200
bytes each via hash → big workspace + Neon storage pressure. We
suspect this is the dominant cost, on top of the loose_title_forms()
evaluation per distinct title.

Even if we replace it with a single scan + UNNEST:

```sql
SELECT DISTINCT t FROM keyword_weekly_metrics, LATERAL UNNEST(ARRAY[
  top_clicked_product_1_title, top_clicked_product_2_title, top_clicked_product_3_title
]) AS t
WHERE week_end_date = $1 AND t IS NOT NULL;
```

…that's still a partition scan plus dedup over ~7.8M rows. Probably
~5–10 min, then UPDATE on top of that.

Net: the cache only saves CPU on the **per-row** title-forms
computation. But the diagnostic shows compute is "only" ~1.34 ms/row
total — the title cache might save ~0.3-0.7 ms/row of that. The
cache build itself burns minutes. **For small dimension tables
(distinct titles) joined to wide fact tables, the build amortizes
poorly.**

We were optimizing the wrong cost. The actual bottlenecks (in order
of magnitude) appear to be:
1. Wide-row UPDATE tuple rewrite (~50 min/week)
2. Function-call overhead of `loose_match` + `loose_title_forms` per
   row (~30-60 min/week)
3. Title-cache build (~15-35 min/week) — net negative

---

## The partition-pruning bug

The plan we wrote had:

```sql
UPDATE keyword_weekly_metrics kwm
SET ...
FROM computed c
WHERE kwm.ctid = c.ctid
```

with no `kwm.week_end_date = $1` filter on the outer UPDATE. The
inner CTE has the week filter, so the ctids in `computed` are all
from one yearly partition. But the UPDATE's WHERE has only ctid —
which is per-partition, not globally unique. The planner dispatches
the UPDATE to ALL partitions and matches ctids across them.

Caught it in the diagnostic: a 10k-row sample's UPDATE matched 13,260
rows because ctids in 2024/2026 partitions collided with 2025 ctids
in the sample.

Fix: add `AND kwm.week_end_date = $1::date` to the outer UPDATE's
WHERE clause, OR target the specific yearly child partition
(`keyword_weekly_metrics_2025`) directly. Either should prune
correctly.

Q: Is targeting the child partition by name preferred, given
performance? (Our weeks know their year, so we can dispatch to the
right child trivially.)

---

## Options on the table

### A. Revert to single-pass UPDATE, just plug in new functions

Drop the temp title cache, drop MATERIALIZED, fix the partition bug.
Single statement per week:

```sql
UPDATE keyword_weekly_metrics_YYYY kwm
SET
  keyword_in_title_1_loose = CASE
    WHEN kwm.top_clicked_product_1_title IS NULL THEN NULL
    WHEN kwm.keyword_in_title_1 IS TRUE THEN TRUE
    ELSE loose_match(
      loose_search_tokens(st.search_term_normalized),
      loose_title_forms(kwm.top_clicked_product_1_title)
    )
  END,
  /* slot 2, slot 3, count similarly */
FROM search_terms st
WHERE kwm.search_term_id = st.id
  AND kwm.week_end_date = $1::date
  AND kwm.keyword_title_match_count_loose IS NULL;
```

Cost: ~15-25 min/week × 55 weeks ≈ **14-23 hours total**. Tolerable
as an overnight run.

Risk: low. Same structure as the original (which we already know
works), just with more expensive function calls.

### B. VACUUM the reset rows, then Option A

The 6 reset weeks each got ~2.4M wide-row UPDATEs (cols → NULL).
That created dead tuples; autovacuum likely hasn't reclaimed them
yet. If we run `VACUUM (ANALYZE)` on the affected partitions, free
space appears on heap pages, and the subsequent UPDATEs might be
HOT-eligible. HOT skips index maintenance (5 indexes/partition) →
plausible 2-5× write speedup.

Cost: VACUUM ~30-60 min total + ~5-9 hours backfill = **~6-10 hours
total**. Worth the small overhead.

Risk: moderate. HOT not guaranteed; we'd need to measure HOT pct in
`pg_stat_user_tables` post-run to confirm.

Q: Does the recently-reset data make HOT more likely (because we
just created predictable free space), less likely (because the new
tuples we wrote are at new positions), or neutral?

### C. Stage-and-swap per yearly partition

We have 4 yearly partitions (2024 empty, 2025 ~80M rows, 2026 ~73M
rows so far, 2027 empty). For each non-empty partition:

```sql
CREATE TABLE keyword_weekly_metrics_2025_new (LIKE keyword_weekly_metrics_2025 INCLUDING ALL)
PARTITION OF keyword_weekly_metrics
FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');

INSERT INTO keyword_weekly_metrics_2025_new
SELECT ..., -- all existing cols
       <loose flag 1>, <loose flag 2>, <loose flag 3>, <count>,
       ...
FROM keyword_weekly_metrics_2025
JOIN search_terms ON ...;

-- swap
ALTER TABLE keyword_weekly_metrics DETACH PARTITION keyword_weekly_metrics_2025;
ALTER TABLE keyword_weekly_metrics_2025_new ATTACH ...;
DROP TABLE keyword_weekly_metrics_2025;
```

INSERT into a fresh table avoids MVCC overhead and lets indexes
build in bulk after the load. Per partition: maybe 30-60 min for
INSERT + 30 min for indexes = ~1 hour.

Cost: **~3-4 hours total** for 2 non-empty partitions.

Risk: high. Operational complexity, ATTACH/DETACH locks, ability to
roll back if something goes wrong, getting the partition `FOR VALUES`
clause right.

Q: Your prior RFC said to *avoid* this approach. Given the new data
that Option A is 14-23 hours not 3 hours, does your recommendation
change?

### D. Skip historical backfill entirely

New imports already use the corrected functions (Task 4 shipped).
Going forward, every weekly import produces correct loose data. Old
rows stay NULL on the loose columns.

UI impact: the keyword detail page's "52w match history" grid stays
blank for old weeks. Users see ~52 grey/empty cells with maybe 1-2
recent green/red ones. Per the current code, the loose chart degrades
to "data only for recent weeks" with no gap-fill mismatch errors.

Cost: **0 hours**. Loose feature is "current-week only" until 12+ months
of new data accumulates.

Risk: none operationally; feature value diminished.

### E. Backfill only the last 12 weeks

Trailing quarter. ~30M rows. Probably the most commonly-viewed
window in the detail page. Older weeks stay NULL.

Cost: ~12 weeks × 15-25 min = **3-5 hours**.

Risk: low. Same structure as Option A, just with a smaller scope.

---

## Specific questions

1. Where do you think the actual ceiling is on this UPDATE pattern,
   given the diagnostic numbers?
2. Is there a structural improvement we're missing that gets Option A
   to <10 hours without resorting to stage-and-swap?
3. **The MATERIALIZED CTE pattern we tried** — was the issue
   fundamentally that we materialized intermediate state that didn't
   pay off, or did we just configure it wrong?
4. For Option B (VACUUM + Option A), how should we expect HOT pct to
   trend? Worth running `VACUUM (ANALYZE)` on all 55 weeks first
   before any further trial?
5. For Option C, given your prior "don't stage-and-swap" call —
   what would change your mind, and how would you design the
   partition swap to minimize risk?
6. Anything else we should think about that we haven't?

---

## Background — what's already shipped (not for change)

- All correctness work from the prior RFC is committed and tested
  (commits `ca681b0`, `c592b06`, `44295e3`, `2e57421`).
- New imports use the corrected functions via the new
  `looseFlagExpr` helper.
- 6 buggy historical weeks have already been reset to NULL.
- The current backfill script (`scripts/backfillKwmLooseFlags.ts`)
  reflects the slow approach; we'll rewrite it once we pick a
  direction.
