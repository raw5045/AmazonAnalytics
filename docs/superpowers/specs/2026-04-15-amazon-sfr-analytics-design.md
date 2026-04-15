# Amazon SFR Analytics — Technical Design

Date: 2026-04-15
Owner: Reese
Status: Ready for implementation planning

This document layers the technical architecture, vendor choices, and data-model refinements on top of the approved product spec (`Amazon Analytics App Plan.MD`). The product spec remains the source of truth for product behavior, screens, and acceptance criteria. This document is the source of truth for how it's built.

## 1. Summary of decisions

| Area | Decision |
|---|---|
| Web framework | Next.js (App Router) + TypeScript |
| Hosting | Vercel |
| Database | Neon Postgres |
| ORM | Drizzle |
| Auth | Clerk (Hobby tier) |
| Object storage | Cloudflare R2 (S3-compatible) |
| Background jobs | Inngest |
| Email delivery | Resend + React Email |
| Data tenancy model | Single shared SFR dataset + per-user private layer (watchlists, saved views, alerts, notification preferences) |
| Admin data ingestion | Admin-only uploads, shared dataset visible to all users |

## 2. Data tenancy model

All SFR data is a single shared dataset. The admin uploads files; every user (internal team and future external Amazon sellers) sees the same global keyword, rank, brand, category, and ASIN data. Each user owns their own:

- `saved_views`
- `watchlists` (a `saved_views` row with `is_watchlist = true`)
- `alerts`
- `notification_preferences`

No `tenant_id` column is added anywhere — the `users` table, combined with user-scoped foreign keys on the private-layer tables, is sufficient.

## 3. Authentication and user model

### 3.1 Clerk ownership boundary

Clerk owns: passwords, sessions, email verification, social OAuth, password reset flows, MFA, rate limiting, bot protection.

Neon owns: the app's `users` table (a mirror of Clerk's user directory), role assignments, and all app data.

### 3.2 `users` table (revised from product spec §7.1)

- `id` — UUID, primary key (used by all foreign keys inside the app)
- `clerk_user_id` — unique, indexed string, format `user_...`
- `email` — mirrored from Clerk
- `name` — mirrored from Clerk
- `role` — `admin` | `standard_user`, source-of-truth in Neon, also mirrored to Clerk `publicMetadata.role` for fast JWT-based middleware checks
- `created_at`
- `last_login_at`

### 3.3 Sync mechanism

- **Clerk webhook endpoint** (`/api/webhooks/clerk`) handles `user.created`, `user.updated`, `user.deleted` events. Upserts into `users`. Webhook signature verified.
- **Lazy upsert on first sign-in** as a safety net against webhook race conditions.
- **Role changes** update both `users.role` and Clerk `publicMetadata.role` atomically.

### 3.4 RBAC enforcement (belt and suspenders)

- **Middleware:** Next.js middleware reads Clerk JWT, blocks non-admins from `/admin/*` routes.
- **Server:** every admin API route and server action re-checks role by querying `users.role` from the database (JWTs can be stale).
- **UI:** hide admin navigation for standard users (cosmetic layer only).

### 3.5 First admin bootstrap

A one-time seed script reads `INITIAL_ADMIN_EMAIL` env var and promotes the matching Clerk user to admin. Run once during initial deploy.

## 4. Background job pipeline (Inngest)

### 4.1 Event catalog

- `csv/rubric.uploaded` — admin uploaded the single rubric CSV
- `csv/batch.uploaded` — admin uploaded a ZIP
- `csv/single.uploaded` — admin uploaded a single weekly file
- `csv/file.replace-requested` — admin initiated replace-week flow
- `csv/batch.import-approved` — admin clicked "Import valid files" on a batch
- `summary/refresh-requested` — internal, after successful import
- `alerts/evaluate-requested` — internal, after summary refresh
- `email/deliver-digest` — internal, per user with ≥1 new alert from this import
- `fake-volume/backfill-requested` — internal, after admin activates a new fake-volume rule

### 4.2 Pipelines

#### Rubric pipeline

1. Download CSV from R2
2. Stream-parse rows 1–2 (metadata + header) and a sample of 100 data rows
3. Detect: metadata format, header alignment with required columns, sample value types, `Reporting Date` consistency
4. Write `schema_versions` row with `status = draft`
5. Surface preview to admin UI (polling; realtime not required for V1)
6. On admin approval: set `status = active`, fire `csv/single.uploaded` for the same file so its data actually lands in `keyword_weekly_metrics`

**Rationale for 100-row sample:** The rubric's job is schema detection only. The rubric file's ~1M data rows are imported through the normal single-file pipeline after schema approval, so no data is lost.

#### ZIP backfill pipeline

1. Download ZIP from R2
2. Unzip into temporary R2 prefix `batches/<batch_id>/files/`
3. For each file, parallel fan-out (concurrency cap = 4):
   - Download file
   - Stream-parse + validate against active schema version
   - Write `uploaded_files` + `ingestion_errors` rows with `validation_status`
4. After all files validated, compute batch status (`clean` | `partial_review` | `blocked`) and update `upload_batches`
5. Stop. Admin decides via UI whether to import valid files.

#### Import pipeline (fires on `csv/batch.import-approved` or `csv/single.uploaded`)

1. For each passed file, sequentially ordered by `week_end_date`:
   - Stream CSV into `staging_weekly_metrics` using Postgres `COPY` or batched inserts (5–10k rows per batch)
   - Compute derived fields in staging: `keyword_in_title_1/2/3`, `keyword_title_match_count`, `fake_volume_flag`, `fake_volume_eval_status`, normalized search term
   - Upsert into `search_terms` (new terms get IDs; existing terms get `last_seen_week` bumped)
   - Insert staged rows into `keyword_weekly_metrics`. For replace flow, `ON CONFLICT (week_end_date, search_term_id) DO UPDATE`. For normal flow, `ON CONFLICT DO NOTHING` with duplicate detection surfaced as a validation error earlier.
   - Mark `reporting_weeks` row as loaded
   - Truncate staging for this file
2. After all files imported, fire `summary/refresh-requested`
3. After summary refresh, fire `alerts/evaluate-requested`
4. After alert evaluation, fire `email/deliver-digest` for each user with ≥1 new alert from this import

#### Summary refresh pipeline

- Single idempotent transaction
- Build new `keyword_current_summary` into a shadow table via `INSERT ... SELECT` with CTEs reading from `keyword_weekly_metrics`
- Atomic swap via `ALTER TABLE ... RENAME` inside a transaction
- Refresh `search_terms.first_seen_week` / `last_seen_week`
- All lookback queries (4w/13w/26w/52w-ago, unranked flags, streaks) bound by `WHERE week_end_date >= (latest_week - interval '52 weeks')` so refresh time stays roughly constant year-over-year

#### Alert evaluation pipeline

- For each user's watchlists, compare current summary to user-set thresholds
- Insert rows into `alerts` for each firing condition
- Alert types per product spec §12: threshold crossing, improvement magnitude, fake-volume flag appeared/disappeared, unranked/reappeared

#### Email digest pipeline

- For each user with ≥1 new alert from this import, compose one digest email
- Subject: `Amazon SFR weekly report – N alerts for week ending M/D/YYYY`
- Body: summary count + grouped sections by alert type, deep links back into the app, one-click unsubscribe
- Send via Resend; record `email_resend_id` and `email_sent_at` on the alerts included in the digest
- No between-upload emails; all email activity is gated on a successful weekly import

#### Fake-volume rule backfill pipeline

- Fired when admin activates a new rule version
- Single SQL `UPDATE keyword_weekly_metrics SET fake_volume_flag = ..., fake_volume_eval_status = ..., fake_volume_rule_version_id = <new_id>` evaluated against the new rule
- Triggers summary refresh + alert evaluation so flag changes propagate
- No file re-import required; raw inputs (click share, conversion share) are already stored

### 4.3 Concurrency and safety

- Only one import pipeline runs at a time (Inngest `concurrency: 1` on the import function, keyed by `schema_version_id`)
- Rubric and validation pipelines can run in parallel
- Step-level retries default to 3 attempts with exponential backoff
- File-level import failures do not abort the batch; surfaced as `import_failed` on `uploaded_files`

## 5. Data model refinements

### 5.1 Additions and changes to product spec §7

#### `users` — see §3.2 above

#### `staging_weekly_metrics` (new)

- Identical shape to `keyword_weekly_metrics` plus `batch_id` and `uploaded_file_id`
- Landing zone for streamed CSV parsing before bulk insert
- Truncated per-file after successful import (or retained for debugging on failure)

#### `keyword_weekly_metrics` — partition preparation

- Declared as `PARTITION BY RANGE (week_end_date)` in the initial migration
- Year-bucketed partitions; a yearly job (or lazy creation in the import pipeline) adds next year's partition
- No V1 behavior change; enables future tuning without a painful migration

#### `search_terms` — substring search support

- Requires `pg_trgm` extension (create in initial migration)
- GIN trigram index on `search_term_normalized` to support fast `ILIKE '%capsule%'` queries

#### `keyword_weekly_metrics` — derived fields computed at import

- `keyword_in_title_1/2/3`, `keyword_title_match_count`, `fake_volume_flag`, `fake_volume_eval_status`, `fake_volume_rule_version_id`
- Never recomputed at query time; `fake-volume/backfill-requested` is the only mechanism to rewrite them

#### `reporting_weeks.is_complete` — definition

- `true` only when file imported successfully AND summary refresh completed
- UI banner surfaces incomplete weeks to users so they know what they're looking at

#### `app_settings` — initial seeded keys

- `batch_failure_threshold_pct` = 10
- `unranked_comparison_value` = 1000000
- `row_count_anomaly_low_pct` = 50
- `row_count_anomaly_high_pct` = 200

#### `audit_log` (new)

- `id`, `user_id`, `action`, `entity_type`, `entity_id`, `metadata_json`, `created_at`
- Records significant admin actions: schema approvals, fake-volume rule activations, week replacements, user role changes

#### `notification_preferences` (new)

- `user_id` (PK)
- `email_enabled` — master toggle, default `true`
- `alert_types_enabled_json` — per-type opt-in, default all types on
- `updated_at`

#### `alerts` — additions

- `email_delivery_status` — `pending` | `sent` | `skipped_by_preference` | `failed`
- `email_sent_at`
- `email_resend_id`

### 5.2 Definitions clarified from product spec

- **"Recently" in `top_category_changed_recently` / `top_asin_changed_recently`:** value differs from 4 weeks ago
- **Rubric file data:** always re-queued through single-file import after schema approval
- **Fake-volume rule changes:** never require file re-import; re-evaluate via backfill job against stored inputs

## 6. CSV parser invariants (from sample file analysis)

Derived from `US_Top_Search_Terms_Simple_Week_2026_04_11.csv`:

- **Encoding:** UTF-8. Must handle non-ASCII characters in product titles (curly apostrophes, circumflex vowels, em-dashes). Strip UTF-8 BOM on parse.
- **Line endings:** handle CRLF and LF.
- **Row 1 (metadata):** CSV-escaped quoted fields, format `"Reporting Range=[""Weekly""]","Select week=[""Week N | YYYY-MM-DD - YYYY-MM-DD YYYY""]"` followed by trailing empty cells to match column count. Extract `week_start_date` and `week_end_date` from the `Select week=` field as secondary validation signal.
- **Row 2 (header):** exactly 21 columns, verbatim match against spec §5 column list.
- **Rows 3+:** data rows.
- **Empty trailing rows:** ignore.
- **`Reporting Date` column format:** `M/D/YYYY` with no leading zeros (e.g., `4/11/2026`). Authoritative source of `week_end_date` when consistent across all rows.
- **Share values:** numeric, range `0`–`100`. May be blank (especially in digital-product categories). Strip `%` if present (defensive, not observed in sample).
- **Brand cells:** may be empty (e.g., top clicked brand #1 missing). Not a validation failure.
- **Category values:** Amazon's internal taxonomy names, sometimes misspelled (literal `Commerical_Onemedical_Membership`). Stored as-is without normalization.
- **Quoted fields with embedded commas, quotes, em-dashes:** standard CSV parsing handles.

Parser will be implemented with `csv-parse` streaming mode. No browser-side parsing ever.

## 7. Growth and scale plan

| Timeframe | Weeks loaded | Approx. rows in `keyword_weekly_metrics` | Approx. storage |
|---|---|---|---|
| Year 1 | 52 | ~52 M | ~20–30 GB |
| Year 2 | 104 | ~104 M | ~40–60 GB |
| Year 3 | 156 | ~156 M | ~60–90 GB |
| Year 5 | 260 | ~260 M | ~100–150 GB |

Explorer queries hit `keyword_current_summary` (one row per keyword) and remain fast regardless of total history. Keyword detail queries touch one term × 52 weeks and remain constant-cost.

Reinforcements:

1. Summary refresh queries bound to the latest 52+1 weeks
2. `keyword_weekly_metrics` partitioned by year from day one; partition-level pruning kicks in around year 2 (~100M rows)
3. Optional future archival: dump pre-3-year-old weeks to R2 as Parquet, drop from Neon — not a V1 concern, mentioned so the door is open

Neon Pro pricing (verify at neon.tech/pricing before locking in): ~$19/mo base + ~$0.50/GB/mo beyond 10 GB. Year 2 storage of ~50 GB ≈ ~$25/mo incremental.

## 8. Screens — additions to product spec §11

In addition to the screens enumerated in the product spec:

### Admin settings page (new)

- Batch failure threshold (%)
- Row-count anomaly thresholds
- Fake-volume rule editor: create/edit/activate rule versions; "Activate" triggers backfill
- User management: list users, promote/demote admin

### User notification preferences (new)

- Master email toggle
- Per-alert-type checkboxes
- Unsubscribe link in every email hits a secure one-click endpoint

### Weekly completeness banner (new, global)

- Shown on explorer + detail pages whenever loaded week range has gaps or incomplete weeks
- Click-through to admin upload history for admin users

## 9. API additions

In addition to endpoints enumerated in product spec §14:

- `POST /admin/fake-volume-rules` — create rule version
- `POST /admin/fake-volume-rules/:id/activate` — activate + trigger backfill
- `GET /admin/settings` / `PATCH /admin/settings` — `app_settings` CRUD
- `POST /admin/users/:id/role` — promote/demote
- `GET /me/notification-preferences` / `PATCH /me/notification-preferences`
- `POST /api/webhooks/clerk` — Clerk user sync webhook
- `GET /api/unsubscribe?token=...` — one-click email unsubscribe

## 10. Environments and deployment

- **Production:** Vercel production deployment, Neon main branch, Clerk production app, R2 production bucket, Inngest production environment, Resend production API key
- **Staging:** Vercel preview deployments per branch, Neon branch `staging` (cheap and fast), Clerk development app (free, unlimited apps on Hobby), separate R2 bucket, Inngest dev environment, Resend test mode
- **Local development:** same Clerk dev app, Neon branch `dev` or local Postgres, local Inngest dev server (`npx inngest-cli dev`), R2 dev bucket

### Env vars (non-exhaustive)

- `DATABASE_URL`
- `CLERK_SECRET_KEY`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_WEBHOOK_SIGNING_SECRET`
- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`
- `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`
- `RESEND_API_KEY`, `EMAIL_FROM_ADDRESS`, `EMAIL_FROM_NAME`
- `APP_PUBLIC_URL`
- `INITIAL_ADMIN_EMAIL`

## 11. Testing strategy

- **Unit tests** (Vitest): parser with fixtures — valid file, missing header, mixed dates, blank shares, malformed CSV, UTF-8 with BOM, non-ASCII chars
- **Integration tests:** full pipeline (rubric → validate → import → summary → alert) against a Neon branch seeded from fixtures
- **End-to-end smoke tests** (Playwright): 1–2 critical paths (auth + upload + explorer)

Broader E2E coverage deferred past V1 (low ROI at current scale).

## 12. Observability

- **Inngest dashboard:** job logs, retries, step-level visibility
- **Vercel logs + Sentry:** Next.js errors (Sentry free tier)
- **Neon metrics:** connection count, query performance, storage
- **`audit_log` table:** admin-action trail for schema approvals, rule activations, week replacements, role changes

## 13. Open items for implementation time

None blocking. Items to resolve during build rather than now:

- Exact column types for staging vs final tables (decimal precision for share values, varchar lengths for titles)
- Exact Drizzle migration layout
- Sentry project setup
- DNS setup for Resend verified sending domain
- Neon branching CLI workflow for CI

## 14. Relationship to product spec

The product spec (`Amazon Analytics App Plan.MD`) remains the source of truth for:

- Product behavior
- Screen requirements
- Acceptance criteria for V1
- Validation rules and check definitions
- Analytics definitions (improvement calculations, streaks, title-gap, etc.)
- Build phase ordering

This design document is the source of truth for:

- Technology stack and vendors
- Data tenancy model
- Auth and user sync
- Background job architecture
- Data model additions (`staging_weekly_metrics`, `audit_log`, `notification_preferences`)
- Partition and scale plan
- CSV parser invariants
- Environment layout

Any conflict between the two should be reconciled in favor of the later-approved decision, and both documents should be updated to stay in sync.
