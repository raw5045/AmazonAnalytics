# Plan 2 — Ingestion Design

Date: 2026-04-18
Owner: Reese
Status: Ready for implementation planning

This document specifies the Phase 1 (Ingestion) build of the Amazon SFR Analytics app. It layers on top of:

- The approved product spec (`docs/superpowers/specs/Amazon Analytics App Plan.MD`)
- The approved technical design (`docs/superpowers/specs/2026-04-15-amazon-sfr-analytics-design.md`)
- The completed Plan 1 (Foundation) implementation (merged as PR #1)

Where this document differs from the earlier docs, the later-approved decision wins. Documented deviations are called out in §10.

## 1. Scope

### In scope for Plan 2

- Multi-file bulk upload UI (replaces the original ZIP-based backfill flow)
- Single-file weekly upload UI (ongoing uploads after backfill)
- Full CSV validation pipeline (all hard-fail, warning, informational checks from product spec §6.5)
- Staging tables and the `keyword_weekly_metrics` partitioned table
- Batch concept: group of files uploaded in one session, with health reporting
- Replace-week flow (detect duplicate `week_end_date`, allow admin replacement)
- Admin UI: bulk upload, batch health page, upload history
- Audit trail: per-file validation errors, per-row ingestion errors
- Import pipeline that streams CSV from R2 into staging, then promotes to `keyword_weekly_metrics`
- `summary/refresh-requested` event fired at end of import (handler deferred to Plan 3)

### Out of scope — deferred to Plan 3+

- `keyword_current_summary` refresh
- Keyword explorer page
- Keyword detail page
- Fake-volume evaluation during import (schema column exists but left null in Plan 2)
- Substring search on search terms (GIN trigram index exists; querying is Plan 3)
- Watchlists, saved views, alerts
- Email digest pipeline
- Admin settings / fake-volume rule editor

## 2. Sizing assumptions (revised from original design doc)

Real file size analysis changed several assumptions from the original design doc. Plan 2 is built for these numbers:

| Item | Original assumption | Revised |
|---|---|---|
| Rows per weekly CSV | ~1M | ~2.7M |
| File size per weekly CSV | ~23MB | ~1.5GB |
| 52-week total row count | ~52M | ~140M |
| Neon storage year 1 | ~20–30GB | ~100–150GB |
| Neon cost year 1 | ~$5/mo incremental | ~$50–100/mo incremental |

Accepted as current reality. Does not block Plan 2. Partitioning is now mandatory from day one (not optional), and streaming CSV parsing is required.

## 3. Upload strategy

### Decision: multi-file bulk upload with presigned R2 URLs (not ZIP)

The original product spec §6.2 described a ZIP-based historical backfill. Given revised file sizes (1.5GB each, 22GB+ ZIP for a full backfill), ZIP uploads require multipart upload, server-side unzip, and significant intermediate storage. Multi-file bulk upload is simpler and more resilient.

**Flow:**

1. Admin visits bulk upload page, selects or drag-drops N CSV files
2. Browser calls `POST /api/admin/batches` → server creates an `upload_batch` row, returns `batchId`
3. Browser calls `POST /api/admin/batches/:id/presign` with filenames/sizes → server inserts one `uploaded_files` row per file and returns presigned R2 PUT URLs
4. Browser uploads files directly to R2 in parallel (concurrency limit 4), bypassing Vercel entirely
5. As each upload completes, browser calls `POST /api/admin/batches/:id/files/:fileId/complete`, which fires `csv/file.validate` Inngest event
6. Validation runs asynchronously per file; UI polls or refreshes batch health page to show progress
7. Once all files validated, admin clicks **Import valid files** or **Cancel batch**
8. Import pipeline runs sequentially file-by-file (ordered by `week_end_date`), promoting rows from staging to `keyword_weekly_metrics`
9. At end of batch, fire `summary/refresh-requested` (no-op in Plan 2)

**Concurrency:** Admin may upload additional batches while an earlier batch is still importing. Inngest `concurrency: 1` on the import function serializes actual imports; validation and upload can happen in parallel.

**Single-file weekly upload** uses the same pipeline under a simpler UI — one file forms a single-file batch.

## 4. Upload UX

### `/admin/upload` (bulk)

- Drop zone / multi-file picker accepting `.csv` only
- On file selection, batch is created server-side
- Per-file progress rows: filename, size, upload %, then validation status
- Admin can continue adding files to the same batch until clicking **Finalize batch**
- **Finalize** transitions batch from `uploading` to one of: `clean`, `partial_review`, `blocked` based on per-file validation outcomes and the batch failure threshold (default 10%, from `app_settings.batch_failure_threshold_pct`)

### `/admin/upload/single`

Simpler single-file variant. Same backend pipeline. Used for weekly ongoing uploads.

### `/admin/batches/[id]` (batch health)

- Header: batch status, file counts (total / pass / warn / fail), created by, created at
- Per-file table: filename, detected `week_end_date`, row count, validation status, error/warning counts, link to file detail
- **Missing weeks panel** — shows globally missing weeks across all loaded data, not just this batch
- **Duplicate weeks panel** — files trying to load an already-loaded week; offers "Replace week X" action per file
- **Failed files accordion** — per-file hard-fail reasons
- **Warnings accordion** — per-file warnings
- **Informational stats accordion** — per-file blank-share counts etc.
- **Action buttons** (conditional on status): `Import valid files`, `Cancel batch`, `Retry failed files`

### `/admin/batches/[id]/files/[fileId]` (file detail)

- Raw parsed metadata
- Full validation error list with row numbers
- Full warning list
- Informational stats
- Link to original file in R2 (admin-only signed URL, 10-min expiry)

### `/admin/uploads` (history)

- Flat table of all batches and single-file uploads
- Columns: date, type (bulk / single / single-replace), user, file count, status, % passed, link to batch
- Filters: status, type, date range
- Links through to batch health pages

### Replace-week flow

1. Validation detects `week_end_date` already in `reporting_weeks` → `validation_status = 'fail'` with code `WEEK_ALREADY_LOADED`
2. Batch health page surfaces the duplicate in the "Duplicate weeks panel"
3. Admin clicks **Replace week X with file Y** → confirmation modal
4. On confirm: `uploaded_files.is_replacement = true`, `replaces_file_id = <old file id>`; old file row flagged with `replaced_at`
5. Admin can now import this file; pipeline uses replace semantics (see §6.3)
6. Old `keyword_weekly_metrics` rows for that week are deleted; new rows inserted; audit trail preserved through both `uploaded_files` rows remaining in history

## 5. Data model additions

### 5.1 New tables

#### `staging_weekly_metrics`

Ephemeral landing zone. Schema mirrors `keyword_weekly_metrics` plus:

- `batch_id` (uuid, not null)
- `uploaded_file_id` (uuid, not null)

Truncated per-file after successful promotion to `keyword_weekly_metrics`. No indexes beyond what's needed for per-file truncate.

#### `reporting_weeks`

- `week_end_date` (date, PK)
- `week_start_date` (date, not null)
- `source_file_id` (uuid, fk → `uploaded_files.id`)
- `is_complete` (boolean, default false)
- `created_at` (timestamptz, default now)

Set to `is_complete = true` only when a file's import pipeline completes. (Plan 3 will also require summary refresh to complete before flipping this flag; Plan 2 sets it at import completion.)

#### `search_terms`

- `id` (uuid, PK, default random)
- `search_term_raw` (varchar 512, not null)
- `search_term_normalized` (varchar 512, not null)
- `first_seen_week` (date, not null)
- `last_seen_week` (date, not null)
- `created_at` (timestamptz, default now)

**Indexes:**
- `UNIQUE(search_term_normalized)`
- GIN trigram index on `search_term_normalized` (requires `pg_trgm` extension)

#### `keyword_weekly_metrics` (partitioned)

Declared as `PARTITION BY RANGE (week_end_date)`. Year-bucketed partitions created lazily by the import pipeline when a week in a new year is first imported.

Columns:
- `week_end_date` (date, not null)
- `search_term_id` (uuid, not null, fk → `search_terms.id`)
- `actual_rank` (integer, not null)
- `top_clicked_brand_1` / `_2` / `_3` (varchar 255, nullable)
- `top_clicked_category_1` / `_2` / `_3` (varchar 255, nullable)
- `top_clicked_product_1_asin` / `_2_asin` / `_3_asin` (varchar 20, nullable)
- `top_clicked_product_1_title` / `_2_title` / `_3_title` (text, nullable)
- `top_clicked_product_1_click_share` / `_2_click_share` / `_3_click_share` (numeric(5,2), nullable)
- `top_clicked_product_1_conversion_share` / `_2_conversion_share` / `_3_conversion_share` (numeric(5,2), nullable)
- `keyword_in_title_1` / `_2` / `_3` (boolean, nullable)
- `keyword_title_match_count` (smallint, nullable — 0/1/2/3)
- `fake_volume_flag` (boolean, nullable — Plan 2 leaves null)
- `fake_volume_eval_status` (enum, nullable — Plan 2 leaves null)
- `fake_volume_rule_version_id` (uuid, nullable — Plan 2 leaves null)
- `source_file_id` (uuid, not null, fk → `uploaded_files.id`)
- `created_at` (timestamptz, default now)

**Primary key:** `(week_end_date, search_term_id)` (composite — required for partitioning)

**Indexes:**
- `(week_end_date, actual_rank)`
- `(search_term_id, week_end_date)`
- `(week_end_date, top_clicked_category_1)`

### 5.2 New enum

`fake_volume_eval_status`: `evaluated` | `unknown_missing_conversion` | `unknown_missing_click`

Created in migration but unused in Plan 2.

### 5.3 Extension

`CREATE EXTENSION IF NOT EXISTS pg_trgm;`

Needed for the search_terms GIN trigram index.

### 5.4 Column addition to `uploaded_files`

Plan 2 adds one column to the existing `uploaded_files` table for replace-flow bookkeeping:

- `replaced_at` (timestamptz, nullable) — set when another file's import supersedes this one via replace flow

### 5.5 Migration strategy

Split across 2–3 migrations for readability:

- Migration `0002`: `pg_trgm` extension + `fake_volume_eval_status` enum + `search_terms` + `reporting_weeks` + `ALTER TABLE uploaded_files ADD COLUMN replaced_at`
- Migration `0003`: `keyword_weekly_metrics` partitioned parent + initial year partitions for weeks in the backfill (e.g., `keyword_weekly_metrics_2024`, `_2025`, `_2026`)
- Migration `0004`: `staging_weekly_metrics`

## 6. Pipeline processing

### 6.1 Validation pipeline

Fires on `csv/file.validate`. Designed to stay within Inngest step timeouts (~2 min per step on free tier).

Runs per-file, fast (~10–60 seconds):

1. `step.run('download-head')` — fetch first ~10MB from R2 (enough for metadata row + header + thousands of data rows)
2. `step.run('parse-schema')` — validate headers against active schema, metadata row format, `Reporting Date` extraction
3. `step.run('stream-check')` — stream entire file from R2, accumulate: total row count, duplicate search term detection (hash-set), reporting date consistency, rank validity, share value numericness and range
4. `step.run('compute-stats')` — blank share counts by product slot, blank share counts by top category, row count anomaly vs rolling 4-week average
5. `step.run('finalize-validation')` — write `validation_status`, `validation_errors_json`, `validation_warnings_json`, `validation_info_json` to `uploaded_files`; write per-row error details to `ingestion_errors`

Hard-fail checks exit early. Warnings accumulate. Informational stats always collected.

### 6.2 Import pipeline

Fires on `csv/batch.import-approved`. Processes files sequentially within the batch, ordered by `week_end_date` ascending.

Per file, five logical steps (actual step count may be higher due to checkpoint/retry pattern):

1. **Stream to staging** — open R2 stream, parse CSV via `csv-parse` streaming mode, bulk-insert chunks of 500 rows into `staging_weekly_metrics`. Target throughput: 30–50k rows/sec. A 2.7M-row file takes ~60–90 seconds. If step approaches timeout, commit progress (last row number) to `uploaded_files.row_count_loaded` and let Inngest retry from that offset.
2. **Upsert search terms** — one SQL: `INSERT INTO search_terms (search_term_raw, search_term_normalized, first_seen_week, last_seen_week) SELECT DISTINCT ... FROM staging_weekly_metrics WHERE uploaded_file_id = $1 ON CONFLICT (search_term_normalized) DO UPDATE SET last_seen_week = GREATEST(...)`
3. **Compute derived fields** — SQL update on staging: set `keyword_in_title_1/2/3`, `keyword_title_match_count`. Normalized phrase-containment rule per product spec §10.9.
4. **Promote to keyword_weekly_metrics** — `INSERT INTO keyword_weekly_metrics SELECT ... FROM staging_weekly_metrics WHERE uploaded_file_id = $1 ON CONFLICT (week_end_date, search_term_id) DO NOTHING`. For replace flow, use `DO UPDATE` semantics inside a transaction (see §6.3).
5. **Mark week loaded + cleanup** — `INSERT INTO reporting_weeks ... ON CONFLICT DO UPDATE SET is_complete = true`; `DELETE FROM staging_weekly_metrics WHERE uploaded_file_id = $1`; `UPDATE uploaded_files SET validation_status = 'imported', imported_at = now()`.

### 6.3 Replace-week pipeline

Variant of the import pipeline. At the "promote" step:

```sql
BEGIN;
DELETE FROM keyword_weekly_metrics WHERE week_end_date = $1;
INSERT INTO keyword_weekly_metrics SELECT ... FROM staging_weekly_metrics WHERE uploaded_file_id = $2;
UPDATE reporting_weeks SET source_file_id = $2, is_complete = true WHERE week_end_date = $1;
UPDATE uploaded_files SET replaced_at = now() WHERE id = $3; -- old file
COMMIT;
```

Atomic. Old `uploaded_files` row remains in audit history flagged with `replaced_at`.

### 6.4 Batch finalization

After all files in a batch are imported:

1. `step.run('update-batch-status')` — set `upload_batches.status = 'imported'` or `'imported_partial'`
2. `step.sendEvent('summary/refresh-requested')` — handoff to Plan 3 (currently no-op)

### 6.5 CSV streaming parser

Plan 1 used `csv-parse/sync`. Plan 2 switches to the async streaming API:

```ts
import { parse } from 'csv-parse';
import { Readable } from 'node:stream';

const stream = (await r2.send(new GetObjectCommand({...}))).Body as Readable;
const parser = stream.pipe(parse({ columns: true, skip_empty_lines: true, relax_quotes: true }));

let buffer: Row[] = [];
for await (const record of parser) {
  buffer.push(record);
  if (buffer.length >= 500) {
    await insertBatch(buffer);
    buffer = [];
  }
}
if (buffer.length) await insertBatch(buffer);
```

Constant memory regardless of file size. `relax_quotes: true` carries over from Plan 1's parser.

### 6.6 Error handling and retries

- Inngest step retries: 3 attempts with exponential backoff
- Staging table acts as the checkpoint — retried steps can query staging for `uploaded_file_id` rows to see what's already loaded and resume from there
- File-level import failure does not abort the batch; failed file gets `validation_status = 'import_failed'`; remaining files continue
- Admin can click "Retry failed files" on batch health page

## 7. Validation rules (summary from product spec §6.5)

### Hard fail

- Unreadable / malformed CSV
- Required headers missing or mismatched against active schema version
- Mixed `Reporting Date` within same file
- Invalid `Search Frequency Rank` (non-numeric, ≤0)
- Duplicate `Search Term` within same week
- `week_end_date` already in `reporting_weeks` AND replace mode not selected
- Zero valid data rows after trimming
- Click/conversion share non-numeric when present
- Click/conversion share outside 0–100 range when present

### Warnings (pass_with_warnings)

- Row count drift: ≥50% below or ≥200% above rolling 4-week average
- Metadata row format drift (data rows still parse cleanly)
- Blank-share rate shift ≥20pp vs recent average

### Informational (stored, never fails file)

- Blank conversion share count per product slot
- Blank click share count per product slot
- Blank-share counts broken out by top category
- % of rows with ≥1 blank share field

All results persisted to `uploaded_files.validation_*_json`; per-row errors to `ingestion_errors`.

## 8. API endpoints

Added in Plan 2:

```
POST   /api/admin/batches                                    — create new batch
POST   /api/admin/batches/:id/presign                        — get presigned URLs for N files
POST   /api/admin/batches/:id/files/:fileId/complete         — notify upload complete, trigger validation
POST   /api/admin/batches/:id/finalize                       — stop accepting new files
POST   /api/admin/batches/:id/import                         — run import pipeline
POST   /api/admin/batches/:id/cancel                         — cancel unimported batch
POST   /api/admin/files/:id/replace                          — enter replace flow for duplicate week
GET    /api/admin/batches                                    — list batches (history)
GET    /api/admin/batches/:id                                — batch health
GET    /api/admin/batches/:id/files/:fileId                  — file detail with errors
```

All routes require `requireAdmin`. CSRF protection via Clerk session.

## 9. Testing strategy

### Unit tests (Vitest, mocked DB)

- Streaming parser: correctness on small fixtures, malformed fixtures, UTF-8 BOM, non-ASCII content
- Each validation check: one test per rule (~15 tests)
- Derived field computation (`keyword_in_title_*`, `keyword_title_match_count`)
- Batch decision policy (clean / partial_review / blocked)
- Each API route: auth check, input validation, happy path, error paths

### Integration tests (real Neon + real R2 dev bucket)

- End-to-end: presign → upload small fixture → validate → import → verify rows in `keyword_weekly_metrics`
- Replace-week flow end-to-end
- Duplicate-week rejection (without replace flag)
- Warning file path (pass_with_warnings)
- Cross-batch duplicate detection

### Manual smoke test

- Single real 1.5GB file uploaded via deployed site → batch completes → row count in Neon matches file
- Once single-file works, 36-file batch via bulk upload

### Performance validation during integration tests

- Log throughput during staging inserts (target ≥30k rows/sec)
- Log total import wall-clock for a 2.7M-row file (target ≤3 minutes)

## 10. Deviations from earlier documents

Documented here for auditability. Where this plan deviates, this plan wins.

1. **ZIP backfill removed (product spec §6.2).** Real file sizes (1.5GB each, 22GB+ ZIP) make ZIP upload a poor fit. Replaced by multi-file bulk upload with presigned R2 URLs. Same batch/validation/import semantics; different packaging.

2. **Row count expectations revised (design doc §7).** Originally ~1M rows/file = 52M total. Actual is ~2.7M rows/file = 140M total. Neon cost estimate revised from ~$5/mo to ~$50–100/mo for year 1. Partitioning enabled from day one instead of at year 2.

3. **CSV parser switched from sync to streaming (design doc §4.2).** Plan 1 used `csv-parse/sync` for the rubric flow (100-row sample). Plan 2 requires streaming for full-file imports because files are too large for sync parsing.

4. **Staging table promotion pattern explicit (design doc §4.2).** Design doc described staging + promotion at a high level. Plan 2 specifies the exact 5-step promotion pipeline and the checkpoint-and-retry pattern for large-file imports.

5. **`reporting_weeks.is_complete` flag semantics adjusted (design doc §5.1).** Design doc said `is_complete = true` only after summary refresh. Plan 2 flips it at import completion (summary refresh is Plan 3). When Plan 3 lands, semantics may be revisited.

## 11. Open items for implementation time

- Exact column precision for `numeric(5,2)` shares — might need to adjust if real data has more significant digits than observed in sample
- Whether to use Postgres `COPY` via a temporary file or stick with batched `INSERT` — benchmark during implementation, pick whichever clears 30k rows/sec target
- Whether presign endpoint issues N URLs per call or one per call — small optimization, decide during implementation

## 12. Plan 2 success criteria

Plan 2 is done when all of these are true:

- [ ] Admin can upload a single 1.5GB file via `/admin/upload/single`, validation + import completes, rows are in `keyword_weekly_metrics`
- [ ] Admin can upload 36+ files via `/admin/upload`, batch health page reflects per-file status, import runs successfully
- [ ] Duplicate week upload is rejected with `WEEK_ALREADY_LOADED`
- [ ] Replace-week flow works: old week data replaced, old file flagged `replaced_at`, new data present
- [ ] Upload history page lists all batches with correct statuses
- [ ] Unit tests pass (target: 40+ tests across 10+ files)
- [ ] Integration tests pass against Neon dev branch
- [ ] Typecheck passes
- [ ] Build succeeds
- [ ] Deployed app smoke-tests pass: one real file imports end-to-end
- [ ] `csv/batch.import-approved` event fires `summary/refresh-requested` at end of batch (event visible in Inngest, handler is no-op in Plan 2)

## 13. Relationship to Plan 3

Plan 3 will build on the data Plan 2 lands:

- Summary refresh pipeline (the no-op event Plan 2 fires)
- `keyword_current_summary` table
- Keyword explorer
- Keyword detail page
- Fake-volume evaluation during import (Plan 2 leaves these columns null; Plan 3 backfills + evaluates going forward)
- Substring search on search terms (uses the `pg_trgm` GIN index Plan 2 creates)

Nothing in Plan 3 requires re-importing data from Plan 2. Column additions are forward-compatible.
