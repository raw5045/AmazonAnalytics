# Keepa service — design (arc 6)

**Date:** 2026-10-05
**Status:** approved in brainstorm, awaiting the owner's review of this document
**Owner decisions recorded here:** Keepa only (the weekly SFR CSV import stays as it is); top-1M keywords' ASINs refreshed weekly; the tail lane off by default; field set in §4; old and new paths run side by side for a shadow week before the old path retires; the new Railway service is configured in the dashboard (Config as Code is deprecated).

## 1. Goal

Run Keepa product enrichment continuously, on its own Railway service, so that:

- app pushes, deploys and imports never pause or kill enrichment (today a full refresh is a 17-hour promise inside the main worker, and every push restarts that worker);
- the plan's tokens are used instead of expiring (tokens live 60 minutes; the bucket holds 15,000; it sits full between runs today);
- the top 1M keywords' top-3 ASINs (about 1.0M ASINs) carry product data no older than about a week, instead of today's ~141k ASINs behind the top 100k keywords refreshed by hand;
- progress is durable per batch: a restart loses at most one batch of 100 ASINs.

## 2. Facts the design rests on

| Fact | Value | Source |
|---|---|---|
| Plan refill rate | 250 tokens/min, bucket 15,000, tokens expire after 60 min | Keepa `/token` on 2026-10-05; Keepa plans doc |
| Cost per ASIN | 2 tokens (1 base + 1 for rating/review history) | Keepa product-request doc; measured |
| Max ASINs per request | 100 | Keepa product-request doc |
| Capacity | 360,000 tokens/day = 180,000 ASINs/day; 1.26M ASINs/week | arithmetic |
| Measured pace today | 112,711 ASINs in 16.7 h (113/min, ~90% of cap) with one ASIN per request; diff runs ~20k ASINs in ~3.4 h | `keepa_enrichment_runs` |
| Keywords in the current week (2026-09-26) | 2,715,370 | kcs |
| Distinct top-3 ASINs, rank ≤ 100k | 140,935 (all fetched, all fresh after the 2026-10-03 full run) | diag 2026-10-05 |
| Distinct top-3 ASINs, rank ≤ 1M | 1,003,344 (715,083 never fetched) | diag 2026-10-05 |
| Distinct top-3 ASINs, all ranks | 2,310,656 (1,954,116 never fetched) | diag 2026-10-05 |
| Existing per-week table | `asin_weekly_data`, 2.88M rows, 5.1 GB | pg_class |
| Free per base token | `stats` object (time-weighted averages, current values), `monthlySold`, `listedSince`, `trackingSince`, offer counts (new total, FBA, FBM), `availabilityAmazon`, category tree, images | Keepa product-object and statistics-object docs |
| Paid add-ons (not used) | `offers` (6/page), `buybox` (+2), `stock` (+2) | Keepa product-request doc |

Tier 1 at full speed takes 5.6 days; at the measured 90% pace about 6.2 days. The week has 7.

## 3. Architecture

### 3.1 Components

**Keepa service** (new; `services/keepa/`; its own Railway service). An always-on Node process that talks to Keepa and to Neon, nothing else. It reads `DATABASE_URL`, `KEEPA_API_KEY`, optional `KEEPA_TAIL_LANE`, and Railway's `PORT`. It does not import `lib/env.ts`, `db/client.ts`, Inngest or Resend: it owns a small `pg.Pool` (max 3, TCP keepalive, 5-minute statement timeout) and runs raw SQL. Its imports are confined to `services/keepa/**` and `lib/keepa/**` so Railway's watch paths can be exact.

**Catalog** (`asin_products`, new): one row per ASIN holding the current product facts and the queue state. **Snapshots** (`asin_snapshots`, new): one narrow row per fetch. **Status** (`keepa_service_status`, new): one row with the service heartbeat and the watcher's bookkeeping. All three are additive; migration 0050.

**Main worker** (existing) keeps imports, the weekly refresh, the explorer aggregate sync and emails, and gains two small pieces: the import's enqueue-week hook (§6.1) and a 15-minute watcher (§6.2).

**App readers** (existing) switch from `asin_weekly_data` to `asin_products` behind one env flag (§7).

### 3.2 Weekly data flow

1. The weekly import completes. Its final step upserts the week's top-3 ASINs into the catalog: new ASINs as never-fetched, every ASIN's best rank and tier refreshed (tier 1 = best rank ≤ 1,000,000, weekly; tier 2 = the rest, 30-day cadence, only when the tail lane is on), ASINs no longer in any top-3 marked out of scope but kept.
2. The service, already running, drains the never-fetched tier-1 lane in rank order (so the top keywords' new products come first), then the tier-1 rows due for their weekly refresh (oldest first), then tier 2 if enabled.
3. When the never-fetched lane drains after an import, the watcher fires the explorer aggregate sync, so the explorer's price and review columns catch up the same day, as today. The sync also runs nightly when anything was fetched.
4. Keyword detail pages read the catalog directly, so a product shows new data minutes after its fetch.

### 3.3 Isolation

- Railway redeploys the service only when `/services/keepa/**`, `/lib/keepa/**`, `/package.json` or `/pnpm-lock.yaml` change. App pushes leave it alone. The main worker still restarts on every push, as now, but nothing Keepa-related runs there after phase 3.
- A service restart loses at most the in-flight batch: claims older than ten minutes are released on boot and the rows are simply fetched again.
- One instance is assumed. Row locks with `SKIP LOCKED` make a second instance safe anyway.

## 4. Data model (migration 0050, additive)

### 4.1 `asin_products` — one row per ASIN

Identity and listing facts: `asin text PK`, `title text`, `brand text`, `image_url text`, `category_path text`, `category_root text`, `category_leaf text`, `listed_since date`, `tracking_since date`.

Live numbers: `current_price_cents int`, `price_source text` (`'amazon'` or `'new'`, null when no price), `sales_rank int`, `review_count int`, `average_rating_x10 int`, `last_rating_update date`, `monthly_sold int` (Amazon's "bought in past month" floor, e.g. 100000 = 100K+; null when the badge is absent), `keepa_updated_at date` (Keepa's `lastUpdate`: the "as of" date for monthly sold and the offer counts), `new_offer_count int`, `fba_offer_count int` (includes Amazon's own offer), `fbm_offer_count int`, `amazon_availability smallint` (Keepa code: −1 no Amazon offer, 0 in stock, 1 pre-order, 2 unknown, 3 back-order, 4 delayed).

Weighted averages (Keepa `stats`, time-weighted, same series as `price_source`): `avg30_price_cents`, `avg90_price_cents`, `avg180_price_cents`, `avg365_price_cents`, `avg30_sales_rank`, `avg90_sales_rank` (all `int`).

Enrichment state: `enrichment_status asin_enrichment_status` (existing enum: active, no_price, delisted, error; **null = never fetched**), `error_code text` (short code, never a message), `last_fetched_at timestamptz`, `fetch_count int not null default 0`, `consecutive_errors int not null default 0`.

Queue state: `in_scope boolean not null default true`, `best_rank int`, `scope_week date`, `tier smallint not null` (1 or 2), `next_due_at timestamptz not null default now()`, `claimed_at timestamptz`, `claimed_by text` (service boot id).

Bookkeeping: `created_at timestamptz not null default now()`, `updated_at timestamptz not null default now()`.

Indexes:
- `asin_products_never_fetched_idx` on `(tier, best_rank)` where `in_scope and claimed_at is null and last_fetched_at is null`;
- `asin_products_due_idx` on `(tier, next_due_at)` where `in_scope and claimed_at is null and last_fetched_at is not null`;
- `asin_products_claimed_idx` on `(claimed_at)` where `claimed_at is not null` (boot-time release);
- `asin_products_category_path_idx` on `(category_path text_pattern_ops)` where `in_scope and category_path is not null` (category builder's prefix matches on live rows);
- `asin_products_scope_week_idx` on `(scope_week)` (the `max(scope_week)` reads of the watcher, the admin card and the enqueue guard).

The two lane indexes carry the claim tie-breaker as a trailing key: `(tier, best_rank, asin)` and `(tier, next_due_at, asin)`. `error_code` and `last_error_code` carry `CHECK (char_length(…) <= 64)`; the table sets `autovacuum_vacuum_scale_factor = 0.05`.

Dropped versus `asin_weekly_data`: the `variations` and `promotions` JSON (nothing reads them), free-text `error_message`, the week key.

### 4.2 `asin_snapshots` — one row per fetch

`asin text`, `fetched_at timestamptz`, `current_price_cents int`, `sales_rank int`, `review_count int`, `average_rating_x10 int`, `monthly_sold int`, `new_offer_count int`, `fba_offer_count int`, `fbm_offer_count int`, `enrichment_status asin_enrichment_status not null`. Primary key `(asin, fetched_at)`. One row for every fetched ASIN; numbers are null when the status carries none (delisted, error).

Growth: about 100 bytes a row; weekly fetches of tier 1 add roughly 1M rows (≈100 MB) a week, about 5 GB a year with the index. Keep everything for now; retention is a decision for the one-year mark (§12).

### 4.3 `keepa_service_status` — one row

`singleton boolean primary key default true check (singleton)`, `boot_id text`, `booted_at timestamptz`, `heartbeat_at timestamptz`, `last_batch_at timestamptz`, `last_batch_lane text`, `tokens_left int`, `refill_rate int`, `tail_enabled boolean not null default false` (written by the service at boot from its env), `last_error_code text`, `last_error_at timestamptz`, `lane_new_drained_at timestamptz` (service), `sync_fired_at timestamptz`, `nightly_sync_date date`, `down_alarm_sent_at timestamptz`, `stall_alarm_sent_at timestamptz` (watcher).

### 4.4 Seed (same owner-gated apply script, after the DDL)

1. **Facts** for every ASIN that has a row in `asin_weekly_data`: the row with the latest `enriched_at` (ties broken by latest week) supplies title, brand, image, categories, price, rank, reviews, rating, last rating update, the four price averages, `enrichment_status`; `last_fetched_at = enriched_at`; `fetch_count = 1`; `next_due_at = enriched_at + 7 days` (so the ASINs refreshed on 2026-10-03/04 come due around 2026-10-10/11); `price_source = 'amazon'` when the price is non-null (the legacy rows do not record the series; the first refresh corrects it). Rows seeded this way start with `in_scope = false`, `tier = 2`; step 2 fixes both for ASINs still in scope.
2. **Scope** for the current kcs week: the enqueue-week upsert of §6.1 run once by the script. Every ASIN behind the week's keywords gets `best_rank`, `scope_week`, `tier`, `in_scope = true`; never-fetched ASINs keep `next_due_at = now()`.
3. **Snapshots** back-filled from `asin_weekly_data`'s genuine fetches: one row per distinct `(asin, enriched_at)` with status active or no_price (the weekly port-forward copied `enriched_at`, so distinct fetch times are distinct fetches). Monthly sold and offer counts null.
4. **Status row** inserted with nulls.

The migration number is 0050 (hand-numbered; the drizzle journal stays frozen). The apply script is untracked and gated by `APPLY_0050=yes`; it runs only on the owner's explicit go.

## 5. The service

### 5.1 Loop

1. **Boot.** Start the HTTP health server on `PORT` (`GET /` returns ok, boot id, uptime, last batch time). Release claims older than ten minutes (any boot id). Write the status row (boot id, booted at, heartbeat, `tail_enabled`). Read the free `/token` endpoint once for the initial `tokens_left` and `refill_rate`.
2. **Claim.** Up to 100 rows, taken lane by lane with small index-ordered queries until the batch is full:
   - lane `new`: tier 1, never fetched, `next_due_at <= now()` (an errored first fetch waits out its backoff), ordered by `best_rank` (lowest rank first);
   - lane `due`: tier 1, fetched before, `next_due_at <= now()`, ordered by `next_due_at`;
   - lane `tail` (only when `KEEPA_TAIL_LANE=1`): tier 2 with the same two sub-lanes, never fetched by rank first, then due by `next_due_at`.
   Each query is `SELECT … FOR UPDATE SKIP LOCKED LIMIT n` followed by `UPDATE … SET claimed_at = now(), claimed_by = boot_id` in one transaction.
3. **Pace.** A batch costs 2 × batch size tokens. If `tokens_left` (from the last Keepa reply) is short, sleep until the refill covers it: at 250 tokens/min a full batch waits at most about 48 seconds. The bucket stays near empty, so nothing expires.
4. **Fetch.** One `GET https://api.keepa.com/product` with `domain=1`, `asin=<comma-separated batch>`, `rating=1`, `stats=90`, `history=0`, 60-second timeout. `history=0` drops the csv, salesRanks, monthlySoldHistory and couponHistory arrays; every stored field comes from the product object and the `stats` object (`current`, `avg30`, `avg90`, `avg180`, `avg365`, Price Type indexing: 0 Amazon, 1 new, 3 sales rank, 11 new offer count, 16 rating, 17 review count, 34 FBA offer count, 35 FBM offer count).
5. **Parse and validate** (pure function, per product; a bad product object fails only its own ASIN):
   - products are matched to the batch by their `asin` field; a requested ASIN with no product in the reply is **delisted**;
   - current price: `stats.current[0]` if > 0 (`price_source = 'amazon'`), else `stats.current[1]` if > 0 (`'new'`), else null and status **no_price** (facts still stored); averages come from the same series;
   - sales rank `stats.current[3]`, review count `[17]`, rating `[16]`, offer counts `[11]`, `[34]`, `[35]`; Keepa's −1 (and any value below the field's floor: counts < 0, rank ≤ 0, rating outside 0–50, price ≤ 0, monthly sold ≤ 0) becomes null;
   - `monthly_sold` from `monthlySold`; `keepa_updated_at` from `lastUpdate`; `listed_since` from `listedSince` when > 0; `tracking_since` from `trackingSince`; `last_rating_update` from `lastRatingUpdate`; `amazon_availability` from `availabilityAmazon`; category path/root/leaf from `categoryTree`; image from `images[0].m` as today;
   - status is **active** when a price exists.
   If the first fixture capture (§10) shows `stats.current` lacks indices 34 and 35, the request switches to `days=7` instead of `history=0` and the offer counts are read as the last csv values; nothing else changes.
6. **Write.** One transaction: upsert the catalog rows, insert one snapshot per fetched ASIN, clear the batch's claims, set `next_due_at` (§5.2), update the status row (heartbeat, `last_batch_at`, `last_batch_lane`, `tokens_left`, `refill_rate`). Then the next claim immediately; the pacer decides the wait.
7. **Idle.** No claimable rows: write the heartbeat and sleep 60 seconds. Separately, whenever a claim finds the `new` lane empty right after a batch that drew from it, the service stamps `lane_new_drained_at`; that is the signal the watcher uses to fire the explorer sync after an import.

### 5.2 Outcome rules

| Outcome | Facts | Status | `last_fetched_at` | `next_due_at` | Errors |
|---|---|---|---|---|---|
| active / no_price | replaced | set | now | tier 1: +7 days; tier 2: +30 days | `consecutive_errors = 0`, `error_code = null` |
| delisted | **kept** (title stays for display) | delisted | now | +30 days | reset as above |
| error (Keepa failure, bad object) | kept | unchanged if it was ever fetched, else `error` | unchanged | +1 day × 2^(consecutive_errors − 1), capped at 7 days | `consecutive_errors + 1`, `error_code` set |

`fetch_count` increments on active, no_price and delisted. Readers take prices only from `active` rows; the explorer staging and sync also carry `no_price` and `delisted` rows for their reviews and category (§13), and the detail page hides a delisted product's point-in-time facts.

### 5.3 Failure handling

- **Tokens exhausted** (Keepa error with `refillIn`): sleep that long, retry the same batch with its claims intact.
- **Keepa 5xx, network error, timeout:** retry three times, 30 seconds apart, then record the batch as errors (§5.2) and continue. The loop never exits over Keepa.
- **Keepa 400/401 (bad key or request):** `last_error_code` set, retry every ten minutes; the watcher alarms (§6.2).
- **Database failure:** the transaction rolls back, claims expire in ten minutes, the loop sleeps 30 seconds and continues; after ten consecutive database failures the process exits with code 1 so Railway restarts it with a fresh pool.
- **Logging:** one line per batch (`lane`, requested, active/no_price/delisted/error counts, tokens left, ms) and coded errors only (HTTP status, an error class name, a Postgres error code). Never the key, never a database error message, never an email address.

### 5.4 Code layout

- `services/keepa/index.ts` — boot, health server (503 until booted), independent 60-second heartbeat, SIGTERM claim release, forever loop; `services/keepa/loop.ts` — one iteration with injected store, Keepa client, clock and sleep (testable); `services/keepa/store.ts` — the store interface; `services/keepa/pgStore.ts` — claims, batch transaction, status writes (Postgres); `services/keepa/db.ts`, `log.ts`; `services/keepa/README.md` — the Railway dashboard settings (§9), the env list and an operations section.
- `lib/keepa/batchClient.ts` — the multi-ASIN request and the token pacer; `lib/keepa/parseProduct.ts` — the parser of §5.1 step 5, producing a `ProductFacts` type; `lib/keepa/lanes.ts` — pure next-due and backoff rules; `lib/keepa/__fixtures__/batch-stats.json` — a fixture captured with the exact request shape.
- The existing `lib/keepa/client.ts`, `parse.ts`, `worker/keepaJobs.ts` and `inngest/functions/enrichKeepaForWeek.ts` stay untouched until phase 3.

## 6. Main worker additions

### 6.1 Enqueue-week hook

Called at the end of the import's completion step (before the long refresh starts, so the service gets a head start), and by the seed. One statement over the week's kwm partition:

- for every top-3 ASIN of the week (same category exclusions as today, `EXCLUDED_CATEGORIES` on `top_clicked_category_1`), compute `best_rank = MIN(actual_rank)`;
- upsert into `asin_products`: new ASINs get `best_rank`, `scope_week`, `tier`, `in_scope = true`, `next_due_at = now()`; existing ASINs get `best_rank`, `scope_week`, `tier`, `in_scope = true`, and when they move from tier 2 to tier 1 with a prior fetch, `next_due_at = least(next_due_at, last_fetched_at + 7 days)`;
- then `UPDATE asin_products SET in_scope = false WHERE in_scope AND scope_week <> <week>`.

Runs in a few minutes (about 2.3M rows). Failure is logged and does not fail the import; the service keeps working on the previous scope and the hook can be re-run from a script (`FIRE_ENQUEUE_WEEK=YYYY-MM-DD`).

### 6.2 Watcher (Inngest cron on the main worker, every 15 minutes)

Reads the status row and the due counts, then:

- **Down:** `heartbeat_at` older than fifteen minutes → one "Keepa service down" email (records `down_alarm_sent_at`); a recovery email when the heartbeat is fresh again, then the stamp clears.
- **Stalled:** heartbeat fresh, `last_batch_at` older than two hours, and claimable tier-1 work exists (or tier-2 work with the tail on) → one "Keepa service stalled" email; recovery email as above.
- **Sync after an import:** `lane_new_drained_at` newer than `sync_fired_at` → send `keepa/aggregates-sync-requested` for the current kcs week and stamp `sync_fired_at`.
- **Nightly sync:** in the 03:30–03:44 America/New_York window, when `last_batch_at` is within 24 hours and `nightly_sync_date` is not today → send the same event and stamp the date.

Emails go to the same admin recipients as the enrichment emails, through the existing Resend sender, with subject lines "Keepa service down", "Keepa service stalled", "Keepa service recovered".

## 7. App readers (phase 2, behind a flag)

`KEEPA_READ_SOURCE` = `weekly` (default) or `products`, read at request time through `lib/keepa/readSource.ts`. Set on Vercel and the Railway worker; flipping it is an env change PLUS a redeploy (Vercel applies env to new deployments only; Railway redeploys the worker on a variable change — run `scripts/checkActiveJobs.ts` first). Readers with two SQL variants:

- **Keyword detail** (`lib/explorer/fetchKeywordDetail.ts`, both product queries): same joins to find the three ASINs, `FROM asin_products a WHERE a.asin = ANY(...)`, no week predicate. Column names match, so `mapEnrichedProducts` is unchanged; the new fields are selected and carried on the row type for a later UI arc.
- **Weekly refresh staging** (`inngest/functions/refreshSummary.ts`, `stageEnrichedAsins`) and **aggregate sync phase 1** (`worker/kcsKeepaSyncJobs.ts`): `SELECT asin, current_price_cents, review_count, average_rating_x10, category_leaf, category_path FROM asin_products WHERE enrichment_status = 'active'` (no DISTINCT ON over 2.9M rows).
- **Category builder** (`lib/categoryBuilder/loadTree.ts`) and **research categories** (`lib/research/categories.ts`): `category_path` from `asin_products`.

## 8. Admin page

`/admin/keepa-enrichment` gains a status card above the existing content: heartbeat age and boot time, tail lane on/off, never-fetched tier-1 count, due tier-1 count, fetched in the last 24 hours, oldest tier-1 `last_fetched_at` age (target ≤ 8 days), tokens left and refill rate, unused capacity over the trailing 7 days (7 × 180,000 minus fetched, as a count and a percentage), last error code and time, last sync fired. The full-refresh button and the runs table stay through phases 1 and 2 and go in phase 3.

## 9. Railway setup (owner, dashboard; Config as Code is deprecated and new services cannot use it)

Service created 2026-10-05 from the same GitHub repo on `main`. Settings tab:

| Setting | Value |
|---|---|
| Custom Build Command | `echo "no build - tsx runs the source"` |
| Custom Start Command | `pnpm tsx services/keepa/index.ts` |
| Healthcheck Path | `/` |
| Restart Policy | On Failure, max retries 10 |
| Watch Paths | `/services/keepa/**`, `/lib/keepa/**`, `/package.json`, `/pnpm-lock.yaml` |

Variables: `DATABASE_URL` (reference the worker's value), `KEEPA_API_KEY`; later `KEEPA_TAIL_LANE=1` to enable tier 2. The owner sets all values; none pass through chat or the repo.

Until the service code ships, deploys fail at start; the restart policy stops after ten attempts and the next push with the code brings it up. The worker's own `railway.json` stops being read on 2026-12-01 (§12).

## 10. Testing

- **Unit:** `parseProduct` on the new fixture (captured once with the exact request for three known ASINs; a few tokens) including delisted, no-price and malformed objects; lane and next-due rules; validation floors; the never-downgrade rule; the pacer's sleep arithmetic; the enqueue tier-change rule; the watcher's alarm and sync decisions with a fake clock.
- **Service loop:** `runIteration` with a fake Keepa client and fake clock: retries, token sleeps, claim release, error batches, the exit-after-ten-database-failures rule.
- **Integration** (owner's go, real database, synthetic ASINs prefixed `TEST`, cleaned up): claim-and-write transaction, enqueue-week upsert on a seeded sample, every reader under both flag values, the seed on a sample.
- **Smoke after each ship step:** batches landing within the first hour, card numbers moving, a detail page for a freshly fetched ASIN; after the flag flip, a detail page and an explorer price sort; after phase 3, the next weekly import's new ASINs fetched by the service.
- Project suites (`pnpm typecheck`, `pnpm exec eslint <files>`, `pnpm test`) before every push, as always.

## 11. Transfer plan and ship order

Every push is owner-gated (`scripts/checkActiveJobs.ts` first, bare `git push origin main`).

1. **Migration 0050 plus seed** through the gated apply script. Additive; safe before any code ships.
2. **Service, admin card, watcher** pushed; the owner's Railway service picks it up. The old import-time job keeps running untouched; the app keeps reading the old table. Phase 1, the shadow week: the service also fetches the week's new ASINs (about 40k tokens a week of double spend). The two share one Keepa token bucket and the old job treats a 429 as a week-long error, so the service idles (`yield_old_job`) while a `keepa_enrichment_runs` row is `running` with a heartbeat under 10 minutes old (a few hours after each import) and the watcher holds its stall alarm meanwhile; never press the manual full refresh while the service runs. The admin card shows pace, queue depth and errors; values are spot-checked against the old rows.
3. **Reader flag** (phase 2): after the spot checks, the owner sets `KEEPA_READ_SOURCE=products` on Vercel and the worker. Reversible in a minute.
4. **Retire** (phase 3): the import's hook replaces the old enrichment event; the old orchestrator, worker job, full-refresh route and button, and the enrichment emails are removed; the aggregate sync stays, fired by the watcher; `asin_weekly_data` receives no more writes and stays as history (never dropped in this arc).

## 12. Follow-ups (not this arc)

- Show monthly sold, offer counts, listed-since and the rank averages on the detail page and in the Ask AI / MCP product details.
- Turn on the tail lane once a tier-1 week has run smoothly; review unused capacity on the card first.
- Snapshot retention policy at the one-year mark; snapshot-driven "review growth" views.
- Railway: move the worker's `railway.json` settings to the dashboard, or migrate the project with `railway config migrate`, before 2026-12-01.
- A Keepa tier upgrade if faster cycles are ever wanted (500 tokens/min halves tier 1 to about 2.8 days).
- Drop `asin_weekly_data` once nothing has read it for a full quarter.

## 13. Amendments as landed (2026-10-05, from the implementation reviews)

Where a section above and this list disagree, this list is what shipped.

- **§4.1 / §4.4.** Never fetched = `last_fetched_at IS NULL` (`enrichment_status` is NULL until the first outcome and `error` after a failed first fetch). Legacy `error` rows are not seeded as facts (those ASINs start never-fetched); seeded delisted rows get the 30-day recheck. The seed runs each step in its own transaction with `work_mem` raised, asserts indexes, constraints and column counts after the DDL, gates on the post-seed counts, and is idempotent (re-run on failure). Once the service is live, never re-run the apply script (its `CREATE INDEX IF NOT EXISTS` statements take a share lock); re-scope with `scripts/fireEnqueueWeek.ts`.
- **§4.2.** No snapshot row for an `error` outcome (an outage is not a fetch): snapshots exist for `active`, `no_price` and `delisted` only.
- **§5.1 step 4.** `history=0` still returns a small `salesRanks` object; nothing reads it. Replies pass a JSON-object guard: a 200 without a non-empty `products` array, or with a non-object body, is a bad reply (`keepa_bad_reply`) retried like an outage, never a delisting. `refillIn` is clamped to 1–120 s.
- **§5.1 step 5.** Delisted = Keepa `productType` 3 (inaccessible) or 4 (invalid). An ASIN absent from a non-empty reply is an `error` (`missing_from_reply`, backoff), not a delisting. A product without a non-empty `stats.current` (and no csv) is an `error` (`no_stats`), so a format change can never null the catalog. In the offer-count series Keepa's −1 means no offers and is stored as 0. NUL characters are stripped, integers above 2³¹−1 become null, a category tree with an unnamed node yields no path, Keepa minutes outside 2011–2100 become null, and a product object that throws is an `error` (`parse_failed`) for that ASIN only. The parser never throws.
- **§5.1 steps 2 and 6, §6.1 — the enqueue/batch handshake.** Neon's pooler is PgBouncer in transaction mode, so all advisory locks are transaction-scoped: `enqueueWeek` runs `BEGIN`, `SET LOCAL statement_timeout`, `pg_advisory_xact_lock(ENQUEUE_LOCK_KEY)`, the scope guard, the upsert, the retire, `COMMIT`, then a best-effort `VACUUM (ANALYZE)`; every service store transaction (release, claim, write, mark-errored, SIGTERM release) first takes `pg_advisory_xact_lock_shared` with a 1900-second wait and then returns to the 300-second statement timeout. The enqueue refuses a week older than the catalog's scope week unless forced, stops before the retire when the upsert touched zero rows, drops malformed ASINs, reports inserted/updated/retired/vacuumed (+ the vacuum error code), and must be given one dedicated connection. The import hook runs it before the summary refresh, fail-soft, with socket-error guards; an older-week result is logged as an expected skip.
- **§5.2.** The success due date is chosen in SQL by the row's current tier (a mid-batch re-tier cannot undo a pull-forward). A batch whose outcomes are all errors writes its rows but surfaces as a failed batch on the status row (`last_error_code` set, `last_batch_at` untouched).
- **§5.3.** Stored error codes: `keepa_http_<status>`, `keepa_bad_reply`, `keepa_timeout`, `keepa_network_<cause>`, capped at 64 characters. HTTP 400 marks the batch after three attempts; 401–499 retry forever. After an unanswered batch, a large all-error batch (≥ 10 rows) or a second consecutive 400 batch the loop pauses 1 → 15 minutes (doubling, reset on a batch with any success). Token waits are capped at 2 minutes; five consecutive 429s record `keepa_tokens_exhausted`. An escaped exception in an iteration is logged (`iteration_threw`) and counted like a database failure. The service has an independent 60-second heartbeat, answers 503 until booted, releases its own claims on SIGTERM, and discards a client whose transaction failed.
- **§6.2.** Down = heartbeat older than 15 minutes. The stall clock runs from the last batch, or from boot until the first one; the stall alarm is held (reason `old_job_running`, never a false "recovered") while the old import-time job has a live run, since the service yields to it (§11). No actions before the service's first boot (`boot_id IS NULL`); no alarms while the enqueue holds its lock (`pg_locks` probe); the due-work probe is two EXISTS carrying the lane indexes' predicates. The drained-lane sync fires only when the last sync is at least 6 hours old and the explorer has reached the catalog's scope week; the nightly sync also waits for the explorer week. The scope/explorer weeks are read only when a sync decision needs them. The tick is a tested function (`runWatcherTick`).
- **§7.** `mapEnrichedProducts` maps nine optional catalog fields (null under the weekly source). The catalog detail variant skips never-fetched rows; the category-builder catalog variants filter `in_scope`. Flipping `KEEPA_READ_SOURCE` on Vercel requires a redeploy (env changes reach new deployments only); Railway redeploys on a variable change.
- **§8.** The card's headline is "tier-1 ASINs fetched more than 8 days ago" (delisted excluded) with a separate "tier 1 in error backoff" count, replacing the outlier-driven oldest-fetch age; it also shows the catalog scope week vs the explorer week ("behind the explorer" only when older), when the new lane last drained, tokens left with the refill rate, and capacity from the live refill rate. A loader failure renders one "Service status unavailable (code)" line and leaves the rest of the page intact. The loader lives in `lib/admin/`, outside the service's watch path.
- **§11.** Shared Keepa token bucket during the shadow week: the service idles (`yield_old_job`, heartbeat only) while a `keepa_enrichment_runs` row is `running` with a heartbeat under 10 minutes old, and resumes (`resume_after_old_job`) when it ends; the probe and the held reason are deleted with the old job in phase 3. Never press the manual full refresh while the service runs.
- **§10 / §11.** The integration test command is `RUN_INTEGRATION=1 pnpm vitest run tests/integration/keepaService.test.ts` (the `pnpm test:integration <file>` form runs the whole suite); it needs the service stopped and no enqueue running, briefly claims and releases real rows, and restores the status row. Before the flag flip, each catalog reader query is exercised once read-only on the owner's go. Pre-push, `scripts/checkActiveJobs.ts` also flags imports still mid-phase.
