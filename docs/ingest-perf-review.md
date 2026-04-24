# Ingest Performance Review — Amazon SFR Analytics

Third-party review request. Looking for independent analysis of why our per-file import duration grows super-linearly, and which fix strategies are worth pursuing.

---

## 1. Problem

We're bulk-loading historical Amazon Brand Analytics "Top Search Terms" weekly CSV files into Postgres (Neon). Each CSV has ~2.7–2.9M rows and ~1.5GB on disk. We have 52 weeks' worth to backfill, and ongoing weekly imports after that.

Import duration per file has grown rapidly in proportion to cumulative data volume:

| Sequence | kwm size when import started | Observed wall-clock per file |
|---|---|---|
| Prior batch — file 1 of 5 | ~5M rows (2 weeks) | ~12 min |
| Prior batch — file 5 of 5 | ~15M rows (6 weeks) | ~15 min |
| Current batch — file 1 of 10 | ~20M rows (7 weeks) | ~30 min |
| Current batch — file 3 of 10 | ~26M rows (9 weeks) | ~45 min |
| Current batch — file 4 of 10 | ~28M rows (10 weeks) | ~76 min |
| Current batch — file 5 of 10 | ~30M rows (11 weeks) | ~142 min |
| Current batch — file 6 of 10 | ~32M rows (12 weeks) | ~106 min |

At this rate, 52 files is infeasible. Goal is to diagnose what's dominating and fix it.

## 2. Infrastructure

- **Database**: Neon Postgres (paid tier with autoscaling compute; exact CU limit unconfirmed but we believe it's modest — compute size is a known unknown we're planning to check).
- **Worker**: Railway container running a long-lived Node 22 Express server. Inngest calls the worker's `/api/inngest` endpoint; a separate detached-job runner executes the heavy import work outside Inngest step lifecycles (because Inngest's per-step HTTP timeout was biting us — documented in repo commit history).
- **Orchestration**: Inngest v4. Orchestrator uses `step.waitForEvent` to sleep server-side while the detached job runs; the detached job fires a completion event when done.
- **CSV ingest**: `pg-copy-streams` doing `COPY staging_weekly_metrics ... FROM STDIN WITH (FORMAT text)` over a node-postgres TCP connection with keepalives. This part is fast — COPY itself is not suspected as the bottleneck.

## 3. Data model (key tables)

### `search_terms` — dimension table with trigram fuzzy-search index

```ts
pgTable('search_terms', {
  id: uuid().primaryKey().defaultRandom(),
  searchTermRaw: varchar({ length: 512 }).notNull(),
  searchTermNormalized: varchar({ length: 512 }).notNull(),
  firstSeenWeek: date().notNull(),
  lastSeenWeek: date().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
```

Indexes on `search_terms`:
- Unique btree on `search_term_normalized` (used by ON CONFLICT probes)
- **GIN trigram index on `search_term_normalized`** (`gin_trgm_ops`, for fuzzy search in analytics queries) — this is write-amplifying

Current size: ~7M rows after 13 imported weeks. Each file adds ~500K–1M new rows plus touches the 2M-ish existing rows via ON CONFLICT DO UPDATE.

### `keyword_weekly_metrics` — partitioned fact table

Partitioned by year (2024–2027 partitions exist). All current data lives in the 2026 partition.

```ts
pgTable('keyword_weekly_metrics', {
  weekEndDate: date().notNull(),
  searchTermId: uuid().notNull().references(() => searchTerms.id),
  actualRank: integer().notNull(),
  // ... 20+ other columns: brands, categories, ASINs, titles, click_share, conversion_share, flags
  sourceFileId: uuid().notNull().references(() => uploadedFiles.id),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.weekEndDate, t.searchTermId] }),
  rankIdx: index('kwm_week_rank_idx').on(t.weekEndDate, t.actualRank),
  termWeekIdx: index('kwm_term_week_idx').on(t.searchTermId, t.weekEndDate),
  categoryIdx: index('kwm_week_category_idx').on(t.weekEndDate, t.topClickedCategory1),
}));
```

So on every INSERT we maintain 4 btree indexes (PK + 3 secondary) *plus* the FK constraint checks to `search_terms.id` and `uploaded_files.id`.

### `staging_weekly_metrics` — scratch table

Same shape as `keyword_weekly_metrics` plus a `search_term_id` nullable FK, indexed on `(uploaded_file_id)` and `(search_term_normalized)`. Every import writes 2.8M rows here, then deletes them after promote.

### `reporting_weeks` — tiny bookkeeping table

One row per imported week. Not performance-sensitive.

## 4. The ingest pipeline

`processFileImport` runs as a detached Promise in the worker process. Pipeline (single function call, no Inngest steps — steps are only in the orchestrator):

```ts
export async function processFileImport(input: { uploadedFileId: string }) {
  // 0. Atomic re-entry lock (CAS on uploaded_files.import_started_at). Fast.
  await db.execute(sql`
    UPDATE uploaded_files
    SET import_started_at = NOW()
    WHERE id = ${uploadedFileId}
      AND (import_started_at IS NULL OR import_started_at < NOW() - INTERVAL '60 minutes')
      AND validation_status != 'imported'
    RETURNING id
  `);

  // Clear any partial staging from a prior timed-out run of this file.
  await db.delete(stagingWeeklyMetrics).where(eq(stagingWeeklyMetrics.uploadedFileId, fileId));

  // 1. COPY CSV from R2 into staging. ~2.8M rows per file.
  //    Uses pg-copy-streams + pg.Pool with TCP keepalive. Fast path.
  //    Normalization (normalizeForMatch) computed per-row in Node and written into staging.
  //    Title-match boolean flags computed per-row in Node.
  await streamCopyFromR2ToStaging(fileId);

  // 2. Upsert into search_terms.
  await db.execute(sql`
    INSERT INTO search_terms (search_term_raw, search_term_normalized, first_seen_week, last_seen_week)
    SELECT DISTINCT ON (search_term_normalized)
      search_term_raw, search_term_normalized, ${weekEndDate}::date, ${weekEndDate}::date
    FROM staging_weekly_metrics
    WHERE uploaded_file_id = ${fileId}
    ON CONFLICT (search_term_normalized) DO UPDATE
      SET last_seen_week = GREATEST(search_terms.last_seen_week, EXCLUDED.last_seen_week),
          first_seen_week = LEAST(search_terms.first_seen_week, EXCLUDED.first_seen_week)
  `);

  // 3. Backfill search_term_id on staging rows.
  await db.execute(sql`
    UPDATE staging_weekly_metrics s
    SET search_term_id = st.id
    FROM search_terms st
    WHERE s.uploaded_file_id = ${fileId}
      AND s.search_term_normalized = st.search_term_normalized
  `);

  // 4. Promote into keyword_weekly_metrics.
  //    Non-replacement path (the common case) uses ON CONFLICT DO NOTHING
  //    as a safety net against double-inserts for the same (week, term).
  await db.execute(sql`
    INSERT INTO keyword_weekly_metrics (
      week_end_date, search_term_id, actual_rank,
      /* 20+ other columns */
      source_file_id
    )
    SELECT
      week_end_date, search_term_id, actual_rank,
      /* 20+ other columns */
      ${fileId}
    FROM staging_weekly_metrics
    WHERE uploaded_file_id = ${fileId}
    ON CONFLICT (week_end_date, search_term_id) DO NOTHING
  `);

  // 5. Bookkeeping + cleanup.
  await upsertReportingWeek(fileId, weekEndDate);
  await db.delete(stagingWeeklyMetrics).where(eq(stagingWeeklyMetrics.uploadedFileId, fileId));
  await db.update(uploadedFiles).set({ validationStatus: 'imported', ..., importStartedAt: null })
    .where(eq(uploadedFiles.id, fileId));
}
```

### Full `processFileImport` source

(Included for context; the SQL statements above are the interesting parts. In-JS per-row work includes lowercase, regex strip, and three substring checks for title-match flags. Cheap.)

<details><summary>Expand full code</summary>

```ts
import { eq, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { from as copyFrom } from 'pg-copy-streams';
import { downloadStreamFromR2 } from '@/lib/storage/r2';
import { streamParseCsv } from '@/lib/csv/streamParse';
import { normalizeForMatch } from '@/lib/analytics/derivedFields';
import { env } from '@/lib/env';
import { db } from '@/db/client';
import { uploadedFiles, stagingWeeklyMetrics, reportingWeeks } from '@/db/schema';

// normalizeForMatch: lowercase, strip apostrophes, keep only letters/numbers/spaces, collapse whitespace
// (it's ~6 regex ops per row, runs entirely in Node, no DB interaction)

export async function processFileImport(input: { uploadedFileId: string }) {
  // Re-entry lock
  const lockResult = await db.execute<{ id: string }>(sql`
    UPDATE uploaded_files SET import_started_at = NOW()
    WHERE id = ${input.uploadedFileId}
      AND (import_started_at IS NULL OR import_started_at < NOW() - INTERVAL '60 minutes')
      AND validation_status != 'imported'
    RETURNING id
  `);
  if (lockResult.rows.length === 0) { /* ...short-circuit or throw... */ }

  const file = await db.query.uploadedFiles.findFirst({ where: eq(uploadedFiles.id, input.uploadedFileId) });
  const weekEndDate = file.weekEndDate;

  // Idempotency: clear partial staging from prior failed run
  await db.delete(stagingWeeklyMetrics).where(eq(stagingWeeklyMetrics.uploadedFileId, file.id));

  // COPY staging (pg Pool with keepalive, separate from Drizzle's pool)
  const stream = await downloadStreamFromR2(file.storageKey);
  let rowsStaged = 0;
  const pool = new Pool({ connectionString: env.DATABASE_URL, keepAlive: true, keepAliveInitialDelayMillis: 10_000 });
  const client = await pool.connect();
  try {
    const copyStream = client.query(copyFrom(`COPY staging_weekly_metrics (batch_id, uploaded_file_id, week_end_date, search_term_raw, search_term_normalized, actual_rank, /* 20+ columns */) FROM STDIN WITH (FORMAT text, NULL '\\N')`));
    for await (const row of streamParseCsv(stream)) {
      const normalizedTerm = normalizeForMatch(row['Search Term']) || row['Search Term'].toLowerCase().trim() || '__unparseable__';
      // ...compute inT1/inT2/inT3 boolean title-match flags in Node...
      const line = encodedFields.join('\t') + '\n';
      if (!copyStream.write(line)) await new Promise<void>((r) => copyStream.once('drain', () => r()));
      rowsStaged++;
    }
    copyStream.end();
    await new Promise<void>((resolve, reject) => { copyStream.on('finish', () => resolve()); copyStream.on('error', reject); });
  } finally {
    client.release();
    await pool.end();
  }

  // search_terms upsert
  await db.execute(sql`
    INSERT INTO search_terms (search_term_raw, search_term_normalized, first_seen_week, last_seen_week)
    SELECT DISTINCT ON (search_term_normalized)
      search_term_raw, search_term_normalized, ${weekEndDate}::date, ${weekEndDate}::date
    FROM staging_weekly_metrics WHERE uploaded_file_id = ${file.id}
    ON CONFLICT (search_term_normalized) DO UPDATE
      SET last_seen_week = GREATEST(search_terms.last_seen_week, EXCLUDED.last_seen_week),
          first_seen_week = LEAST(search_terms.first_seen_week, EXCLUDED.first_seen_week)
  `);

  // Link staging -> search_term_id
  await db.execute(sql`
    UPDATE staging_weekly_metrics s SET search_term_id = st.id
    FROM search_terms st
    WHERE s.uploaded_file_id = ${file.id} AND s.search_term_normalized = st.search_term_normalized
  `);

  // Promote to kwm (non-replacement path)
  await db.execute(sql`
    INSERT INTO keyword_weekly_metrics (week_end_date, search_term_id, actual_rank, /* 20+ columns */, source_file_id)
    SELECT week_end_date, search_term_id, actual_rank, /* 20+ columns */, ${file.id}
    FROM staging_weekly_metrics WHERE uploaded_file_id = ${file.id}
    ON CONFLICT (week_end_date, search_term_id) DO NOTHING
  `);

  // reporting_weeks + cleanup
  await db.insert(reportingWeeks).values({ weekEndDate, weekStartDate, sourceFileId: file.id, isComplete: true })
    .onConflictDoUpdate({ target: reportingWeeks.weekEndDate, set: { sourceFileId: file.id, isComplete: true } });
  await db.delete(stagingWeeklyMetrics).where(eq(stagingWeeklyMetrics.uploadedFileId, file.id));
  await db.update(uploadedFiles).set({ validationStatus: 'imported', importedAt: new Date(), rowCountLoaded: rowsStaged, importStartedAt: null })
    .where(eq(uploadedFiles.id, file.id));

  return { rowsImported: rowsStaged };
}
```

</details>

## 5. Orchestrator (for context only — not suspected as the bottleneck)

```ts
// importBatchFn — Inngest function. Each file:
//   1. step.run('kickoff-<id>', () => startImportJob(fileId))  // returns immediately
//   2. step.run('pre-wait-check-<id>', ...)                    // race-guard DB read
//   3. step.waitForEvent('await-<id>', {
//        event: 'csv/file.import-completed',
//        if: `async.data.uploadedFileId == "${f.id}"`,
//        timeout: '4h',
//      });
//   4. increment imported/failed, continue
```

`startImportJob` spawns `processFileImport` as a detached Promise (not awaited), and in its `finally` block sends `csv/file.import-completed` via `inngest.send({...})`. The orchestrator uses `step.waitForEvent` so it doesn't consume step budget while waiting.

## 6. Bottleneck hypotheses (ranked)

### H1. `search_terms` upsert with GIN trigram index (highest suspicion)

```sql
INSERT INTO search_terms ... ON CONFLICT (search_term_normalized) DO UPDATE ...
```

Per file, Postgres has to:
1. Probe the unique btree on `search_term_normalized` for each of ~800K–1M distinct terms — O(n · log N).
2. For every **new** row, write to:
   - table heap
   - unique btree
   - **GIN trigram index** — this is the big one. GIN indexes on text with `gin_trgm_ops` generate ~N trigrams per row and need to maintain posting lists. Write-heavy workloads on GIN indexes are 3–10× slower than equivalent btree writes, especially when `gin_pending_list_limit` is being hit.
3. For every **existing** row that gets `ON CONFLICT DO UPDATE`, perform an UPDATE that creates a new HOT-or-not tuple, updates `last_seen_week` (and sometimes `first_seen_week`). With ~2M overlap per file, that's 2M tuple updates per import — *even though the logical content is usually unchanged*.

The `ON CONFLICT DO UPDATE` is especially suspicious because it forces an UPDATE *even when `last_seen_week` would not actually change* (GREATEST of a value against itself is a no-op logically, but Postgres still writes a new tuple version).

### H2. `kwm` INSERT with `ON CONFLICT DO NOTHING`

Inserts ~2.7M rows per file into the 2026 partition. Every row needs:
- Uniqueness probe on PK `(week_end_date, search_term_id)` — index grows with each file
- Maintenance on three secondary btrees
- FK check against `search_terms.id` (index-scan)
- FK check against `uploaded_files.id` (trivial)

As the 2026 partition's indexes grow from 20M → 60M → 140M entries, the constant cost goes up. Not super-linear on its own, but additive with H1.

### H3. Hash join for `search_term_id` backfill

```sql
UPDATE staging_weekly_metrics s SET search_term_id = st.id
FROM search_terms st WHERE s.uploaded_file_id = X AND s.search_term_normalized = st.search_term_normalized
```

Postgres builds a hash on `search_terms` (7M+ rows) for each file. Cost is linear in the inner side. Plan may also flip to merge join or nested loop as size ratios change — potentially a cliff if statistics get stale.

### H4. Neon compute throttling

Our Neon instance is on the paid tier with autoscaling but we don't know the effective compute ceiling. Sustained heavy writes (COPY + upsert + INSERT + UPDATE) over 15–60 min per file could be hitting the scaling ceiling, especially during the upsert phases which are CPU-bound on index traversal.

### H5. Autovacuum lag / bloat on `staging_weekly_metrics`

Each file writes 2.8M rows to staging, then deletes all of them. That's 5.6M+ dead tuples per import in a table that logically empties. If autovacuum doesn't keep up, subsequent COPYs write into bloated pages and the staging scans for the upsert and JOIN hit pages they don't need.

### H6. Autovacuum lag / stats staleness on `search_terms` and `kwm`

Query planner decisions for the JOIN (H3) depend on `pg_stats` estimates. Stale stats can flip a good hash join into a bad nested loop. We don't explicitly run `ANALYZE` between files.

## 7. Proposed fixes (ranked by cost/benefit)

**A. Verify Neon compute size.** Check dashboard → compute settings. If the autoscaling cap is low, either raise it, or set a min-CU during backfill runs. No code change. Might be the single biggest win for least effort.

**B. Replace `ON CONFLICT DO UPDATE` with `DO NOTHING` on `search_terms`.** Then update `last_seen_week` / `first_seen_week` in a cheap post-hoc job (or compute it from `kwm` on demand — we have `source_file_id` → `uploaded_files.week_end_date`). Eliminates 2M tuple updates per file and all the resulting GIN-index churn on unchanged rows.

**C. Drop + recreate the GIN trigram index for backfill runs.** The GIN index only matters for a fuzzy-search UI feature, not for ingest correctness. For a one-time 52-week backfill, drop it, ingest, rebuild. Recreation takes one pass over the final search_terms table (fast, sequential). Doesn't help steady-state weekly imports, but makes backfill dramatically faster.

**D. Drop + recreate the `kwm` PK / secondary indexes during backfill.** Same logic as C. The PK `(week_end_date, search_term_id)` exists to prevent duplicate insertions; we guarantee that at the application level too (one source file per week, replacement path handles re-imports). Rebuilding the PK on a final 140M-row table takes minutes, not hours.

**E. Pre-sort the COPY payload.** Sort each CSV by `search_term_normalized` (or by normalized term's hash) before streaming. Clustered inserts into indexes perform markedly better because index-page locality reduces random-IO. Requires buffering to sort — 2.8M rows × a few strings per row fits comfortably in Node memory, or use `sort -t, -k` before streaming.

**F. Denormalize: put `search_term_normalized` directly on `kwm`** and make `search_terms` a view or a post-hoc aggregate. Kills steps 2 and 3 of the pipeline entirely. Queries that currently JOIN `kwm` to `search_terms` would read the denormalized column instead. Biggest structural change of the bunch but probably correct long-term for this use case.

**G. Parallelize multi-file ingest.** Run 2–3 files in parallel. `search_terms` upsert would serialize on the unique constraint (row locks) but the COPY phase, JOIN phase, and `kwm` INSERT phase could overlap. Not a game-changer.

**H. Run `VACUUM ANALYZE` between files.** Cheap to add to the pipeline. Might stabilize the query planner's choices and reduce bloat. Probably 10–20% improvement, not a game-changer, but nearly free.

## 8. Specific questions for reviewer

1. **Is the GIN trigram index on `search_terms.search_term_normalized` really as expensive as I suspect**, given that the search_terms table sees ~1M upserts per file? If yes, is dropping-and-rebuilding it for backfill (fix C) the right call, or is there a smarter mitigation (raising `gin_pending_list_limit`, etc.)?

2. **Would you keep the `ON CONFLICT DO UPDATE` on `search_terms`** or move `last_seen_week` / `first_seen_week` tracking elsewhere (fix B)? If kept, is there a way to make it a no-op when the values wouldn't actually change? Postgres updates a tuple even if `GREATEST(x, y) = x` produces the same value as before.

3. **Does the `kwm` `ON CONFLICT DO NOTHING` clause pull its weight** during a backfill where we know we're inserting distinct `(week_end_date, search_term_id)` tuples? Removing it eliminates the uniqueness probe per row. The PK still has to be maintained, but the probe cost is separate from the maintenance cost.

4. **Is pre-sorting the COPY payload by `search_term_normalized`** (fix E) worth the Node-side memory/CPU cost? What's the typical speedup from clustered COPY on a table with one btree + one GIN index?

5. **Are there cheap smoke-test instrumentation points** you'd add to confirm where the time actually goes on the next ingest? Right now I have no hard data — just wall-clock durations. I'd like to capture per-phase timings (COPY, upsert, JOIN, INSERT, cleanup) cheaply. Would you use `EXPLAIN (ANALYZE, BUFFERS)` on each step, or log `Date.now()` diffs in TS, or something else?

6. **Am I missing a class of bottleneck entirely?** Things I haven't seriously considered: connection-pool thrashing (we open a separate `pg.Pool` for COPY and use Drizzle's `neon-http` for everything else), WAL pressure and checkpointing, tuple-width issues on staging (staging has ~30 columns, many `varchar`/`text`, so row size is significant), TOAST churn on title columns.

7. **For the ongoing weekly-import case** (one file per week, against a growing kwm), which of A–H matter most? I expect the backfill-specific tricks (drop indexes, parallelize) are only useful for the one-time backfill, but the structural ones (B, F, H) apply to steady state too.

## 9. Constraints / non-negotiables

- **Correctness**: a completed import must be fully and correctly represented in `kwm` with matching `reporting_weeks` marker. We can tolerate slow imports, not wrong ones.
- **Replacement path** must keep working: re-importing an already-imported week via the "replacement" flag is `DELETE FROM kwm WHERE week_end_date = X` then `INSERT ... FROM staging` (no ON CONFLICT). That flow is a corner-case we care about for data corrections.
- **No new managed services** for this round. Staying on Neon + Railway + Inngest + R2. Self-hosted Clickhouse or a warehouse is a "maybe in a year" discussion, not this week.

---

*(End of review doc. Happy to paste specific additional source files if useful — `worker/jobs.ts`, `inngest/functions/importBatch.ts`, migrations, the full `processFileImport` — ask and I'll append.)*
