# Historical Replay Slowness RFC

## TL;DR

We're rebuilding 53 weeks of `keyword_weekly_metrics` (kwm) data through
a corrected import pipeline to fix a non-deterministic-dedup bug
([previous RFC](data-anomaly-rfc.md)). The replay is **3-4× slower than
expected** — at current rate it'll take ~35 hours instead of the
estimated 10-12.

We've identified the cause: the new path uses `ON CONFLICT DO UPDATE
WHERE row IS DISTINCT FROM EXCLUDED`, which forces a per-row read of
the existing kwm tuple. On cold partitions, those reads dominate
runtime. We propose switching the replay to a **DELETE-by-week + INSERT
fresh** path that's already in the codebase (used for the
`is_replacement=true` upload flow). Estimated 4× speedup.

We want a second opinion on:
1. Whether DELETE-then-INSERT is the right shape vs. alternatives
2. Whether we'll regret the dead-tuple bloat (160M tuples)
3. Whether there's a simpler optimization we're missing

## System context

- **DB**: Neon Postgres (paid tier, autoscaling). Tables and partitions
  too cold to keep in RAM; pages page in from object storage on
  demand.
- **kwm table**: 145M rows across 53 weeks, partitioned by year. PK is
  `(week_end_date, search_term_id)`. Wide row (~25 columns including
  text titles, etc.).
- **Replay process**: Sequential single-file imports via
  `processFileImport({ uploadedFileId, skipRefresh: true })`. Each
  file = one weekly CSV (~3M rows) downloaded from R2, COPY into a
  staging table, joined to `search_terms` via normalized form, then
  promoted to kwm.
- **Why we're replaying**: an `ON CONFLICT (week_end_date,
  search_term_id) DO NOTHING` was non-deterministically picking
  between phantom OBJ-prefixed duplicate rows that resolve to the
  same `search_term_id` after normalization. Fixed forward by adding
  a CTE that dedups via `ROW_NUMBER() OVER (... ORDER BY actual_rank
  ASC, ...)` and picks the lowest-rank winner. Replaying every CSV
  through the corrected path heals historical data.

## What's slow

Current replay path for each file:

```
1. clear_staging — DELETE FROM staging WHERE uploaded_file_id = X
2. copy_to_staging — R2 download + COPY ~3M rows into staging   [~5-10 min]
3. search_terms_upsert — INSERT ON CONFLICT DO UPDATE             [~2-5 min]
4. audit_log INSERT (duplicate groups detected by dedup CTE)      [~1-2 min]
5. kwm_insert with dedup CTE + ON CONFLICT DO UPDATE WHERE IS DISTINCT  [~20-25 min]
6. mark_imported
7. (refresh skipped — replay-only flag)
```

The 5th phase dominates. It looks like:

```sql
WITH candidates AS (
  SELECT s.*, st.id AS term_id,
    ROW_NUMBER() OVER (
      PARTITION BY s.week_end_date, st.id
      ORDER BY s.actual_rank ASC,
               s.had_unicode_noise ASC,
               s.source_row_number ASC
    ) AS rn
  FROM staging_weekly_metrics s
  JOIN search_terms st ON st.search_term_normalized = s.search_term_normalized
  WHERE s.uploaded_file_id = $1
)
INSERT INTO keyword_weekly_metrics AS kwm (...)
SELECT (... 25 columns ...) FROM candidates WHERE rn = 1
ON CONFLICT (week_end_date, search_term_id) DO UPDATE SET
  actual_rank = EXCLUDED.actual_rank,
  -- ... 24 more SETs ...
WHERE
  kwm.actual_rank IS DISTINCT FROM EXCLUDED.actual_rank
  OR kwm.top_clicked_product_1_asin IS DISTINCT FROM EXCLUDED.top_clicked_product_1_asin
  OR kwm.top_clicked_product_1_title IS DISTINCT FROM EXCLUDED.top_clicked_product_1_title
  OR kwm.top_clicked_product_1_click_share IS DISTINCT FROM EXCLUDED.top_clicked_product_1_click_share
  OR kwm.top_clicked_product_1_conversion_share IS DISTINCT FROM EXCLUDED.top_clicked_product_1_conversion_share
  OR kwm.fake_volume_severity IS DISTINCT FROM EXCLUDED.fake_volume_severity
```

For each of ~3M rows, Postgres:
- Does PK lookup (fast, indexed)
- Reads existing kwm tuple from heap (~25 columns) to evaluate the
  `IS DISTINCT FROM` checks
- If distinct → UPDATE (rewrite tuple, mark old as dead)
- If equal → no-op (just heap fetch wasted)

**The heap reads are the bottleneck** on cold partitions. Each read
pulls a page from object storage. ~3M random-access page reads per
file is what's killing us.

### Observed numbers

| Workflow | Per-file kwm INSERT time | Source |
|---|---|---|
| Original from-scratch import (1 year ago) | ~2-3 min | git history; kwm was empty so all rows were pure INSERT, no reads |
| Smoke test (5/02, current week, warm cache) | ~3-5 min | recent run |
| Replay file 1 (Apr 19 2025, very cold) | **34 min** | current run, completed |
| Replay file 4 (May 31 2025, very cold) | **32 min** | current run, completed |

## Proposed fix

The codebase already has a non-UPSERT path for the `is_replacement=true`
upload flow:

```ts
if (file.isReplacement) {
  await timePhase(file.id, 'kwm_delete_week', async () => {
    await db.execute(
      sql`DELETE FROM keyword_weekly_metrics WHERE week_end_date = ${weekEndDate}::date`,
    );
  });
  await timePhase(file.id, 'kwm_insert_replace', async () => {
    await runStagingToKwmInsert(file.id);  // SAME function — but ON CONFLICT effectively never fires since week was deleted
  });
}
```

**The replay would benefit from this path.** Each file:
- DELETE all kwm rows for the week (~3M rows) — sequential within the
  yearly partition, more cache-friendly than random PK lookups
- INSERT the deduped rows fresh — no UPSERT comparison reads needed

### Implementation sketch

1. Add a `forceReplace: true` option to `processFileImport` that takes
   the replacement path regardless of `file.isReplacement`.
2. Replay script sets `forceReplace: true`.
3. Existing replacement code is unchanged.
4. State file tracks resume; previously-completed files (via the slow
   path) are still skipped.

### Estimated speedup

| Phase | Current path | DELETE + INSERT path |
|---|---|---|
| Per-row UPSERT comparisons | ~3M cold heap reads | 0 |
| DELETE before INSERT | n/a | ~3M deletes (sequential within partition) |
| Pure INSERTs | n/a (UPSERT) | ~3M (warm because pages just got touched by DELETE) |
| **Total per file** | ~32 min | ~5-9 min |

Total replay: 53 files × 7 min = **~6 hours** vs. current ~28 hours.

## Tradeoffs / risks

### Dead tuple accumulation

DELETE leaves dead tuples. 3M per file × 53 files = **~160M dead tuples**
across the year-2025 + year-2026 partitions.

- Postgres autovacuum will reclaim them in the background. Not a
  correctness issue.
- During the replay, table size will roughly double (live + dead) until
  vacuum catches up.
- Read queries against kwm (the keyword detail page) might be slightly
  slower mid-replay because of extra page fetches over dead tuples.
  After autovacuum: back to normal.

### kwm partitioning

Yearly partitions: kwm_2024 (empty), kwm_2025 (~70M rows), kwm_2026
(~75M rows), kwm_2027 (empty). DELETE by `week_end_date` should
prune to the right partition; the partition-pruner has confirmed
this works in our existing EXPLAIN runs.

### What if data hasn't changed?

For weeks where the dedup picks the SAME row that's currently in kwm,
DELETE+INSERT does work that the IS-DISTINCT path would have skipped.
But on cold cache, the IS-DISTINCT path STILL pays for the heap read
just to make that determination — so DELETE+INSERT is no worse
even in this case.

### Source file ID gets rewritten

Existing kwm rows have `source_file_id` pointing to the original
upload. After replay, all rows for that week point to the replay file.
Acceptable; we don't surface source_file_id anywhere user-visible.

### Concurrency

If a real CSV upload happens during the replay, the orchestrator could
queue it. Current behavior: importFile uses `concurrency: { limit: 1 }`
on the Inngest function, so a real import would queue behind the
replay. Replay calls processFileImport directly (not via Inngest event)
so it bypasses that limit, but no parallel work happens.

## Alternatives considered

1. **Just let the slow path run.** ~28 more hours. Acceptable but
   unattractive given we have a faster path right there.

2. **Process newest weeks first** (DESC week order). Hopefully cache-warm.
   Probably gives 2× speedup not 4×. The first few files would still
   be slow (we'd lose the "warmth" of recent files quickly).

3. **Skip the IS DISTINCT FROM check; always UPDATE.** Avoids the
   comparison reads. But every row gets rewritten = same dead-tuple
   cost as DELETE+INSERT, plus all the UPSERT machinery overhead. Not
   obviously better.

4. **Scale up Neon compute temporarily.** Bigger memory = bigger
   cache = fewer object-storage fetches. Real but uncertain speedup;
   uses extra paid compute. Doesn't address the underlying access
   pattern.

5. **Re-create the kwm table with `CREATE TABLE kwm_new AS SELECT ...`
   from a subquery that pulls only deduped rows.** Drastic. Would
   require shutting down all reads to kwm for the duration. Not viable.

## Open questions for GPT review

1. **Is the per-row UPSERT cold-read analysis correct?** We've been
   thinking the IS-DISTINCT check is the bottleneck. Could there be
   another hidden cost (the audit-log INSERT, the JOIN to search_terms,
   the staging clear, etc.) that we're missing?

2. **Is DELETE-by-week followed by INSERT actually faster than UPSERT
   on cold cache?** Both touch the same pages eventually. Is there a
   meaningful execution-plan difference?

3. **Would adding `INCLUDE (other columns)` to the kwm PK make UPSERT
   faster?** I.e., a covering PK that lets the IS-DISTINCT check be
   index-only. This adds index size but eliminates heap reads. Same
   technique as the rank-history covering index from the prior RFC.

4. **160M dead tuples — any reason not to just let autovacuum handle
   it?** Should we run VACUUM FULL after the replay?

5. **Are we right to preserve the dedup CTE on the INSERT side?** Even
   though we've DELETEd the week's rows, the CSV itself can still
   contain duplicates that need to dedup-on-INSERT. We think yes;
   confirming.

6. **Is processing newest-first a meaningful improvement on its own,
   independent of the DELETE-vs-UPSERT question?** Or is the cold-
   cache problem primarily about partition coldness rather than file
   ordering?

7. **Anything else you'd do differently here?**

---

*Posted because the original ~10-12 hr estimate is now looking like
~35 hrs and we want to get the strategy right before kicking off
another long run. Awaiting input before implementing.*
