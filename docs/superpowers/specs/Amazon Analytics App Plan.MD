# Amazon SFR Analytics App - Build Spec

Version: Draft V1  
Owner: Reese  
Status: Approved planning baseline

## 1\. Product goal

Build a web application that ingests weekly Amazon Search Frequency Rank CSV reports, validates schema consistency before import, stores parsed data for analysis, and gives users fast ways to find meaningful keyword movement over time.

The app must support:

* initial historical backfill from about 52 weekly files
* ongoing weekly uploads
* admin-only upload access
* schema drift detection and upload health checks
* keyword trend analysis based on **Search Frequency Rank**
* a configurable fake-volume filter
* user accounts, watchlists, and alerts

## 2\. Core terminology

### Search Frequency Rank (SFR)

This app should use the term **Search Frequency Rank**, not “Search Frequency.”

* lower rank is better
* rank `1` is the most searched term in that weekly report
* improvement means rank number gets smaller
* decline means rank number gets larger

### Actual rank

The true rank from Amazon when a keyword is present in a weekly file.

### Unranked

A keyword is treated as **unranked** for a given week if it does not appear in that week’s report.

In raw storage, unranked should not overwrite source truth. The source row simply does not exist for that week.

### Comparison rank V1

For limited internal comparisons that need a numeric fallback, V1 will use:

`comparison\_rank\_v1 = COALESCE(actual\_rank, 1000000)`

This is a convenience value for analytics only. It is not source truth.

### Fake-volume flag

A keyword flag based on weak conversion relative to strong click share.

## 3\. V1 scope

### In scope

* single-file rubric upload to define and approve the first schema version
* bulk ZIP historical backfill
* per-file validation inside a batch
* batch health page with clear fail reasons per file
* ability to import valid files when batch failures stay below a configurable threshold
* admin replacement of an already imported week
* Neon-backed analytics data model
* keyword explorer with core filters and saved views/watchlists
* keyword detail page with 52-week history
* in-app alerts generated after each successful upload
* admin and standard-user roles

### Out of scope for V1

* a polished dedicated analytics module for category-shift and ASIN-shift leaderboards
* email alerts as a hard requirement
* multiple ranked/unranked comparison modes in the UI
* automatic imputation of blank conversion share values
* advanced anomaly detection beyond rule-based checks

## 4\. Recommended architecture

### Application layer

* Next.js with TypeScript
* server-rendered dashboard pages where possible
* backend API routes or server actions for uploads and query endpoints

### Database

* Neon Postgres for application data and analytics tables

### Raw file storage

* S3-compatible object storage for original CSV and ZIP files
* store raw files for audit, replay, and future reprocessing

### Background processing

* imports must run as background jobs, not inside a live web request
* parsing, staging, validation, import, summary refresh, and alert generation should all happen asynchronously

### Authentication and roles

* user accounts from day one
* role-based access control:

  * `admin`
  * `standard\_user`

### Why this architecture

The expected historical baseline is large. If weekly files are near 1M rows and 52 weeks are loaded, the system may hold about 52M observed keyword-week rows. That is big enough that uploads, summary refreshes, and alerts should be treated as a real data pipeline.

## 5\. Source file expectations

Based on the sample file, the parser should expect:

* row 1: metadata row
* row 2: true header row
* rows 3+: data rows
* quoted CSV fields with commas inside product titles
* one reporting date repeated across all data rows
* possible blank trailing rows to ignore

### Required columns for schema version 1

1. Search Frequency Rank
2. Search Term
3. Top Clicked Brand #1
4. Top Clicked Brands #2
5. Top Clicked Brands #3
6. Top Clicked Category #1
7. Top Clicked Category #2
8. Top Clicked Category #3
9. Top Clicked Product #1: ASIN
10. Top Clicked Product #1: Product Title
11. Top Clicked Product #1: Click Share
12. Top Clicked Product #1: Conversion Share
13. Top Clicked Product #2: ASIN
14. Top Clicked Product #2: Product Title
15. Top Clicked Product #2: Click Share
16. Top Clicked Product #2: Conversion Share
17. Top Clicked Product #3: ASIN
18. Top Clicked Product #3: Product Title
19. Top Clicked Product #3: Click Share
20. Top Clicked Product #3: Conversion Share
21. Reporting Date

### Date handling

The `Reporting Date` column should be treated as the authoritative `week\_end\_date` if it is consistent across all rows in a file.

The metadata row should also be stored, but used as a secondary validation signal rather than the primary source of truth.

## 6\. Upload and ingestion workflow

## 6.1 Rubric setup flow

Purpose: let admin upload a single file first so the system can learn the expected structure before the historical backfill.

Flow:

1. Admin uploads one CSV file.
2. System parses it into a staging area.
3. System detects:

   * metadata row
   * header row
   * required columns
   * sample values and types
   * week end date
4. System shows a schema preview screen.
5. Admin approves the mapping.
6. System creates `schema\_version = 1`.

Important: the first file creates a **proposed and approved schema version**, not an untouchable forever-rule.

## 6.2 Bulk ZIP historical backfill

Flow:

1. Admin uploads a ZIP file of weekly CSV reports.
2. System stores the ZIP in raw storage.
3. System unzips into a staging area.
4. System validates each file individually against the active schema version.
5. System builds a batch health report.
6. Admin reviews:

   * passed files
   * warning files
   * failed files
   * missing weeks
   * duplicate weeks
7. Admin chooses whether to import valid files.

## 6.3 Ongoing weekly uploads

After the historical load, admin can upload one weekly CSV at a time.

Flow is the same validator, just without the ZIP extraction step.

## 6.4 Replace-week flow

Admin can re-upload a corrected file for an already loaded week.

Rules:

* system detects duplicate `week\_end\_date`
* admin can choose `replace existing week`
* old imported file remains in audit history
* replacement triggers rebuild of derived summaries and alerts for affected windows

## 6.5 Validation checks

Each file should be run through the following checks before import.

### Hard fail checks

* unreadable or malformed CSV
* true header row not found
* required columns missing
* header mismatch against schema version
* mixed `Reporting Date` values within the same file
* invalid `Search Frequency Rank` values
* duplicate `Search Term` rows inside the same week
* week already exists and replace mode was not selected
* zero valid data rows after trimming blanks
* present click-share or conversion-share values that are non-numeric
* present click-share or conversion-share values outside the allowed range `0` to `100`

### Informational checks

These should not fail a file in V1. They should be shown on the admin health page so we can learn the real blank-share behavior, especially in digital-product categories.

* blank conversion-share counts by product slot
* blank click-share counts by product slot
* blank-share counts broken out by top clicked category #1
* percentage of rows with one or more blank share fields

### Warning checks

* row count is unusually small or large relative to recent file history or rolling baseline
* metadata row format drift when data rows still parse cleanly
* blank-share rates that shift materially versus recent history
* unusual but still valid share distributions that stay inside the allowed numeric range

### Validation outputs per file

Each file should receive:

* `pass`
* `pass\_with\_warnings`
* `fail`

Validation details, warning details, and info stats must be stored and shown on the admin health page.

## 6.6 Batch decision policy

This section reflects the agreed batch behavior.

### Batch thresholds

* configurable failure threshold
* default threshold: `10%` of files in the ZIP batch

### Batch status rules

#### `clean`

No failed files.

#### `partial\_review`

Failed file percentage is below the threshold.

Behavior:

* do not silently auto-import
* show exactly which files failed and why
* show which weeks will be missing if only valid files are imported
* allow admin to import valid files only
* mark batch as incomplete until failed files are re-uploaded or explicitly dismissed

#### `blocked`

Failed file percentage is greater than or equal to the threshold.

Behavior:

* block batch import
* output specific per-file fail reasons
* recommend schema review or corrected re-upload

### Why this policy was chosen

This keeps the system practical. A few isolated bad files should not force the whole backfill to be thrown away. But if too many files fail, it is more likely the schema assumptions are wrong and the batch should stop.

## 7\. Data model

## 7.1 Users

### `users`

* `id`
* `email`
* `name`
* `role` (`admin`, `standard\_user`)
* `created\_at`
* `last\_login\_at`

## 7.2 Schema management

### `schema\_versions`

* `id`
* `version\_number`
* `status` (`draft`, `active`, `retired`)
* `header\_row\_index`
* `required\_columns\_json`
* `header\_hash`
* `sample\_file\_id`
* `approved\_by\_user\_id`
* `approved\_at`
* `notes`

## 7.3 Upload audit

### `upload\_batches`

* `id`
* `batch\_type` (`single\_csv`, `zip\_backfill`)
* `status` (`uploaded`, `validating`, `clean`, `partial\_review`, `blocked`, `importing`, `imported`, `imported\_partial`, `failed`)
* `schema\_version\_id`
* `failure\_threshold\_pct`
* `total\_files`
* `passed\_files`
* `warning\_files`
* `failed\_files`
* `created\_by\_user\_id`
* `created\_at`
* `completed\_at`
* `summary\_json`

### `uploaded\_files`

* `id`
* `batch\_id`
* `schema\_version\_id`
* `storage\_key`
* `original\_filename`
* `file\_checksum`
* `week\_end\_date`
* `week\_start\_date`
* `reporting\_date\_raw`
* `metadata\_row\_raw`
* `validation\_status`
* `validation\_errors\_json`
* `validation\_warnings\_json`
* `validation\_info\_json`
* `row\_count\_raw`
* `row\_count\_loaded`
* `is\_replacement`
* `replaces\_file\_id`
* `imported\_at`

### `ingestion\_errors`

* `id`
* `uploaded\_file\_id`
* `severity`
* `code`
* `message`
* `row\_number`
* `column\_name`
* `created\_at`

## 7.4 Calendar weeks

### `reporting\_weeks`

* `week\_end\_date` (primary key)
* `week\_start\_date`
* `source\_file\_id`
* `is\_complete`
* `created\_at`

This table defines the loaded weekly calendar for the dataset.

## 7.5 Search terms

### `search\_terms`

* `id`
* `search\_term\_raw`
* `search\_term\_normalized`
* `first\_seen\_week`
* `last\_seen\_week`
* `created\_at`

Normalization rules:

* lowercase
* trim outer whitespace
* collapse repeated internal spaces if desired
* preserve the raw source term separately

## 7.6 Observed weekly metrics

### `keyword\_weekly\_metrics`

Store only rows that actually exist in the source files.

* `week\_end\_date`
* `search\_term\_id`
* `actual\_rank`
* `top\_clicked\_brand\_1`
* `top\_clicked\_brand\_2`
* `top\_clicked\_brand\_3`
* `top\_clicked\_category\_1`
* `top\_clicked\_category\_2`
* `top\_clicked\_category\_3`
* `top\_clicked\_product\_1\_asin`
* `top\_clicked\_product\_1\_title`
* `top\_clicked\_product\_1\_click\_share`
* `top\_clicked\_product\_1\_conversion\_share`
* `top\_clicked\_product\_2\_asin`
* `top\_clicked\_product\_2\_title`
* `top\_clicked\_product\_2\_click\_share`
* `top\_clicked\_product\_2\_conversion\_share`
* `top\_clicked\_product\_3\_asin`
* `top\_clicked\_product\_3\_title`
* `top\_clicked\_product\_3\_click\_share`
* `top\_clicked\_product\_3\_conversion\_share`
* `keyword\_in\_title\_1`
* `keyword\_in\_title\_2`
* `keyword\_in\_title\_3`
* `keyword\_title\_match\_count`
* `fake\_volume\_flag`
* `fake\_volume\_eval\_status` (`evaluated`, `unknown\_missing\_conversion`, `unknown\_missing\_click`)
* `fake\_volume\_rule\_version\_id`
* `source\_file\_id`
* `created\_at`

Primary key:

* `(week\_end\_date, search\_term\_id)`

Important: missing rows mean unranked. Do not materialize absent weeks as raw rows in this table.

## 7.7 Current summary table

### `keyword\_current\_summary`

One row per keyword for the latest fully loaded week. Refreshed after each successful import.

Suggested columns:

* `search\_term\_id`
* `current\_week\_end\_date`
* `current\_rank`
* `prior\_week\_rank`
* `rank\_4w\_ago`
* `rank\_13w\_ago`
* `rank\_26w\_ago`
* `rank\_52w\_ago`
* `improvement\_1w`
* `improvement\_4w`
* `improvement\_13w`
* `improvement\_26w`
* `improvement\_52w`
* `consecutive\_improvement\_streak`
* `ever\_top\_50k`
* `has\_unranked\_week`
* `unranked\_week\_count`
* `unranked\_after\_top\_50k`
* `last\_seen\_week`
* `weeks\_since\_seen`
* `fake\_volume\_flag\_current`
* `top\_clicked\_category\_1\_current`
* `top\_clicked\_product\_1\_asin\_current`
* `top\_clicked\_product\_1\_title\_current`
* `keyword\_in\_title\_1\_current`
* `keyword\_in\_title\_2\_current`
* `keyword\_in\_title\_3\_current`
* `keyword\_title\_match\_count\_current`
* `top\_category\_changed\_recently`
* `top\_asin\_changed\_recently`
* `updated\_at`

This table exists to make explorer queries fast.

## 7.8 Rules and settings

### `fake\_volume\_rules`

* `id`
* `version\_name`
* `is\_active`
* `rule\_json`
* `created\_by\_user\_id`
* `created\_at`

Default active rule for V1:

* Rule A: `click\_share\_1 > 5` AND `conversion\_share\_1 < 0.5`
* Rule B: `click\_share\_1 > 10` AND `conversion\_share\_1 < 1.0`
* fake if Rule A OR Rule B is true

V1 handling of blank conversion share:

* keep raw value as `NULL`
* do not coerce to zero in stored source fields
* if rule cannot be evaluated because required inputs are null, set `fake\_volume\_eval\_status = unknown...`

### `app\_settings`

* `id`
* `key`
* `value\_json`
* `updated\_by\_user\_id`
* `updated\_at`

Use this for:

* batch failure threshold
* default unranked comparison value (`1000000`)
* row-count anomaly thresholds

## 7.9 Saved views, watchlists, and alerts

### `saved\_views`

* `id`
* `user\_id`
* `name`
* `query\_config\_json`
* `is\_watchlist`
* `created\_at`
* `updated\_at`

### `alerts`

* `id`
* `user\_id`
* `saved\_view\_id`
* `week\_end\_date`
* `alert\_type`
* `title`
* `body`
* `payload\_json`
* `is\_read`
* `created\_at`

## 8\. Key indexes

At minimum:

* `keyword\_weekly\_metrics (week\_end\_date, actual\_rank)`
* `keyword\_weekly\_metrics (search\_term\_id, week\_end\_date)`
* `keyword\_weekly\_metrics (week\_end\_date, top\_clicked\_category\_1)`
* `search\_terms (search\_term\_normalized)` with substring-search-friendly indexing
* `keyword\_current\_summary (current\_week\_end\_date, current\_rank)`
* `keyword\_current\_summary (current\_week\_end\_date, keyword\_title\_match\_count\_current)`
* `keyword\_current\_summary (improvement\_1w)`
* `keyword\_current\_summary (improvement\_4w)`
* `keyword\_current\_summary (improvement\_13w)`
* `keyword\_current\_summary (improvement\_26w)`
* `keyword\_current\_summary (improvement\_52w)`
* `uploaded\_files (week\_end\_date)`
* `uploaded\_files (file\_checksum)`

## 9\. Unranked handling in V1

This section is important because the app must support missing weeks without corrupting raw data.

### Raw storage rule

* if a keyword appears in a file, store the observed row
* if it does not appear, do not create a fake raw row

### V1 summary flags

V1 should compute and expose these flags and counters:

* `ever\_top\_50k`
* `has\_unranked\_week`
* `unranked\_week\_count`
* `first\_unranked\_week`
* `last\_unranked\_week`
* `unranked\_after\_top\_50k`

### Why this design was chosen

It keeps source truth clean while still letting the UI identify terms that may be suspicious or unstable across weeks.

### Detail-page handling

On a single keyword detail page, the app can generate a 52-week time series by left-joining the loaded week calendar against observed rows for that keyword.

Missing weeks should render as:

* `status = unranked`
* `actual\_rank = null`
* `comparison\_rank\_v1 = 1000000` only where a numeric display or comparison helper is needed

## 10\. Analytics definitions

## 10.1 Improvement calculations

### Definition

For ranked endpoint comparisons:

`improvement\_places = prior\_rank - current\_rank`

* positive = improvement
* negative = decline

### V1 window definitions

Because data is weekly, the default windows are:

* 1 week
* 4 weeks
* 13 weeks
* 26 weeks
* 52 weeks

UI labels may show these as:

* Week
* Month
* 3 Months
* 6 Months
* Year

with the understanding that month-based views are fixed week windows in V1.

## 10.2 Largest improvements

Default V1 behavior:

* compare ranked endpoints only
* use the latest fully loaded week as the default endpoint
* allow filtering out terms with `unranked\_after\_top\_50k = true`

Fields shown:

* search term
* current rank
* prior rank
* improvement places
* top clicked category #1
* fake-volume flag
* unranked flag

## 10.3 Consecutive weekly improvement streak

Definition:

* count consecutive loaded weeks where the keyword is present and rank improved week over week
* any missing week resets the streak in V1

## 10.4 Custom threshold jump search

Purpose: find keywords that moved from weak ranks to much stronger ranks over a chosen window.

Default V1 logic:

* user selects a start threshold `X`
* user selects an end threshold `Y`
* user selects a window `1 / 4 / 13 / 26 / 52 weeks`
* return keywords where:

  * start-week rank is worse than `X`
  * end-week rank is better than `Y`

Example:

* from worse than `200000` to better than `10000` in `26 weeks`

V1 note:

* both endpoints should be ranked for this screen
* a later version can add explicit include-unranked logic if needed

## 10.5 Category filtering

V1 should filter by `Top Clicked Category #1`.

Future enhancement:

* allow matching any of top 3 categories

## 10.6 Search-term contains filter

V1 should support substring matching against normalized search term.

Example:

* `capsule`
* returns any keyword containing that substring anywhere in the term

## 10.7 Fake-volume filtering

V1 default behavior:

* evaluate only when required values are present
* if values are missing, mark evaluation status as unknown
* allow users to exclude fake-volume-flagged keywords with a toggle

## 10.8 Category-change and ASIN-change scaffolding

V1 should compute enough data to support later reporting, but keep the first UI simple.

Explorer page:

* `top category changed recently` yes/no
* `top ASIN changed recently` yes/no

Keyword detail page:

* weekly timeline of top category #1
* weekly timeline of top clicked product #1 ASIN/title

## 10.9 Keyword-title coverage and title-gap opportunity

Purpose: find strong keywords where the leading clicked products do not include the keyword phrase in their product titles.

### V1 matching rule

V1 should use a simple normalized phrase-containment rule:

1. lowercase search term and product title
2. trim outer whitespace
3. replace punctuation and separator characters with spaces
4. collapse repeated spaces
5. test whether the normalized product title contains the full normalized search term as a contiguous phrase

This is intentionally simple for V1.

It will correctly handle many punctuation differences, but it will not yet handle:

* synonyms
* stemming
* token reordering
* semantic equivalents

### Derived fields

For each weekly row, compute:

* `keyword\_in\_title\_1`
* `keyword\_in\_title\_2`
* `keyword\_in\_title\_3`
* `keyword\_title\_match\_count` with allowed values `0`, `1`, `2`, `3`

### Explorer filters

Users should be able to search for:

* keywords with current rank better than or equal to `X`
* keywords missing from title #1
* keywords missing from title #2
* keywords missing from title #3
* keywords missing from any selected titles
* keywords missing from all selected titles

Default selected title set should be `1,2,3`.

### Result fields

When this filter is used, results should show:

* search term
* current rank
* title match count
* in-title flag for #1
* in-title flag for #2
* in-title flag for #3
* top clicked product titles #1, #2, #3
* fake-volume flag
* top clicked category #1

This supports the opportunity view the user requested:

* low-rank keywords
* where the keyword is absent from one, two, or all three top-clicked product titles

## 11\. V1 screens

## 11.1 Login

* secure sign-in
* redirect based on role

## 11.2 Admin rubric upload page

* upload one CSV
* parse preview
* schema preview
* approve schema version

## 11.3 Admin batch upload / health page

* upload ZIP or single CSV
* validation progress
* per-file pass/warn/fail table
* duplicate-week warnings
* missing-week summary
* row-count anomaly warnings
* import valid files button when allowed
* block import when failure threshold reached

## 11.4 Admin upload history page

* list past uploads and batches
* show replacements
* show validation logs
* reprocess button if needed

## 11.5 Keyword explorer

Filters:

* window: week / month / 3 months / 6 months / year
* fake-volume exclude toggle
* top clicked category #1
* search term contains
* current rank min/max
* custom threshold-jump inputs
* unranked flag filters
* title-gap filter:

  * missing from #1
  * missing from #2
  * missing from #3
  * missing from any selected titles
  * missing from all selected titles

Results table:

* search term
* current rank
* prior rank for selected window
* improvement places
* streak
* top clicked category #1
* fake-volume flag
* unranked flag
* keyword title match count
* in-title #1 / #2 / #3 flags
* watchlist add button

## 11.6 Keyword detail page

Show:

* current keyword summary
* 52-week rank chart
* ranked vs unranked week markers
* weekly table of category and ASIN leader data
* click share / conversion share history for top product #1
* current-week keyword-in-title flags for top products #1, #2, and #3
* current-week title match count
* fake-volume history

## 11.7 Saved views / watchlists page

Allow user to:

* save current filters as a named view
* mark a saved view as a watchlist
* edit or delete saved views

## 11.8 Alerts page

* list alerts generated after each upload
* mark as read
* filter by week and alert type

## 12\. Watchlist and alert behavior

V1 should support in-app alerts.

### Alert generation points

After a successful file import and summary refresh, evaluate each watchlist.

### Suggested initial alert types

* keyword crossed below a user-set rank threshold
* keyword improved by more than a saved threshold
* fake-volume flag appeared
* fake-volume flag disappeared
* watched keyword became unranked
* watched keyword reappeared after being unranked

### V1 delivery

* in-app alerts stored in database
* optional email delivery can be added later without redesigning the model

## 13\. Query and processing strategy

## 13.1 Import strategy

For large files:

* parse to staging tables first
* validate at staging level
* bulk-insert into final tables
* refresh summaries after import

## 13.2 Summary refresh strategy

After every successful weekly import:

* refresh `search\_terms` first/last seen values
* refresh `keyword\_current\_summary`
* recompute unranked flags across loaded weeks
* recompute keyword-title match fields for current summaries
* evaluate watchlists and generate alerts

## 13.3 Performance rules

* no full CSV parsing inside browser
* no synchronous request should wait for a full import job
* explorer results must be paginated
* keyword detail queries can compute missing-week joins on demand because one term across 52 weeks is small

## 14\. API outline

Suggested endpoints or service methods:

### Auth and users

* `POST /auth/login`
* `GET /me`
* `GET /admin/users`

### Schema and uploads

* `POST /admin/schema/rubric`
* `POST /admin/schema/:id/approve`
* `POST /admin/uploads/csv`
* `POST /admin/uploads/zip`
* `GET /admin/uploads/:batchId`
* `POST /admin/uploads/:batchId/import-valid-files`
* `POST /admin/uploads/:fileId/replace`
* `GET /admin/uploads/history`

### Explorer and detail

* `GET /keywords/explorer`
* `GET /keywords/:searchTermId`
* `GET /keywords/:searchTermId/history`

### Saved views and alerts

* `GET /saved-views`
* `POST /saved-views`
* `PATCH /saved-views/:id`
* `DELETE /saved-views/:id`
* `GET /alerts`
* `PATCH /alerts/:id/read`

## 15\. Security requirements

* only admins can access upload pages
* only admins can call upload/import/replace APIs
* role checks must exist in both UI and backend
* store upload audit history for every file and batch
* retain raw files for traceability
* log schema approvals and rule changes with user id and timestamp

## 16\. Data quality rules

### Keep raw truth intact

* do not overwrite raw nulls with guessed values
* do not replace missing weeks with fake raw rows

### Derived logic belongs in summaries

* comparison helpers
* fake-volume flags
* unranked flags
* streaks
* threshold crossing logic

### Weekly completeness visibility

The UI should always show the loaded week range and note if historical backfill is incomplete.

This matters if the admin imported valid files from a partially failed batch.

## 17\. Build phases

## Phase 0 - foundation

* set up repo, auth, RBAC, Neon connection, raw file storage
* implement rubric upload parser
* implement schema approval flow

## Phase 1 - ingestion and audit

* staging tables
* CSV and ZIP validation
* batch health screen
* replacement flow
* upload history and error logging

## Phase 2 - analytics core

* final metrics tables
* summary refresh jobs
* keyword explorer
* keyword detail page
* fake-volume config
* unranked flags

## Phase 3 - user workflows

* saved views
* watchlists
* in-app alerts
* basic admin settings page

## Phase 4 - hardening

* performance tuning
* row-count anomaly warnings
* better category/ASIN change presentation
* evaluate email alerts
* refine null conversion-share handling after full data review

## 18\. Acceptance criteria for V1

The app will be considered V1-ready when all of the following are true:

* admin can upload one rubric CSV and approve schema v1
* admin can upload a ZIP of historical weekly files
* system validates each file and shows pass/warn/fail reasons
* if failed files stay below threshold, admin can import valid files only
* if failed files meet or exceed threshold, batch import is blocked
* admin can replace a previously loaded week
* explorer supports the requested stock filters
* explorer supports title-gap filtering and outputs keyword title match count
* keyword detail page shows 52-week history and unranked markers
* fake-volume rule is configurable and defaults to the agreed thresholds
* user accounts and roles work
* watchlists and in-app alerts work
* upload audit history is available

## 19\. Open questions for after first full-data review

* Are blank conversion shares limited to digital categories, or broader than that?
* Are blank click shares also concentrated in specific categories?
* Should fake-volume rules eventually vary by category?
* Should partial historical batches be imported immediately by default, or require a second explicit confirmation every time?
* Should threshold-crossing searches require a minimum movement floor in addition to crossing the threshold?
* Should keyword-title matching stay as exact normalized phrase containment, or later support token-order-insensitive matching?
* How should top category and top ASIN changes be summarized on list pages?
* Do users need email alerts in V1.1?

## 20\. Immediate next step

After plan approval, the next implementation artifact should be a technical execution checklist that breaks this build spec into:

* database migrations
* ingestion tasks
* backend endpoints
* frontend screens
* summary jobs
* test cases

