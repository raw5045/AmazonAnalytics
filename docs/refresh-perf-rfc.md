# Refresh perf RFC — keyword_current_summary

## TL;DR

After every weekly Amazon Brand Analytics CSV import, we rebuild a denormalized
table called `keyword_current_summary` (kcs) that powers the read-only "Keyword
Explorer" page. The rebuild currently takes **~155 min** on every weekly import.
Profiling shows that **~92% of that time** is spent in 5 stages that each look
up a single column (`actual_rank`) from a 145M-row partitioned table for ~3.84M
active search terms.

We're looking for the best way to cut this down to **~30 min or less** without
giving up correctness or making the schema dramatically more complex. We have
two candidate approaches but want a sanity check on whether there's a better
path we haven't considered.

---

## System context

- **Stack:** Next.js 16 web app on Vercel + a long-running worker on Railway.
  Database: **Neon Postgres** (serverless, paid tier, auto-scales compute,
  data lives on object storage with a local page cache that pages-in on demand).
- **Data:** Amazon Brand Analytics weekly CSVs of search-term performance.
  Each CSV is ~3M rows, one row per search term + week. 53 weeks have been
  imported, totaling **145M rows** in `keyword_weekly_metrics` (kwm).
  Partitioned by year (yearly partitions).
- **Read use case (the explorer):** "Show me the top 100 keywords currently
  matching these filters." Reads must be fast (<1s) — the page is interactive.
- **Write use case (the refresh):** runs as the final step of `processFileImport`
  after each weekly CSV import. Currently bottleneck.

## What `keyword_current_summary` (kcs) holds

One row per **active** search term (active = seen in the last 28 days, currently
3,843,917 rows). Each row carries:
- Current rank
- Historical ranks at exactly 1 / 4 / 13 / 26 / 52 weeks ago (NULLable —
  NULL = "wasn't ranked in that exact week")
- Improvement deltas derived from those ranks
- Snapshot of category, top-clicked product info, fake-volume severity,
  in-title flags (both Amazon's strict version and our computed loose version
  per the recently-merged feature)

This is what the explorer page reads. By construction, the explorer never
hits kwm — it only reads kcs (3.84M rows) joined to search_terms.

## Refresh shape (current code)

```
BEGIN;
  CREATE TEMP TABLE latest_per_term AS  -- DISTINCT ON over kwm last 28 days
  CREATE TEMP TABLE rank_at_1w  AS  -- JOIN latest_per_term to kwm, exact-date match
  CREATE TEMP TABLE rank_at_4w  AS
  CREATE TEMP TABLE rank_at_13w AS
  CREATE TEMP TABLE rank_at_26w AS
  CREATE TEMP TABLE rank_at_52w AS
  CREATE TEMP TABLE term_normalized AS  -- preprocess title text for loose match
  CREATE TEMP TABLE loose_flags AS      -- 3x slot match flags per term
  TRUNCATE keyword_current_summary;
  INSERT INTO keyword_current_summary  -- joins all of the above
  COMMIT;
```

Concurrent reads see the OLD kcs rows until COMMIT, then atomically swap.

## Profiled timings (warm-ish cache, single transaction)

```
 latest_per_term                    10.2 min
 rank_at_1w                         28.6 min
 rank_at_4w                         28.3 min
 rank_at_13w                        28.2 min
 rank_at_26w                        28.1 min
 rank_at_52w                        27.7 min   <-- 5 stages, 141 min total
 term_normalized                     1.9 min
 loose_flags                         0.5 min
 TOTAL                             154   min
```

**5 rank_at_*w stages = 92% of runtime.** Each is the same shape:

```sql
CREATE TEMP TABLE rank_at_<N>w ON COMMIT DROP AS
SELECT
  l.search_term_id,
  k.actual_rank
FROM latest_per_term l
JOIN keyword_weekly_metrics k
  ON k.search_term_id = l.search_term_id
  AND k.week_end_date = (l.week_end_date - (<N> * INTERVAL '7 days'))::date;
CREATE INDEX ON rank_at_<N>w (search_term_id);
```

For each row in `latest_per_term` (3.84M), look up the kwm row from N weeks
earlier. 3.84M index lookups × 5 stages = ~19M lookups. Mostly cold pages
from Neon's object storage on first access.

### Relevant kwm schema

```
keyword_weekly_metrics (
  search_term_id   uuid     NOT NULL  references search_terms(id),
  week_end_date    date     NOT NULL,
  actual_rank      integer  NOT NULL,
  -- ~28 other columns: top-clicked product info, click/conversion shares,
  -- fake-volume flags, etc.
  PRIMARY KEY (search_term_id, week_end_date)
) PARTITION BY RANGE (week_end_date);
```

- Partitioning: yearly partitions (kwm_2024, kwm_2025, kwm_2026)
- Primary key: composite (search_term_id, week_end_date) — should give
  efficient point-lookups by (term, date)
- The `actual_rank` column we read in rank_at_*w is `int4` — small. The
  cost is paging in heap blocks to read the row, not reading the column.

## What we've tried that didn't work

We rewrote the loose-match flag computation from a per-row Postgres regex
match (`title ~ '\m<word>\M'`) to a `POSITION(' word ' IN padded_title)`
substring search, expecting a 10-50× speedup on that stage. Result:
- Loose-match correctness preserved (37.9% match rate, identical examples)
- Stage runtime: ~28s for `loose_flags` (was somewhere between 5 min and 90
  min — never directly measured before since we didn't profile)
- **Total refresh time: 158.6 min vs prior 162.2 min** — within noise

Lesson: we optimized the wrong stage. The rank_at_*w stages dominate.

## Two candidate paths we're considering

### Option A: Top-1M-SFR filter

Filter `latest_per_term` to `actual_rank < 1_000_000`. The product owner
considers keywords ranked > 1M not useful for analysis (lower SFR rank =
higher search frequency in the Amazon data — so rank 1 is the most-searched
term, rank 1M is searched relatively rarely).

Effect:
- Active set drops from 3.84M to ~1M rows (rough estimate; need to verify)
- Every downstream stage proportionally benefits
- Estimated total: **~40 min**
- One-line change: a `WHERE actual_rank < 1_000_000` predicate

Cost:
- Explorer can't show keywords ranked > 1M anymore. Product owner has
  endorsed this trade-off ("keywords outside top 1M don't really matter").
- We could add the threshold to a config table later if it changes.

### Option B: Combine the 5 rank lookups into 1 query

```sql
CREATE TEMP TABLE rank_offsets AS
SELECT
  l.search_term_id,
  CASE k.week_end_date
    WHEN (l.week_end_date - INTERVAL '7 days')::date  THEN 1
    WHEN (l.week_end_date - INTERVAL '28 days')::date THEN 4
    -- etc
  END AS weeks_ago,
  k.actual_rank
FROM latest_per_term l
JOIN keyword_weekly_metrics k
  ON k.search_term_id = l.search_term_id
  AND k.week_end_date IN (
    (l.week_end_date - INTERVAL '7 days')::date,
    (l.week_end_date - INTERVAL '28 days')::date,
    (l.week_end_date - INTERVAL '91 days')::date,
    (l.week_end_date - INTERVAL '182 days')::date,
    (l.week_end_date - INTERVAL '364 days')::date
  );
```

Then pivot in the final INSERT (5 LEFT JOINs to filtered subqueries, or
crosstab).

Effect:
- ~19M lookups becomes 19M lookups in 1 scan instead of 5. Better data
  locality if Neon's prefetcher is doing per-query rather than per-statement
  warmup.
- Hard to estimate without trying. Maybe 30-40% improvement. Maybe none if
  the bottleneck is purely lookups-per-second from object storage.

### A + B combined: estimated **~25-30 min total**.

## Open questions / where outside input would help

1. **Is there a fundamentally different shape that avoids 19M (term, date)
   point-lookups?** E.g., maintain rank-history per term incrementally as
   each weekly CSV imports, so the refresh is purely "read what's already
   computed" rather than "join + aggregate." Trade-off: complexity, harder
   to recover from a bad import. But if it cuts the refresh from 150 min to
   <5 min by spreading the work across imports, might be worth it.

2. **Could we change kcs's update strategy?** Instead of TRUNCATE + full
   rebuild, do per-term UPSERTs after each import for only the (term,
   updated-this-week) rows. The "rank N weeks ago" columns wouldn't change
   week-over-week for inactive terms, so we'd skip 95% of the work each
   refresh.

3. **Are we abusing Neon's storage tier somehow?** The rank_at_*w lookups
   are random access patterns over a partitioned table. If the planner is
   not doing partition pruning for these queries (i.e., every lookup scans
   all 3 partitions), that's 3× wasted I/O. We haven't checked EXPLAIN on
   one of these queries yet — would be worth doing.

4. **Indexing on kwm:** the primary key `(search_term_id, week_end_date)`
   should serve these point-lookups perfectly, but we haven't confirmed via
   EXPLAIN what plan the planner picks. Could be doing seq scans inside a
   partition for some reason.

5. **Should the explorer be reading from a materialized view that's
   maintained incrementally rather than rebuilt-from-scratch?** Postgres
   has REFRESH MATERIALIZED VIEW CONCURRENTLY but that's still a full
   rebuild. There's no built-in incremental MV in vanilla Postgres. We'd
   roll our own with triggers or per-import maintenance.

## What we want feedback on

Given:
- Read pattern: <1s explorer reads from kcs are fixed-priority — can't slow them down.
- Write pattern: kcs rebuild runs once after each weekly import. Today: 150
  min. Target: ≤30 min.
- Constraint: we don't want to materially complicate the schema or import
  pipeline unless the win is large.

Is **A+B** the right move, or are we missing a simpler/better approach?
Concrete suggestions on Option B's pivot strategy welcome too.
