# Keepa ASIN enrichment — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enrich top-3 converting ASINs per keyword (top 100K rank, excluding 24 non-applicable categories) with Keepa data each week — review count, average rating, current price, sales rank at fetch, leaf category path, 30/90/180/365-day average prices, buy-box seller, variations, and promotions. Surface the data in the keyword detail page (product cards) and explorer (review/rating columns + cascading-category filter).

**Architecture:** Per-(asin, week) row in a new `asin_weekly_data` table — aligns naturally with kwm's weekly cadence, gives us free historical trajectory without a separate history table, and joins directly to kwm on `(asin, week_end_date)`. Keepa client module with token-bucket pacing reads `tokensLeft` from each response and sleeps when the bucket is low. Initial fill via a one-shot script; ongoing maintenance via an Inngest function that fires after the weekly kcs refresh completes.

**Tech Stack:** Postgres 17 (Neon), node-postgres (pg) TCP driver for backfill, drizzle-kit for migration scaffolding, Inngest for the weekly job, Keepa API at 250 tokens/min tier (`rating=1` parameter, 2 tokens per ASIN).

---

## Context — what we're adding

The keyword detail page and explorer table currently lean on Amazon SFR's `top_clicked_product_*` columns: ASIN, title, brand, click share, conversion share, and a single top-level category like "Health & Personal Care". That's a coarse view — we can't filter by "Bath > Faucets > Pull-Down", we don't know how many reviews a product has, and we can't tell if a top product is $5 or $500.

Keepa fills the gap. For each top-3 ASIN at top 100K rank in the current week, we pull:

- **Core metrics:** current price, review count, average rating (0.0–5.0)
- **Specific category path:** full breadcrumb (e.g. "Tools & Home Improvement › Kitchen & Bath Fixtures › Bath › Faucets")
- **At-time-of-fetch context:** sales rank, buy-box seller ID, lastRatingUpdate timestamp
- **Historical context already aggregated by Keepa:** 30/90/180/365-day average prices
- **Related ASINs:** the variations array (color/size siblings) — handy if we later want to roll up at the family level
- **Promotions:** any active deal info Keepa surfaces

We approved a single Keepa parameter: `rating=1`. Cost: 2 tokens per ASIN. Spot-check on 15 diverse ASINs (commit pending: `docs/keepa-spot-check-2026-05-15.md`) confirmed Keepa values match Amazon live pages and Keepa's freshness is good (13/15 updated same day).

Scope locked from earlier brainstorming:

- **Rank cutoff:** `actual_rank <= 100000` (`countEnrichableAsins.ts` showed ~140K distinct top-3 ASINs per week at this cutoff).
- **Excluded categories (24):** all `Digital_*`, `Software`, `Video`, `Fresh_*`, `Protein`, `Gift Card`, `Consumables_*_Gift_Cards`. See `scripts/countEnrichableAsins.ts` for the canonical list.
- **Slots:** top 1, 2, 3 (deduped across slots — same ASIN can appear in slot 1 for keyword A and slot 2 for keyword B; we enrich it once per week).
- **Tier:** 250 tokens/min ≈ $400/mo. 280K tokens/week ≈ 19 h of active calls, comfortably within daily capacity.
- **Refresh cadence:** every 7 days, aligned to the existing kcs refresh trigger.

---

## File Structure

**Created:**

- `db/migrations/0022_asin_weekly_data.sql` — the new table + indexes
- `lib/keepa/types.ts` — shared TypeScript types (`KeepaProduct`, `EnrichmentResult`, etc.)
- `lib/keepa/parse.ts` — extracts our domain model from Keepa's csv-indexed response
- `lib/keepa/parse.test.ts` — vitest unit tests with captured Keepa responses as fixtures
- `lib/keepa/client.ts` — fetch wrapper with token-bucket pacing
- `lib/keepa/categoryExclusions.ts` — the 24-category exclusion list (single source of truth, imported by both the Inngest job and `countEnrichableAsins.ts`)
- `scripts/keepaSmokeTest.ts` — dev smoke test against a 50-ASIN slice (Task 3). Validates the full pipeline before we trust the Inngest function.
- `scripts/verifyKeepaCoverage.ts` — sanity check post-backfill: how many top-3 ASINs in the current week have asin_weekly_data rows
- `inngest/functions/enrichKeepaForWeek.ts` — the recurring weekly job, configured `concurrency: 1` so a duplicate trigger event can't spawn a parallel run that fights for tokens. Also the path used for the initial backfill (Task 5 — we just fire the event manually for the current week). Sends a completion email at the end via `sendEnrichmentEmail`.
- `lib/notifications/buildEnrichmentEmail.ts` — pure function rendering the "enrichment completed" admin email (subject + text + html). Mirrors `buildImportEmail.ts`.
- `lib/notifications/sendEnrichmentEmail.ts` — Resend wrapper. Fail-soft: missing RESEND_API_KEY or send error logs a warning, never breaks the Inngest run.
- `lib/notifications/buildEnrichmentEmail.test.ts` — vitest snapshot tests of the rendered email.
- `lib/explorer/listLeafCategories.ts` — list of leaf-category options for the cascading filter
- `app/explorer/keyword/[id]/ProductCard.tsx` — enhanced product card with Keepa data on the detail page
- `docs/keepa-spot-check-2026-05-15.md` — already exists from the spot-check run; commit it here as the baseline reference

**Modified:**

- `scripts/countEnrichableAsins.ts` — import excluded categories from `lib/keepa/categoryExclusions.ts` instead of inline list
- `inngest/functions/refreshSummary.ts` — at the end of the swap, send a `keepa.enrich-week-requested` event with the new `current_week_end_date`
- `inngest/functions/index.ts` — register `enrichKeepaForWeek`
- `app/explorer/keyword/[id]/page.tsx` — fetch and pass Keepa data for the top 3 ASINs
- `app/explorer/page.tsx` — add optional review-count + rating columns; wire the cascading-category filter
- `lib/explorer/runQuery.ts` — accept a `leafCategory` filter and join to asin_weekly_data when set
- `db/schema.ts` — add the new table definition for drizzle

---

## Locked-in decisions reference

- **Excluded categories** (mirror what's in `countEnrichableAsins.ts` today, lifted into `lib/keepa/categoryExclusions.ts`):

  ```
  Digital: Digital_Video_Download, Digital_Ebook_Purchase, Digital_Music_Purchase,
           Mobile_Apps, Audible, Digital_Video_Games, Digital_Products_3,
           Digital_Text, Digital_Software, Digital_Devices_4, Digital_Text_2,
           Digital_Periodicals, Digital_Health_Services, Digital_Products_9,
           Digital_Products_10, Video, Software
  Grocery: Fresh_Perishable, Fresh_Produce, Fresh_Prepared, Protein
  Gift cards: Gift Card, Consumables_Physical_Gift_Cards, Consumables_Email_Gift_Cards
  ```

- **Keepa csv indices we extract:**
  - `csv[0]` — Amazon price (cents)
  - `csv[1]` — New price (cents) — fallback when csv[0] empty
  - `csv[3]` — Sales rank
  - `csv[16]` — RATING (0–50 scale, divide by 10)
  - `csv[17]` — COUNT_REVIEWS
  - `csv[18]` — BUY_BOX_SHIPPING price (we don't use today but cheap to capture)

- **Keepa product fields we extract (top-level):**
  - `title`, `brand`
  - `imagesCSV` — comma-separated list of image keys; we take the first and prepend `https://images-na.ssl-images-amazon.com/images/I/`. For the keyword detail page only (slot-1 ASIN), this gets displayed in the ProductCard.
  - `categoryTree[]` — array of `{catId, name}` — joined with `›` for `category_path`
  - `lastRatingUpdate` — Keepa Time Minutes → ISO date (see helper below)
  - `variations[]` — related ASINs
  - `promotions[]` — current promo info
  - `stats.avg30 / avg90 / avg180 / avg365` — under `stats=1`, but we're not adding `stats=1` here to keep token cost at 2; we'll **read these from csv directly** by averaging the last N entries instead. Decision tradeoff captured in Task 2.
  - **Not captured: `buyBoxSellerIdHistory`.** Requires `stats=1`, which would double per-ASIN cost to 4 tokens. Per user decision 2026-05-15: excluded permanently from this plan. Revisit only if buy-box ownership becomes a critical feature and a higher Keepa tier is in budget.

- **Keepa Time Minutes conversion (fixed in keepaSpotCheck.ts):**

  ```ts
  // Keepa epoch = 2011-01-01 UTC = 1293840000 unix seconds = 21564000 unix minutes
  function keepaMinutesToDate(km: number | null): string | null {
    if (km === null || km < 0) return null;
    return new Date((km + 21564000) * 60 * 1000).toISOString().slice(0, 10);
  }
  ```

- **Dead-ASIN state machine (`enrichment_status` column):**
  - `active` — got price + reviews + rating
  - `no_price` — Keepa returned a product but csv[0]/csv[1] both end on -1 (Amazon stopped listing; the ASIN may still come back)
  - `delisted` — Keepa returned `products: []` (Amazon has fully purged it)
  - `error` — HTTP error or other failure; we'll retry next cycle

  Retry policy: `active` and `no_price` refresh every 7 days. `delisted` skips refresh for 30 days then attempts one re-check. `error` retries next cycle, no special backoff (the weekly cadence is already a natural backoff).

---

## Task 1: Migration 0022 — `asin_weekly_data` table

**Files:**
- Create: `db/migrations/0022_asin_weekly_data.sql`
- Modify: `db/schema.ts` (drizzle table def)

- [ ] **Step 1.1: Write the migration**

Create `db/migrations/0022_asin_weekly_data.sql`:

```sql
-- Per-(asin, week) snapshot of Keepa-sourced product data. Aligns
-- with the kwm weekly cadence so the join is direct: a kwm row at
-- (week_end_date, search_term_id) → up to 3 asins → up to 3
-- asin_weekly_data rows at the same week_end_date.
--
-- We enrich at most once per ASIN per week. Two weeks later, the row
-- for that ASIN at the new week exists alongside the old one; the
-- "current" view is simply ORDER BY week_end_date DESC LIMIT 1 per
-- ASIN, and the historical trajectory is just every row.
--
-- Scope: only top-3 ASINs in kwm with actual_rank <= 100000 AND not
-- in the excluded-categories list (see lib/keepa/categoryExclusions.ts).
-- The Inngest job that fills this table enforces the scope; the table
-- itself has no rank/category constraints.
--
-- enrichment_status state machine:
--   'active'    — got price + reviews + rating (the happy path)
--   'no_price'  — Keepa returned the product but no current price
--                 (csv[0] and csv[1] both -1 at last position).
--                 Amazon stopped listing; may come back.
--   'delisted'  — Keepa returned no product at all. Fully purged.
--   'error'     — HTTP/network error or parse failure. error_message
--                 has detail.
--
-- Refresh policy is in the job logic, not the schema:
--   active/no_price → refresh every 7 days
--   delisted        → skip for 30 days, then one re-check
--   error           → retry next weekly cycle

CREATE TABLE asin_weekly_data (
  asin                   text NOT NULL,
  week_end_date          date NOT NULL,

  -- Product metadata (Keepa product object)
  title                  text,
  brand                  text,

  -- Primary product image URL. Keepa returns imagesCSV (comma-separated
  -- image keys); we take the first one and prepend the Amazon image
  -- CDN host. May be null for some ASINs. We don't host the bytes —
  -- the URL points at Amazon's CDN directly.
  image_url              text,

  -- Specific category path
  category_path          text,              -- "Tools › Bath › Faucets"
  category_root          text,              -- denormalized leaf-most for filters
  category_leaf          text,

  -- Time-varying metrics (Keepa csv array)
  current_price_cents    integer,           -- csv[0] or csv[1] last value
  sales_rank             integer,           -- csv[3] last value
  review_count           integer,           -- csv[17] last value
  average_rating_x10     integer,           -- csv[16] last value (0-50, divide by 10 for stars)
  last_rating_update     date,              -- product.lastRatingUpdate (Keepa Minutes → date)

  -- Trailing-window averages, computed from csv[0] history
  avg30_price_cents      integer,
  avg90_price_cents      integer,
  avg180_price_cents     integer,
  avg365_price_cents     integer,

  -- Variations array (sibling ASINs) — JSONB array of ASIN strings
  variations             jsonb,

  -- Promotions JSONB — Keepa's promotions field as-is
  promotions             jsonb,

  -- NOTE: buy_box_seller_id intentionally NOT stored. Requires Keepa
  -- stats=1 which doubles per-ASIN token cost; excluded per the 2026-05-15
  -- planning conversation.

  -- Enrichment metadata
  enrichment_status      text NOT NULL CHECK (
    enrichment_status IN ('active', 'no_price', 'delisted', 'error')
  ),
  error_message          text,
  enriched_at            timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (asin, week_end_date)
);

-- Lookup by week + category for the cascading filter
CREATE INDEX asin_weekly_data_week_category_idx
  ON asin_weekly_data (week_end_date, category_root);

CREATE INDEX asin_weekly_data_week_leaf_idx
  ON asin_weekly_data (week_end_date, category_leaf);

-- Look up all weeks for a given ASIN (rank trajectory queries)
CREATE INDEX asin_weekly_data_asin_idx
  ON asin_weekly_data (asin);

-- For the delisted re-check policy: "ASINs marked delisted ≥ 30 days ago"
CREATE INDEX asin_weekly_data_status_enriched_at_idx
  ON asin_weekly_data (enrichment_status, enriched_at)
  WHERE enrichment_status = 'delisted';

COMMENT ON TABLE asin_weekly_data IS
  'Per-(asin, week) snapshot of Keepa-sourced product data. Latest row '
  'per ASIN = current state; full set per ASIN = weekly trajectory. '
  'Filled by inngest/functions/enrichKeepaForWeek.ts after each kcs refresh.';
```

- [ ] **Step 1.2: Update the drizzle migration journal**

Append the new migration to `db/migrations/meta/_journal.json` mirroring the 0021 entry — bump `idx`, use the new filename, current timestamp.

- [ ] **Step 1.3: Add the drizzle table definition**

In `db/schema.ts`, add a `pgTable` for `asin_weekly_data` matching the SQL above. Don't worry about expressing the partial index in drizzle — drizzle-kit will diff and ignore. Pattern: copy the shape from an existing wide-row table in the same file.

- [ ] **Step 1.4: Apply the migration locally**

Run: `pnpm db:migrate`
Expected: "0022_asin_weekly_data applied"

- [ ] **Step 1.5: Commit**

```bash
git add db/migrations/0022_asin_weekly_data.sql db/migrations/meta/_journal.json db/schema.ts
git commit -m "feat(db): migration 0022 — asin_weekly_data for Keepa enrichment

Per-(asin, week_end_date) table holding Keepa-sourced product data:
title/brand, specific category path, current price, sales rank,
review count, average rating, 30/90/180/365-day average prices,
variations, promotions, and an enrichment_status state machine for
dead/delisted ASINs. Joins to kwm on (asin, week_end_date). Filled
by a weekly Inngest job triggered after each kcs refresh."
```

---

## Task 2: Keepa client library

**Files:**
- Create: `lib/keepa/types.ts`
- Create: `lib/keepa/parse.ts`
- Create: `lib/keepa/parse.test.ts`
- Create: `lib/keepa/client.ts`
- Create: `lib/keepa/categoryExclusions.ts`
- Modify: `scripts/countEnrichableAsins.ts` (import from new module)

- [ ] **Step 2.1: Write the types module**

Create `lib/keepa/types.ts` with `KeepaProductResponse`, `ParsedKeepaProduct`, and `EnrichmentRow` types. The first two mirror Keepa's response shape (loose, partial); the third is what we INSERT into `asin_weekly_data`. Include the `EnrichmentStatus` enum union.

- [ ] **Step 2.2: Write `parse.ts` with the csv-extraction logic**

Implement these pure functions in `lib/keepa/parse.ts`:

- `lastCsvValue(arr: unknown): number | null` — returns the last value from a Keepa csv array (alternating timestamp,value pairs), or null if the array is empty / last value is -1.
- `keepaMinutesToDate(km: number | null): string | null` — uses the corrected formula from the spot-check fix.
- `averageCsvLastN(arr: unknown, days: number, fromMinutes: number): number | null` — computes the trailing-window average across csv entries within `days` of `fromMinutes` (the "now" Keepa minute). Returns cents or null if too few data points.
- `parseKeepaProduct(rawProduct: unknown, asin: string, weekEndDate: string): EnrichmentRow` — the orchestrator. Handles the four `enrichment_status` cases:
  - product is null/undefined → `delisted`
  - csv[0] and csv[1] both -1 at last → `no_price` (still capture reviews/rating/category/image)
  - otherwise → `active`
- `primaryImageUrl(imagesCSV: string | null | undefined): string | null` — splits Keepa's comma-separated `imagesCSV` and returns `https://images-na.ssl-images-amazon.com/images/I/${firstKey}`, or null if there's no key. Used by `parseKeepaProduct` to populate `image_url`.

For the trailing averages: Keepa's csv arrays go back roughly 2 years for popular products. Walk backward from the most recent entry until the timestamp is ≥ N days old; average the values in between.

- [ ] **Step 2.3: Write `parse.test.ts` against captured fixtures**

Capture a few real Keepa responses from the spot-check ASINs into `lib/keepa/__fixtures__/` (JSON files). Write vitest cases:

- `active` ASIN (e.g. B07BGLT25K toilet paper) → all fields populated including `image_url`, `enrichment_status: 'active'`
- `no_price` ASIN (e.g. B0GX1XP72Z needoh, the one that came back with no current price in the spot-check) → reviews/rating/image set, price null, status `no_price`
- Synthesized `delisted` (manually-crafted empty-products response) → status `delisted`, image_url null
- `keepaMinutesToDate` round-trip (today, epoch, negative input → null)
- `averageCsvLastN` against a synthetic 365-day csv array
- `primaryImageUrl` with: a multi-image CSV (returns first), single-image CSV, null/empty input (returns null)

Run: `pnpm vitest run lib/keepa/parse.test.ts` → all green.

- [ ] **Step 2.4: Write the client module with token-bucket pacing**

Create `lib/keepa/client.ts`:

```ts
/**
 * Keepa API client. Reads tokensLeft from each response and sleeps
 * when the bucket gets low. Designed for sequential per-ASIN calls
 * (which is what the weekly enrichment job does); not parallel.
 *
 * Tier assumption: 250 tokens/min. At 2 tokens/ASIN we average ~2
 * ASINs/sec. We treat tokensLeft < REFILL_FLOOR (50) as "wait until
 * the bucket refills by at least REFILL_AMOUNT (100)" then proceed.
 * That gives ~24s of guaranteed headroom per pause.
 */
const KEEPA_BASE = 'https://api.keepa.com/product';
const REFILL_RATE_PER_SEC = 250 / 60;  // ~4.17 tokens/sec on the 250 tier
const REFILL_FLOOR = 50;
const REFILL_AMOUNT = 100;

interface KeepaCallResult {
  data: unknown;          // raw response (we hand to parseKeepaProduct)
  tokensLeft: number;
  tokensSpent: number;    // computed: prev - current
}

export async function callKeepa(asin: string, opts: { rating?: boolean }): Promise<KeepaCallResult> {
  // implementation: fetch, parse JSON, return; expose tokensLeft
}

export class KeepaPacer {
  private lastTokensLeft: number | null = null;
  async maybeSleep(): Promise<{ slept: boolean; ms: number }> {
    if (this.lastTokensLeft === null || this.lastTokensLeft >= REFILL_FLOOR) {
      return { slept: false, ms: 0 };
    }
    const need = REFILL_AMOUNT - this.lastTokensLeft;
    const ms = Math.ceil(need / REFILL_RATE_PER_SEC) * 1000;
    await new Promise((r) => setTimeout(r, ms));
    return { slept: true, ms };
  }
  observe(tokensLeft: number) { this.lastTokensLeft = tokensLeft; }
}
```

The client returns raw JSON; parsing is in `parse.ts`. Separation lets us test parse against fixtures without mocking fetch.

- [ ] **Step 2.5: Extract excluded categories into a shared module**

Create `lib/keepa/categoryExclusions.ts` with the 24-category list as a `Set<string>` plus a `isExcludedCategory(cat: string | null): boolean` helper.

Modify `scripts/countEnrichableAsins.ts` to import this list instead of declaring it inline. Verify the script still produces the same numbers as before (~140K).

- [ ] **Step 2.6: Commit**

```bash
git add lib/keepa/ scripts/countEnrichableAsins.ts
git commit -m "feat(keepa): client library + parser + token-bucket pacing

Five files in lib/keepa/:
  - types.ts        — shared types (KeepaProductResponse, EnrichmentRow)
  - parse.ts        — pure functions: lastCsvValue, keepaMinutesToDate,
                       averageCsvLastN, parseKeepaProduct
  - parse.test.ts   — vitest against captured fixtures, covers all
                       four enrichment_status cases
  - client.ts       — fetch wrapper + KeepaPacer (token-bucket sleep)
  - categoryExclusions.ts — single source of truth for the 24-cat list

countEnrichableAsins.ts now imports the exclusion list from the new
module."
```

---

## Task 3: Dev smoke test (50-ASIN slice)

**Files:**
- Create: `scripts/keepaSmokeTest.ts`

End-to-end pipeline validation against a 50-ASIN slice before we trust
the Inngest function with the full 140K. Tests every link: candidate
SQL → Keepa fetch → pacer → parser → DB INSERT with the real enum
type. Cost: 100 tokens (~25 s wall). Lives in `scripts/` because it's
a one-off — not part of recurring production flow.

Crucially **not** the cold-fill: the actual 140K enrichment runs
through the Inngest function (Task 5), not this script. Doing 19 h of
work on a local laptop would be a resilience disaster; that's what
the Railway worker is for.

- [ ] **Step 3.1: Write the script**

Create `scripts/keepaSmokeTest.ts`:

1. Connect to Postgres (pg.Pool, TCP, statement_timeout 60s).
2. Read `current_week_end_date` from `keyword_current_summary_meta`.
3. Run a candidate query: top-3 in-scope ASINs at rank ≤ 100K, NOT excluded category, NOT already in `asin_weekly_data` for this week — `LIMIT 50`. Use `EXCLUDED_CATEGORIES_ARRAY` from `lib/keepa/categoryExclusions.ts`.
4. Initialize `KeepaPacer` (won't actually fire for only 50 calls but exercise the wiring).
5. For each ASIN:
   - `await pacer.maybeSleep()`
   - `const r = await callKeepa(asin, { rating: true })`
   - `pacer.observe(r.tokensLeft)`
   - `const row = parseKeepaProduct(r.data.products?.[0], asin, weekEndDate)`
   - INSERT into `asin_weekly_data` via drizzle with `.onConflictDoNothing()`
   - On error: build an `emptyRow` with status `error`, INSERT that, log + keep going.
6. Print per-ASIN: `[i/50] tokensLeft=X spent=Y status=Z asin=ABC123`
7. On exit, print: status histogram, sample 1 row per non-active status (so we can eyeball them), total tokens spent, wall time.

Keep functions small. Each error caught and recorded — never crash the run.

- [ ] **Step 3.2: Run the smoke test**

```
pnpm tsx scripts/keepaSmokeTest.ts
```

Expected: 50 rows inserted in ~25 s, mostly `active` status, possibly 1-2 `no_price`. Pacer almost certainly never triggers at 50 ASINs (would need 50+ left in the bucket below floor; we start full).

- [ ] **Step 3.3: Spot-check the rows**

Quick SQL to inspect what landed:

```sql
SELECT enrichment_status, COUNT(*)
FROM asin_weekly_data
WHERE week_end_date = (SELECT current_week_end_date FROM keyword_current_summary_meta)
GROUP BY 1;

SELECT asin, title, current_price_cents / 100.0 AS price,
       review_count, average_rating_x10 / 10.0 AS rating, category_path,
       enrichment_status
FROM asin_weekly_data
WHERE week_end_date = (SELECT current_week_end_date FROM keyword_current_summary_meta)
ORDER BY enriched_at DESC LIMIT 10;
```

Look for: titles populated, prices sensible (not all NULL, not all $0), categories filled, ratings 0-50, reviews non-negative. If anything looks off, fix the parser and re-run (script picks up only the not-yet-enriched ASINs each time).

- [ ] **Step 3.4: Commit**

```bash
git add scripts/keepaSmokeTest.ts
git commit -m "test(keepa): 50-ASIN end-to-end smoke test"
```

---

## Task 4: Inngest function — weekly enrichment

**Files:**
- Create: `inngest/functions/enrichKeepaForWeek.ts`
- Create: `lib/notifications/buildEnrichmentEmail.ts`
- Create: `lib/notifications/sendEnrichmentEmail.ts`
- Create: `lib/notifications/buildEnrichmentEmail.test.ts`
- Modify: `inngest/functions/index.ts` (register the new function)
- Modify: `inngest/functions/importFile.ts` (emit the trigger event after `refreshKeywordCurrentSummary()` succeeds — `refreshSummary.ts` is a plain function, the call site that owns the post-refresh side effects is `processFileImport` in `importFile.ts`)

This is the production path for both the initial backfill (Task 5) and ongoing weekly maintenance. Runs on the Railway worker (no Vercel timeout), step.run-checkpointed (resilient to restart), and configured `concurrency: 1` so a duplicate trigger event can't spawn a parallel run that would fight for Keepa tokens. Sends a completion email to admin users at the end.

- [ ] **Step 4.1: Write the enrichment-completion email module**

Mirror the existing `lib/notifications/buildImportEmail.ts` + `sendImportEmail.ts` pattern.

- `buildEnrichmentEmail.ts` — pure function. Input: `{ weekEndDate, counts: Record<AsinEnrichmentStatus, number>, durationMs, tokensSpent, appUrl }`. Output: `{ subject, text, html }`. Single `'completed'` variant for Phase 1; revisit later if we want a `'completed_with_errors'` variant when error % is unusually high.
- `sendEnrichmentEmail.ts` — Resend wrapper. Same recipient lookup as `sendImportEmail` (`role='admin'` users with non-null email). Fail-soft: missing `RESEND_API_KEY` or Resend API error logs a warning and returns — never crashes the Inngest run.
- `buildEnrichmentEmail.test.ts` — vitest snapshot of the rendered subject + text + html, mirrors `buildImportEmail.test.ts` shape.

Example rendered text body:

```
Enrichment of the 2026-05-02 week's top-3 ASINs is complete.

Duration:           18h 42min
ASINs processed:    140,857
Status breakdown:
  Active            139,201   (98.8%)
  No price            1,389   (1.0%)
  Delisted              198   (0.1%)
  Error                  69   (<0.1%)
Tokens spent:       ~281,600

Detail-page product cards and review/rating columns for this week
are now showing fresh Keepa data.

View latest data: https://amazon-analytics-beta.vercel.app/explorer
```

- [ ] **Step 4.2: Write the function (with `concurrency: 1`)**

Create `inngest/functions/enrichKeepaForWeek.ts`. Trigger: event `keepa.enrich-week-requested` with payload `{ weekEndDate: string }`.

Strategy: chunk the work into batches of ~250 ASINs, each batch wrapped in `step.run(\`batch-\${i}\`, ...)`. 250 ASINs × 2 tokens = 500 tokens = ~2 min API time per batch, well under Inngest's HTTP timeout. Inside a batch, sequentially process each ASIN with the pacer.

Configuration:

```ts
export const enrichKeepaForWeek = inngest.createFunction(
  {
    id: 'enrich-keepa-for-week',
    name: 'Enrich Keepa data for a week',
    // Single-run mutex: prevents a duplicate trigger event (or a
    // re-fire while a prior run is still in flight) from spawning
    // a parallel function that fights for Keepa tokens.
    concurrency: { limit: 1, key: 'event.data.weekEndDate' },
  },
  { event: 'keepa.enrich-week-requested' },
  async ({ event, step }) => {
    // ...
  },
);
```

Function body shape:

```ts
const { weekEndDate } = event.data;
const startedAt = Date.now();
const todo = await step.run('list-asins-to-enrich', async () => listScope(weekEndDate));
const batches = chunk(todo, 250);

for (let i = 0; i < batches.length; i++) {
  await step.run(`batch-${i}`, async () => {
    const pacer = new KeepaPacer();
    for (const asin of batches[i]) {
      await pacer.maybeSleep();
      try {
        const r = await callKeepa(asin, { rating: true });
        pacer.observe(r.tokensLeft);
        const row = parseKeepaProduct(r.data?.products?.[0], asin, weekEndDate);
        await db.insert(asinWeeklyData).values(row).onConflictDoNothing();
      } catch (e) {
        const row = emptyRow(asin, weekEndDate, 'error', (e as Error).message);
        await db.insert(asinWeeklyData).values(row).onConflictDoNothing();
      }
    }
  });
}

// After all batches: roll up the status histogram from the DB
// (don't trust in-memory counters — step.run replays might double-count)
// then send the admin completion email. Wrap in step.run so a Resend
// flake gets retried independently of the enrichment work.
await step.run('send-completion-email', async () => {
  const counts = await readStatusHistogram(weekEndDate);
  const tokensSpent = todo.length * 2; // approximate: 2 tokens / ASIN
  await sendEnrichmentEmail({
    weekEndDate,
    counts,
    durationMs: Date.now() - startedAt,
    tokensSpent,
  });
});

return { totalAsins: todo.length, batches: batches.length };
```

The `listScope` candidate query must:

- Pull top-3 in-scope ASINs at rank ≤ 100K, excluded categories filtered out
- Exclude ASINs already in `asin_weekly_data` for this week (lets re-runs resume)
- Include the "delisted re-check" set per Task 6: ASINs whose most-recent `enriched_at` for status `delisted` is > 30 days ago

Notes:

- A fresh `KeepaPacer` per batch. Each `step.run` is a fresh function invocation in Inngest's model — state doesn't persist across step boundaries. First call in a batch never sleeps; if tokensLeft is low coming out of that first call, the pacer kicks in for the rest.
- `step.run` deduplicates by step ID; on resume after crash/restart, batches already completed are skipped entirely.

- [ ] **Step 4.3: Wire up the trigger in `processFileImport`**

`refreshSummary.ts` is a plain async function, not an Inngest function — there's no `step.sendEvent` available. The right call site is `processFileImport` in `inngest/functions/importFile.ts`, right after `refreshKeywordCurrentSummary()` returns successfully:

```ts
if (!isReplay && summaryRefreshOk && refreshResult?.currentWeekEndDate) {
  try {
    await inngest.send({
      name: 'keepa.enrich-week-requested',
      data: { weekEndDate: refreshResult.currentWeekEndDate },
    });
  } catch (sendErr) {
    console.error('[keepa.enrich-week-requested] send failed:', sendErr);
    // Don't fail the import — refire from Inngest dashboard if needed.
  }
}
```

Gated on:
- `!isReplay` — replay runs do bulk-final refresh + enrichment elsewhere; per-file events would emit 53 enrichment runs.
- `summaryRefreshOk` — if kcs is stale, firing enrichment for the new week would race ahead of the data it's enriching.

This decouples kcs refresh latency from the (much longer) enrichment work.

- [ ] **Step 4.4: Register the function**

In `inngest/functions/index.ts`, add `enrichKeepaForWeek` to the exported `functions` array.

- [ ] **Step 4.5: Deploy to Railway**

`KEEPA_API_KEY` must be set in Railway env vars before this can run. Deploy the worker (push to main, or whatever the deploy flow is — Railway auto-redeploys on `main` push by default per `railway.json`).

Hit the worker health endpoint after deploy: `curl https://<worker-url>/` — confirm the function count includes the new function (it should bump from 3 to 4 in the `functions` field of the health JSON).

- [ ] **Step 4.6: Test with a 5-ASIN payload (verify the email lands)**

Before firing for real, send a synthetic event with a tiny ASIN list to confirm the deployed function works end-to-end through Inngest Cloud → Railway worker → Postgres. Use the Inngest dashboard's "Send event" tool with a dummy payload or use `inngest.send(...)` from a one-off script.

Actually: since the function reads its own ASIN list from `listScope(weekEndDate)`, the simplest test is to fire the event for an OLD week we've already enriched (e.g. 2026-04-something). The function will find nothing new to enrich (everything already in asin_weekly_data), complete in seconds, and confirm wiring works.

- [ ] **Step 4.7: Commit**

```bash
git add inngest/functions/enrichKeepaForWeek.ts \
        inngest/functions/index.ts \
        inngest/functions/refreshSummary.ts \
        lib/notifications/buildEnrichmentEmail.ts \
        lib/notifications/sendEnrichmentEmail.ts \
        lib/notifications/buildEnrichmentEmail.test.ts
git commit -m "feat(inngest): weekly Keepa enrichment job + completion email

New Inngest function enrichKeepaForWeek fires on the
keepa.enrich-week-requested event (emitted by refreshSummary
after each kcs swap). Processes the ~140K in-scope ASINs in
250-ASIN batches via step.run; concurrency: 1 keyed on
weekEndDate prevents duplicate triggers from spawning parallel
runs that would fight for tokens. Errors per-ASIN are caught
and recorded as status='error' rows so a single bad fetch
doesn't kill the batch.

Sends a completion email to admin users at the end via
sendEnrichmentEmail (mirrors sendImportEmail; fail-soft on
Resend errors). Separate email from the import-complete
notification because enrichment is ~19h and users care about
those completion signals independently."
```

---

## Task 5: Fire the event for current week + verify coverage

This is the cold-fill of `asin_weekly_data`. Done via the production Inngest function (Task 4), not a local script — gives us resilience to laptop sleep / network blips / Railway restarts that a 19h local run wouldn't have.

- [ ] **Step 5.1: Confirm Keepa balance + Railway env**

- Keepa dashboard: enough monthly tokens for ~280K-token backfill (refresh date, balance, plan tier).
- Railway dashboard: `KEEPA_API_KEY` is set on the worker service. Health endpoint shows the new function registered.

- [ ] **Step 5.2: Fire the event for the current week**

Send the event via Inngest dashboard ("Send event" → name `keepa.enrich-week-requested`, data `{"weekEndDate": "<current-week-iso>"}`), or via a one-off script:

```ts
import { inngest } from '@/inngest/client';
await inngest.send({
  name: 'keepa.enrich-week-requested',
  data: { weekEndDate: '2026-05-02' }, // whatever current_week_end_date is at the time
});
```

- [ ] **Step 5.3: Watch progress in the Inngest dashboard**

The function runs ~280K tokens / 250 per min = ~18-19 h total. Dashboard shows step-by-step progress (`batch-0 done`, `batch-1 done`, ...). Each batch is ~2 min of API time. If a batch fails, Inngest retries that step from scratch; already-processed ASINs inside that batch will skip via `ON CONFLICT DO NOTHING`. We may double-spend tokens on already-inserted ASINs in a retried batch — that's a known minor cost of the per-batch retry granularity, and tiny in practice.

- [ ] **Step 5.4: Verify coverage post-run**

Create `scripts/verifyKeepaCoverage.ts`:

```ts
// Reports, for the current kcs week:
//   - How many top-3 in-scope ASINs exist for this week
//   - How many have an asin_weekly_data row
//   - Status histogram: active / no_price / delisted / error
//   - For 'error' rows, a sample of error messages so we can fix patterns
```

Run: `pnpm tsx scripts/verifyKeepaCoverage.ts`

Expected: ≥99% of in-scope ASINs have a row; `error` count < 1% and the messages look transient (timeouts, occasional 5xx). If `error` is substantial or systematic, fix `lib/keepa/client.ts` or `parse.ts`, then refire the event — the function will pick up only the not-yet-enriched ASINs.

- [ ] **Step 5.5: Spot-check against the markdown reference**

The 15 ASINs in `docs/keepa-spot-check-2026-05-15.md` should all have asin_weekly_data rows:

```sql
SELECT a.asin, a.title, a.current_price_cents / 100.0 AS price,
       a.review_count, a.average_rating_x10 / 10.0 AS rating,
       a.category_path, a.enrichment_status
FROM asin_weekly_data a
WHERE a.asin IN (
  'B07BGLT25K','B0CQXMXJC5','B08JDXHM5V','B0BZYCJK89','B0009X29WK',
  'B0GWZL1YM1','B0D76KNJ5S','B0GX1XP72Z','B0GTLN2F6S','B07C3SWZXK',
  'B0785RNKZS','B01NA0JVO4','B09MLQMBHN','1668236516','B0FH655984'
)
AND a.week_end_date = (SELECT current_week_end_date FROM keyword_current_summary_meta);
```

Confirm values match the spot-check markdown. B0GX1XP72Z should be `no_price`.

- [ ] **Step 5.6: Commit the verification script**

```bash
git add scripts/verifyKeepaCoverage.ts
git commit -m "test(keepa): post-backfill coverage check

Counts in-scope ASINs vs enriched rows for the current week,
breaks down by enrichment_status, samples error messages.
Run after firing a keepa.enrich-week-requested event to
confirm the Inngest function completed cleanly."
```

---

## Task 6: Delisted re-check job

**Files:**
- Modify: `inngest/functions/enrichKeepaForWeek.ts` (add the delisted-recheck list)

ASINs marked `delisted` in a prior week shouldn't be re-fetched every 7 days (wasted tokens). After 30 days, attempt one re-check — if Keepa now has the product, it'll insert a fresh row; if still delisted, the existing rows stay as they were and we'll wait another 30 days.

- [ ] **Step 6.1: Extend the candidate query**

In `enrichKeepaForWeek.ts` and `backfillKeepaCurrentWeek.ts`, the candidate list for the week should be:

```
top-3 in-scope ASINs for this week AS new_candidates
UNION
ASINs that have any row where enrichment_status = 'delisted'
  AND the most-recent enriched_at for that ASIN is > 30 days ago
  AND the ASIN is still in scope for the current week
  AS delisted_rechecks
```

The second set is small (delisted is rare) and gives us self-healing without forever-retrying.

- [ ] **Step 6.2: Verify**

After deploying this, a few weeks later, query for ASINs that flipped from delisted → active in a later week. Should be a handful per quarter, not zero.

- [ ] **Step 6.3: Commit**

```bash
git add inngest/functions/enrichKeepaForWeek.ts scripts/backfillKeepaCurrentWeek.ts
git commit -m "feat(keepa): re-check delisted ASINs every 30 days

Adds a second candidate set to the weekly enrichment job: ASINs
previously marked delisted whose most-recent enriched_at is > 30
days old. Lets us recover ASINs that come back online without
wasting tokens on still-dead ones every week."
```

---

## Task 7: Detail page product cards

**Files:**
- Create: `app/explorer/keyword/[id]/ProductCard.tsx`
- Modify: `app/explorer/keyword/[id]/page.tsx`

Today the top-3 product display on the detail page is a simple table row with ASIN, title, brand, click share, conversion share. We replace it with a richer card per ASIN: price, reviews/rating, category breadcrumb, link to Amazon. The card is server-rendered (we already have the data via the page's loader).

- [ ] **Step 7.1: Extend the detail page loader**

In `app/explorer/keyword/[id]/page.tsx`, after the existing kwm + kcs fetch, add a fetch for the asin_weekly_data rows for the top-3 ASINs at the current week:

```ts
const enrichedByAsin = new Map<string, AsinWeeklyData>();
for (const asin of [...top1Asin, ...top2Asin, ...top3Asin].filter(Boolean)) {
  // pull all weeks for these ASINs at the current week_end_date in one query
}
```

Pass the map to the new `<ProductCard>` component.

- [ ] **Step 7.2: Create the ProductCard component**

The component takes `slotIndex: 1 | 2 | 3`. **Only slot 1 renders the product image** — keeps the page light and emphasizes the dominant click recipient. Slots 2 and 3 are text-only cards.

Slot 1 layout (image left, data right):

```
┌──────────────────────────────────────────────────────────────┐
│  ┌──────┐  B07BGLT25K  (rank 1)                              │
│  │      │  Charmin Ultra Soft Toilet Paper, 12 Mega Rolls    │
│  │ IMG  │  Brand: Charmin                                    │
│  │ 160x │                                                    │
│  │ 160  │  $5.68    ★ 4.5 (138,242 reviews)                  │
│  │      │                                                    │
│  └──────┘  Health & Household › Household Supplies › Paper   │
│            Avg price (30d/90d/180d/365d): $5.42 / $5.55 ...  │
│            [View on Amazon →]                                │
└──────────────────────────────────────────────────────────────┘
```

Slots 2 & 3 layout (no image):

```
┌──────────────────────────────────────────────────────┐
│ B0CQXMXJC5  (rank 2)                                  │
│ Sony WH-CH720N Wireless Headphones                    │
│ Brand: Sony   $39.98    ★ 4.6 (63,190 reviews)        │
│ Electronics › Headphones › Over-Ear                   │
│ [View on Amazon →]                                    │
└──────────────────────────────────────────────────────┘
```

Image: `<img src={enriched.image_url} width={160} height={160} loading="lazy" alt="" />`. If `image_url` is null (some ASINs don't have one), fall back to a placeholder rectangle so the layout stays consistent.

If `enrichment_status === 'delisted'` or `'no_price'`, show "Currently unavailable on Amazon" instead of price; keep the image and rest of the data.

- [ ] **Step 7.3: Manual smoke test**

Open `/explorer/keyword/<some-id>` in dev. The three top ASINs should now show the Keepa-enriched data. Click "View on Amazon" — should open the correct product.

- [ ] **Step 7.4: Commit**

```bash
git add app/explorer/keyword/[id]/
git commit -m "feat(detail): Keepa-enriched product cards for top-3 ASINs

New ProductCard component shows price, reviews/rating, full
category breadcrumb, trailing-window average prices, and a link
to Amazon. Falls back to 'currently unavailable' for no_price /
delisted ASINs."
```

---

## Task 8: Explorer review/rating columns

**Files:**
- Modify: `app/explorer/page.tsx`
- Modify: `lib/explorer/runQuery.ts`

Add two optional columns to the explorer table: review count and average rating (both for the **slot-1** ASIN). Off by default; user can toggle them on via the column picker (assuming one exists — if not, just add them with a feature flag for now).

- [ ] **Step 8.1: Extend runQuery to LEFT JOIN asin_weekly_data**

In `lib/explorer/runQuery.ts`, when the user enables the review/rating columns (passed as a prop / search param), LEFT JOIN `asin_weekly_data` ON `(kwm.top_clicked_product_1_asin, kwm.week_end_date)` and SELECT `review_count`, `average_rating_x10`.

The join cost is small because we're already filtering kwm down to the current week. Keep it conditional so we don't pay for it when the columns are off.

- [ ] **Step 8.2: Render the columns**

In `app/explorer/page.tsx`'s table, add two new columns (`review_count`, `rating`) with proper formatting (reviews with thousands separator, rating as `4.5★`).

- [ ] **Step 8.3: Commit**

```bash
git add app/explorer/ lib/explorer/
git commit -m "feat(explorer): optional review-count + rating columns

LEFT JOIN to asin_weekly_data when the user opts in. Off by
default so we don't pay the join cost on every page load."
```

---

## Task 9: Cascading category filter (Phase 1 — leaf-only)

**Files:**
- Create: `lib/explorer/listLeafCategories.ts`
- Modify: `lib/explorer/runQuery.ts`
- Modify: `app/explorer/page.tsx`

The existing category filter is a flat dropdown of top-level Amazon SFR categories (~30 options). Keepa gives us a 4-6-level path. For Phase 1, we add a **leaf-category filter** alongside the existing top-level one — a second dropdown that, when set, narrows results to a specific leaf category. Full tree drilldown is a future enhancement.

- [ ] **Step 9.1: List distinct leaf categories**

Create `lib/explorer/listLeafCategories.ts`. Query: `SELECT DISTINCT category_leaf FROM asin_weekly_data WHERE week_end_date = $1 ORDER BY category_leaf`. Cache via `react.cache()` like the existing `listCategories`.

If this turns out slow (>500ms) cold, we precompute a facet table like we did for top-level categories in migration 0021. For now: try the live DISTINCT and measure.

- [ ] **Step 9.2: Add the filter to the explorer query**

In `runQuery.ts`, when `leafCategory` is set in the filter, join to `asin_weekly_data` (same join as Task 8) and add `WHERE asin_weekly_data.category_leaf = $leafCategory`.

- [ ] **Step 9.3: UI**

Add a second dropdown next to the existing category dropdown, populated from `listLeafCategories`. Wire to the same router-based filter pattern as the existing one.

- [ ] **Step 9.4: Commit**

```bash
git add app/explorer/ lib/explorer/
git commit -m "feat(explorer): leaf-category filter (Phase 1, flat)

Second dropdown showing distinct category_leaf values from
asin_weekly_data for the current week. Filters explorer results
to that leaf. Full tree drilldown is a future enhancement."
```

---

## Constraints / non-goals

- **No PA-API.** We're not eligible without Associate sales; Keepa is the only path.
- **Image bytes not hosted.** We reference Keepa/Amazon's CDN URL directly (`https://images-na.ssl-images-amazon.com/images/I/{key}`). No proxying, no Vercel Blob storage. Trade-off: if Amazon rotates a key, the image 404s; we'd refresh it on the next weekly enrichment cycle. Good enough.
- **Image shown only on slot-1 of the detail page.** Slots 2/3 are text-only to keep the page light. Explorer table doesn't render images at all.
- **Buy-box seller permanently excluded.** Requires `stats=1`, doubling token cost. Confirmed dropped on 2026-05-15.
- **Top 100K rank only.** Lower ranks are not enriched. If we want them later, that's a scope change.
- **Top 3 ASIN slots only.** Slots 4-10 are not in the SFR data anyway.
- **No real-time enrichment.** We only refresh once a week per ASIN. If price changes mid-week, the user sees stale data until the next cycle.
- **No partition strategy on asin_weekly_data.** At ~140K rows/week × 52 weeks/yr ≈ 7M rows/yr, a single table is fine for 2-3 years. Revisit if it grows past ~50M rows.
- **No retroactive backfill of historical kcs weeks in Phase 1.** Only the current week (and going forward). See "Future work" below for the 4-12 week opportunistic backfill we may run with idle token capacity once the weekly steady-state is healthy.

## Future work

- **Opportunistic historical backfill (4–12 weeks).** Once the weekly enrichment is in steady state and we have a sense of how much token headroom we have on quiet days, run a background job that backfills `asin_weekly_data` for 4–12 prior weeks of kcs data. Scope: ASINs that were top-3 at rank ≤ 100K in those weeks **and** still exist today (filter against current `asin_weekly_data` so we don't waste tokens on long-gone ASINs). Keepa tokens don't roll over month-to-month, so this is "free" capacity at the end of any month we don't blow through the cap. Add as a separate plan once we have weekly-cadence data to inform sizing.
- **Buy-box ownership.** Revisit only with a higher Keepa tier in budget.
- **Image hosting/caching.** If CDN rotation 404s become a real UX problem, copy the image bytes to Vercel Blob on first enrichment.
- **Full category tree drilldown.** Phase 1 ships a flat leaf-category dropdown. Hierarchical drill (root → child → leaf) is a follow-up.
- **Variation-family rollups.** With `variations` stored as JSONB, we could later aggregate "all colors of this product" into a single family card.

---

## What success looks like

- Migration 0022 applied; `asin_weekly_data` table holds ~140K rows for the current kcs week within 24h of running the backfill.
- ≥99% of in-scope top-3 ASINs in the current week have `enrichment_status = 'active'`; the remainder split across `no_price` / `delisted` / `error` is small and explicable.
- Detail page shows real Keepa values for the top-3 product cards, with prices, reviews, ratings, and full category breadcrumbs matching Amazon's live pages.
- Explorer can optionally show review-count + rating columns, and filter by leaf category.
- After the next weekly kcs refresh, the Inngest enrichment job runs automatically and populates rows for the new week within ~24h. No manual intervention required.
- Re-running the backfill or the Inngest job on already-enriched data is a no-op (ON CONFLICT DO NOTHING).
- The spot-check ASINs in `docs/keepa-spot-check-2026-05-15.md` all have rows in `asin_weekly_data` for the current week with values matching the markdown.
