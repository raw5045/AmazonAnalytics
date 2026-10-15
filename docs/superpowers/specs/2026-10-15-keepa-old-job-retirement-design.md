# Keepa old import-time job retirement — design

**Date:** 2026-10-15 · **Status:** approved by the owner (brainstorm 2026-10-15) · **Arc:** 11 (arc 6's "phase 3")

**Owner decisions recorded here:** remove the reader flag and the "weekly" code branches in this arc (not a rollback path once the writer stops); the admin page becomes the service's page (status card only; the full-refresh button and the run list go); the card's fetched row gains the 7-day average per day (no new query); no new email for now (may be revisited); the old table stays as a raw archive, never dropped or exported in this arc.

## 1. Why

Since 2026-10-15 ~16:00 UTC every reader runs with `KEEPA_READ_SOURCE=products` (verified on the "kindle" keyword page: products the weekly table lacks now show). The old import-time job (`inngest/functions/enrichKeepaForWeek.ts` → `worker/keepaJobs.ts`) still fires after every import, writes `asin_weekly_data` nobody reads, spends about 3 hours of the shared Keepa token bucket a week, and keeps two guards alive (the service yields to it; the watcher holds its stall alarm for it). This arc removes the job, the guards, the flag and the weekly branches, after copying the fetches it wrote since the seed into the snapshot table.

Pre-flip facts (2026-10-15, read-only diags): this week's top-3 products covered 95.2 % by the catalog vs 93.3 % by the weekly table in the top 100k keywords, 96.9 % vs 41.5 % in the 100k–1M band, with nothing the weekly table has missing from the catalog; the Category Builder tree 24,277 paths vs 11,951; keyword detail read 43 ms, builder queries under a second.

## 2. History is kept

The arc-6 seed (`scripts/applyMigration0050.ts`, dated 2026-10-05 and run 2026-10-06 ~18:40 UTC) copied every distinct genuine fetch of `asin_weekly_data` (`DISTINCT ON (asin, enriched_at)`, status active or no_price) into `asin_snapshots`. Today `asin_snapshots` holds 3,220,892 snapshots over 1,601,284 ASINs, the oldest from 2026-05-15; the product page's history charts and `get_product_details.history` read it. The weekly table's 3,327,650 rows are 1,892,945 distinct fetches plus carry-forward copies. After the seed the old job wrote 41,346 more fetches; 20,835 of them have no snapshot at their fetch time (its last run, after the 2026-10-10 import).

### 2.1 Backfill (step 1 of the ship order, before any code is removed)

An untracked, owner-gated script `scripts/backfillSnapshotsFromWeekly1015.ts` (`BACKFILL_SNAPSHOTS=yes`) runs the seed's step-3 statement restricted to post-seed fetches, in one transaction with `SET LOCAL work_mem = '256MB'` and `SET LOCAL statement_timeout = '600s'`:

```sql
INSERT INTO asin_snapshots (asin, fetched_at, current_price_cents, sales_rank, review_count, average_rating_x10, enrichment_status)
SELECT DISTINCT ON (a.asin, a.enriched_at)
  a.asin, a.enriched_at, a.current_price_cents, a.sales_rank, a.review_count, a.average_rating_x10, a.enrichment_status
FROM asin_weekly_data a
WHERE a.enriched_at >= '2026-10-06' AND a.enrichment_status IN ('active', 'no_price')
ORDER BY a.asin, a.enriched_at, a.week_end_date DESC
ON CONFLICT DO NOTHING
```

Idempotent (`ON CONFLICT DO NOTHING` against the snapshot table's primary key `(asin, fetched_at)`). Before and after, the script prints the count of post-seed fetches with no snapshot at that time (the diag's query); the run is accepted when the after-count is 0 and the inserted count equals the before-count. Delisted post-seed rows are not copied, as the seed did not copy them (the catalog carries each ASIN's current status).

The `asin_snapshots` rows gain nothing else: the weekly table's per-week title, brand, image, category and price averages are not snapshot columns and nothing in the app shows them as history. 9,355 ASINs changed category across the 24 weeks; that history stays in the archive table only.

## 3. Removed

Every deletion takes its tests along. Paths are exact.

### 3.1 The job and its trigger

- `inngest/functions/importFile.ts`: the block after the summary refresh that sends `keepa.enrich-week-requested` (mode diff) and its two log lines; `importFile.test.ts` pins that no event is sent. The `keepa_enqueue` phase (arc 6) stays: it is the replacement.
- `inngest/functions/enrichKeepaForWeek.ts` and its entry in `inngest/functions/index.ts`.
- `worker/keepaJobs.ts` (the detached job), `lib/keepa/client.ts` (the old pacer/client), `lib/keepa/parse.ts` + `parse.test.ts`, `lib/keepa/types.ts` (its only remaining consumers are the job, the old parser and the enrichment email; `pnpm typecheck` confirms before the delete lands).
- `app/api/admin/keepa-enrichment/fire-full/route.ts` and `app/admin/keepa-enrichment/KeepaEnrichmentButton.tsx`.
- `lib/notifications/buildEnrichmentEmail.ts`, `sendEnrichmentEmail.ts` and both tests.
- Tracked helper scripts of the old job: `scripts/fireEnrichWeek.ts`, `scripts/fireKeepaEnrichment.ts`, `scripts/keepaSmokeTest.ts`, `scripts/checkKeepaProgress.ts`.

### 3.2 The guards

- `services/keepa/loop.ts`: `probeOldJob`, the `yieldingToOldJob` state, the `yield_old_job` / `resume_after_old_job` log events and the two call sites (before claim, before fetch); `services/keepa/store.ts` `oldJobRunning`; `services/keepa/pgStore.ts` its implementation (the `keepa_enrichment_runs` heartbeat probe); `loop.test.ts` (six yield cases) and `pgStore.test.ts` follow.
- `lib/keepa/watcherRules.ts`: `oldJobRecentlyLive` and the held reason `old_job_recent`; `inngest/functions/keepaServiceWatcher.ts`: the `keepa_enrichment_runs` heartbeat read (the tick log never carried a source field; its `readSource` dependency leaves with the two sync guards in §3.3); `watcherRules.test.ts`, `keepaServiceWatcher.test.ts`, `tests/integration/keepaWatcher.test.ts` follow. The watcher keeps the enqueue-lock hold, the down/stall alarms and the aggregate-sync firing exactly as they are.
- `services/keepa/README.md`: the shared-bucket paragraphs and the `yield_old_job` row.

### 3.3 The flag and the weekly branches

- `lib/keepa/readSource.ts` + `readSource.test.ts` deleted; `.env.example` never listed the variable (verified 2026-10-15; the arc-6 spec and plan keep it as history). The owner removes `KEEPA_READ_SOURCE` from Vercel and the Railway worker after the deploy is green (harmless if left: nothing reads it).
- `lib/explorer/fetchKeywordDetail.ts` `enrichedProductsFor`: the catalog statement only; `lib/explorer/enrichedProductsQuery.test.ts` pins that statement without a flag stub.
- `lib/categoryBuilder/loadTree.ts`: the source parameter leaves the three cached builders and their cache keys; the weekly SQL goes; the catalog SQL is unchanged.
- `inngest/functions/refreshSummary.ts` `stageEnrichedAsinsSql`: catalog only (signature loses the source); `inngest/functions/enrichedSourceSql.test.ts` keeps the catalog pins.
- `worker/kcsKeepaSyncJobs.ts` `enrichedSyncSourceSql`: catalog only (same); its log line no longer names a source.
- Stale prose that names the flag or the weekly branch in the files above and in `lib/research/categories.ts:18` is reworded.

## 4. Stays

- `asin_weekly_data` and `db/schema/asinWeeklyData.ts` (the schema file's header gains: archive since 2026-10-15, no writers, never read by the app; 24 weeks 2026-05-02 → 2026-10-10, ~5.5 GB). `keepa_enrichment_runs` and its schema file likewise (30 runs, 2026-05-19 → 2026-10-13). Neither is dropped, exported or truncated in this arc.
- The `keepa_enqueue` import phase, the service, the watcher, the aggregate sync (`inngest/functions/syncKcsKeepaAggregates.ts`, `worker/kcsKeepaSyncJobs.ts`), the alarm emails, `lib/admin/keepaServiceOverview.ts`.
- `scripts/backfillCategoryPaths.ts` (an unrelated one-time tool that reads the archive) is left untouched.

## 5. Admin page and card

- `app/admin/keepa-enrichment/page.tsx`: heading "Keepa service", the `ServiceStatusCard`, nothing else (the "Manual full refresh" section, the button and the "Recent runs" list go; the `keepaEnrichmentRuns` import with them); `page.test.tsx` follows. The route path stays (`/admin/keepa-enrichment`, linked from the admin layout).
- `app/admin/keepa-enrichment/ServiceStatusCard.tsx`: the row `['Fetched last 24 h', …]` becomes `['Fetched last 24 h', `${fmt(counts.fetchedLast24h)} · 7-day avg ${fmt(Math.round(counts.fetchedLast7d / 7))}/day`]` (amended 2026-10-15: the longer "7-day average M per day" wrapped at the card's 355 px column); the card's h2 reads "Service status" under the page's "Keepa service" heading, and its degraded line reads `Could not load (code)`; `ServiceStatusCard.test.tsx` pins the text. `lib/admin/keepaServiceOverview.ts` is unchanged (both counts exist).

## 6. Errors and safety

- The backfill is the only database write of the arc: one transaction, idempotent, read-only otherwise, run by the owner's go. A failure rolls back and the script is re-run.
- Removing the guards cannot starve the service: the old job no longer exists after the deploy, and the backfill runs before it. If the owner's go for the push lands after a weekly import has already fired the old event (2026-10-20), that last run completes under the old code or is orphaned by the deploy's worker restart; either way the service resumes within ten minutes of the last heartbeat, as today. The Results table records which.
- The Railway service redeploys because `/services/keepa/**` and `/lib/keepa/**` change: its in-flight batch is reclaimed by the claim-timeout rule as on every service deploy.
- Rollback: `git revert` of the arc's commits and a push. The snapshots backfilled stay (correct data). The flag would be read again by the reverted code, so the owner leaves the variables in place until the deploy has been green for a day.

## 7. Tests

- Unit: every touched module's test file follows the code (deleted with deletions; the readers' tests pin the catalog statements without a flag stub; the loop and watcher tests lose the old-job cases and keep every other decision); `pnpm typecheck`, `pnpm exec eslint <touched files>`, the whole `pnpm vitest run`, `pnpm build`.
- Integration (owner's go, read-only): `tests/integration/keepaWatcher.test.ts` trimmed to the remaining rules; the reader statements under the catalog are already covered by the arc-6 integration cases (kept, the weekly cases dropped).
- Smoke after the deploy: the admin card shows the 7-day average row; a keyword page and the Category Builder still answer; the service's log shows batches continuing after its redeploy; at the 2026-10-20 import: no new `keepa_enrichment_runs` row, the `keepa_enqueue` phase in `import_phase_timings`, new tier-1 products fetched by the service within the day.

## 8. Ship order (each step on the owner's explicit go)

1. Backfill: `BACKFILL_SNAPSHOTS=yes node --env-file=.env.local --import tsx scripts/backfillSnapshotsFromWeekly1015.ts` (before-count ≤ 20,835: the diag's figure also counted delisted fetches, which the seed and the script skip; after-count 0). If the push lands after the 2026-10-20 import has fired the old job once more, run the backfill again after the deploy (idempotent).
2. `scripts/checkActiveJobs.ts` clean → bare `git push origin main` → the three deploys green (the Keepa service redeploys this time).
3. Smoke (§7). Then the owner deletes `KEEPA_READ_SOURCE` from Vercel and Railway (optional, after a green day).
4. Results table and memory; the 2026-10-20 import check.

## 9. Follow-ups (not this arc)

- Decide the archive's fate (export `asin_weekly_data` to R2 as CSV, then drop; or keep) once the snapshot history has covered a full year.
- A weekly service summary email, if wanted later (the owner may revisit).
- A throughput alarm in the watcher (24 h fetched under half the 7-day average).
- Show monthly sold and offer counts on keyword pages (arc 6 §12).

## 10. Conventions

As every arc: commit trailer exactly `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; local commits on `main`, push owner-gated (`scripts/checkActiveJobs.ts` first, bare `git push origin main`); `git add` named files only; no DDL (the backfill is DML, owner-gated, untracked script); lint touched files with `pnpm exec eslint`; EOL-preserving edits (the tree mixes CRLF/LF); `pnpm typecheck` covers tests and untracked scripts; log-safe errors (never a database error's `.message`); never print member emails.
