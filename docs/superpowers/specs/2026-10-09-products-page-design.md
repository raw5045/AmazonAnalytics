# Products page, ASIN pages and the ASIN-to-keywords lookup — design (2026-10-09)

Arc 7. Brainstormed with the owner 2026-10-09; builds on the Keepa service (arc 6, `docs/superpowers/specs/2026-10-05-keepa-service-design.md`).

## 1. Goal and scope

A product-level way into the data: find ASINs by what the Keepa catalog now knows about them (listing age, "bought in past month" badge, reviews, price, BSR and its 30-day trend, offers, Amazon presence, category), open an ASIN page with everything we hold on it, and see which keywords it is a top-3 clicked product for and for how many weeks. The first use case is the owner's "young, low-review ASINs already selling" screen; the same page and lookup carry the later features:

- **#5 BSR improvers** = a filter on this page (`rank_ratio_x100`).
- **#2 new entrants gaining traction** = a filter over the reverse table built here (`streak_started_week`, `weeks_in_top3`) joined to the review count at entry from `asin_snapshots`. Not built in this arc.
- **#3 / #4 (no-FBA / Amazon-sold top ASINs)** are keyword-side aggregates and a separate small arc.

Out of scope for v1: saved views and CSV export for products, non-admin access, product history older than the snapshots, delisted products in search results, any change to the explorer's filters.

## 2. Decisions (brainstorm 2026-10-09)

1. New **Products** page in the main nav (not an explorer mode, not tools-only).
2. Each result opens an **ASIN page** modelled on the keyword page: facts, history charts, keywords.
3. The ASIN page's keyword list is **current week only**, with **weeks in top 3** per keyword from an incrementally maintained reverse table (the same precompute #2 needs).
4. **Filters v1:** listing age, monthly sold at least, reviews at most + rating range, price range, BSR range + BSR vs 30-day average, category, FBA offer present/absent, Amazon selling yes/no.
5. **AI tools in the same arc, sequenced last** (after the owner's page smoke): `search_products`, `get_product_details`.
6. **Admin only at launch** (page, nav link, tools). Opening up = one eligibility change.
7. Query the catalog live; no second summary table. Streaks are never computed on demand from `keyword_weekly_metrics`.

## 3. Data model — migration 0051 (additive; owner-gated apply script `scripts/applyMigration0051.ts`, `APPLY_0051=yes`)

### 3.1 Catalog additions (`asin_products`)

- `rank_ratio_x100 integer` — `round(100 × sales_rank ÷ avg30_sales_rank)`; null unless both are > 0. Written by the service on every successful fetch (`SUCCESS_UPDATE` in `services/keepa/pgStore.ts`), null on delisted/error outcomes like the other point-in-time facts. Below 100 = better than its 30-day average. Backfilled once by the apply script from the existing columns.
- Partial indexes, all `WHERE in_scope AND enrichment_status IN ('active', 'no_price')`:
  - `asin_products_listed_since_idx (listed_since)`
  - `asin_products_monthly_sold_idx (monthly_sold)`
  - `asin_products_review_count_idx (review_count)`
  - `asin_products_sales_rank_idx (sales_rank)`
  - `asin_products_price_idx (current_price_cents)`
  - `asin_products_rank_ratio_idx (rank_ratio_x100)`
  Category filters use the existing `asin_products_category_path_idx` (text_pattern_ops, in-scope rows). Low-cardinality filters (FBA present, Amazon selling) ride on the bitmap combination of the above; they never drive the plan alone.
- The lane indexes and the service's claim queries are untouched.

### 3.2 Reverse table `keyword_top_asins`

One row per (keyword, ASIN, slot) in the **current week's** top-3 clicked products.

| column | type | meaning |
|---|---|---|
| `search_term_id` | bigint not null | the keyword |
| `asin` | text not null | the product |
| `slot` | smallint not null | 1, 2, 3 (click-share order as imported) |
| `click_share` | numeric(5,2) | from `keyword_weekly_metrics` |
| `conversion_share` | numeric(5,2) | from `keyword_weekly_metrics` |
| `weeks_in_top3` | integer not null | consecutive imported weeks (ending now) the ASIN has been in this keyword's top 3, any slot |
| `streak_started_week` | date not null | the first week of that run |
| `week_end_date` | date not null | the week this table describes (one value per build) |

Primary key `(search_term_id, slot)`; index `keyword_top_asins_asin_idx (asin, search_term_id)`. About 8M rows. The table is replaced wholesale each build (build into `keyword_top_asins_next`, then a single-transaction rename swap), so readers never see a half-built week. A singleton row in `keyword_top_asins_meta (week_end_date, built_at, row_count)` records the current build.

### 3.3 Streak rule

- `weeks_in_top3` = last week's value + 1 when the same (keyword, ASIN) pair existed in last week's table in any slot; otherwise 1 with `streak_started_week` = this week.
- A week with no import (gap) breaks nothing: "last week" means the previous **built** week, whatever its date. Only an actual week in which the pair was not in the top 3 resets the streak.
- Slot changes (1 → 3) keep the streak.

## 4. Building the reverse table

### 4.1 Weekly build — import phase `top_asins_build`

Added to `inngest/functions/importFile.ts` right after the `keepa_enqueue` phase and before the summary refresh, inside `if (!isReplay)`, fail-soft like the enqueue hook: a failure is logged `{ week, stage, code }` (coded fields only), the import continues, and the previous build stays in place. Own `pg.Pool` (max 1, keepalive, error listeners, 30-minute statement timeout), same shape as the enqueue hook.

Pure SQL builders in `lib/topAsins/buildWeek.ts` (`buildTopAsinsStatements(week)`), run by `buildTopAsinsWeek(client, week)`:

```sql
BEGIN;
SET LOCAL statement_timeout = '1800s';
CREATE TABLE keyword_top_asins_next (LIKE keyword_top_asins INCLUDING ALL);
INSERT INTO keyword_top_asins_next (search_term_id, asin, slot, click_share, conversion_share, weeks_in_top3, streak_started_week, week_end_date)
SELECT p.search_term_id, p.asin, p.slot, p.click_share, p.conversion_share,
       COALESCE(prev.weeks_in_top3, 0) + 1,
       COALESCE(prev.streak_started_week, $1::date),
       $1::date
FROM (
  SELECT search_term_id, top_clicked_product_1_asin AS asin, 1 AS slot, top_clicked_product_1_click_share AS click_share, top_clicked_product_1_conversion_share AS conversion_share FROM keyword_weekly_metrics_<year> WHERE week_end_date = $1::date AND top_clicked_product_1_asin ~ '^[A-Z0-9]{10}$'
  UNION ALL ... slot 2 ... UNION ALL ... slot 3 ...
) p
LEFT JOIN LATERAL (
  SELECT weeks_in_top3, streak_started_week FROM keyword_top_asins k
  WHERE k.search_term_id = p.search_term_id AND k.asin = p.asin LIMIT 1
) prev ON true;
DROP TABLE keyword_top_asins;
ALTER TABLE keyword_top_asins_next RENAME TO keyword_top_asins;
-- rename the indexes/constraints back to their canonical names
INSERT INTO keyword_top_asins_meta ... ON CONFLICT (singleton) DO UPDATE ...;
COMMIT;
ANALYZE keyword_top_asins;
```

Guards: refuse a week older than the meta row's week unless forced (`TOP_ASINS_FORCE=1` in the script); refuse to swap when the new table has zero rows. A manual re-run script `scripts/buildTopAsinsWeek.ts` (`TOP_ASINS_WEEK=YYYY-MM-DD`, tracked) mirrors `scripts/fireEnqueueWeek.ts`.

Expected duration: a few minutes (one partition scan for the week plus an 8M × 8M hash join).

### 4.2 One-time backfill — `scripts/backfillTopAsins.ts` (owner-gated, `BACKFILL_TOP_ASINS=yes`)

Walks every week present in `keyword_weekly_metrics` in date order (77 weeks, 2025-04-19 to 2026-10-03 as of writing; the distinct `week_end_date` values of the partitions, not the upload batches, which cover only the last 40), running the same insert logic week by week into a temporary pair of tables, so the final table carries correct streaks and `streak_started_week` values. Each week is its own transaction; progress lines per week; idempotent (re-run restarts from the first week). Estimated 1–2 hours (about a minute per week); run in a quiet hour before the push, so the next import's phase 4.1 finds a previous build. If the import lands first, the phase builds week 1 streaks and the backfill, run afterwards, replaces them.

## 5. Products page — `app/(app)/products/page.tsx` (admin only)

### 5.1 Filters (URL search params; all optional)

| param | meaning | SQL |
|---|---|---|
| `age` | listed within N days: `60`, `90`, `180`, `365` | `listed_since >= current_date - N` |
| `soldMin` | monthly sold at least (badge buckets 50 … 100000) | `monthly_sold >= N` |
| `reviewsMax` | reviews at most | `review_count <= N` (null reviews excluded) |
| `ratingMin`, `ratingMax` | stars × 10 (0–50) | `average_rating_x10 BETWEEN` |
| `priceMin`, `priceMax` | dollars | `current_price_cents BETWEEN` (active rows only have prices) |
| `bsrMin`, `bsrMax` | main BSR range | `sales_rank BETWEEN` |
| `ratioMax` | BSR vs 30-day average, e.g. `70` = at least 30 % better | `rank_ratio_x100 <= N` |
| `cat` | category path or department (the explorer's `LeafCategoryTypeahead` + department select) | `category_path = $x OR starts_with(category_path, $x ∥ ' › ')` |
| `fba` | `yes` / `no` | `fba_offer_count > 0` / `= 0` |
| `amazon` | `yes` / `no` | `amazon_availability >= 0` / `= -1` (or null) |
| `sort`, `dir` | `sold` (default, desc), `listed`, `reviews`, `price`, `bsr`, `ratio`, `keywords` | `ORDER BY … NULLS LAST, asin` |
| `page` | 1-based, 50 rows | `OFFSET` |

Base predicate on every query: `in_scope AND enrichment_status IN ('active', 'no_price')`. `fba = no` means Keepa reported no FBA offers (stored 0); a null count (never fetched) does not match either value.

### 5.2 Results

Columns: product (title, brand; the title links to the ASIN page), listed (date + age), monthly sold (badge value as "1,000+"), reviews (count + stars), price, BSR (+ ratio as "−30 %" when below 100), offers (FBA / FBM), Amazon (yes / no / in stock), keywords (count of current top-3 keywords, from the reverse table via a lateral count on the 50 rows shown). Result count uses the explorer's count pattern (exact up to a cap, then "10,000+").

Layout reuses the explorer's building blocks: `FilterSidebar`-style panel, `ResultsTable`-style table, `Pagination`, `LoadingOverlay`, `ExplorerSkeleton`. No saved views, no export.

### 5.3 Loader — `lib/products/searchProducts.ts`

Pure builder `productSearchSql(filters, sort, page)` (pinned against drizzle's `asinProducts` columns in tests) + `searchProducts(sql, filters)`. Parse/validate params in `lib/products/filters.ts` (zod, shared with the tool contract in §8).

## 6. ASIN page — `app/(app)/products/[asin]/page.tsx` (admin only)

Three streamed blocks, like the keyword page:

1. **Facts card.** Title, brand, image (one thumbnail is fine here), category path, listed since + tracking since, price with avg 30/90/180/365, BSR with avg 30/90 and the ratio, reviews + rating (+ last rating update), monthly sold with `keepa_updated_at` as "as of", new / FBA / FBM offer counts, Amazon availability (text from the Keepa code), status + last fetched + fetch count. Prices only when active; point-in-time facts hidden for delisted rows (same rules as `mapEnrichedProducts`). Loader `lib/products/loadProduct.ts`.
2. **History charts.** Price, BSR, reviews, monthly sold from `asin_snapshots` ordered by `fetched_at` (the table's primary key covers `(asin, fetched_at)`). Same chart library and the same lazy chunk pattern as the keyword page (chart JS only on this page). Loader `lib/products/loadProductHistory.ts`; cap 400 points.
3. **Keywords table.** From `keyword_top_asins` joined to `keyword_current_summary`: keyword, current rank, estimated monthly searches (`estimated_monthly_volume_current`), slot, click share, conversion share, weeks in top 3 (with `streak_started_week` as a tooltip). Sorted by rank; cap 500 rows with a "showing 500 of N" line. Each row links to `/explorer/keyword/[id]`. Loader `lib/products/loadProductKeywords.ts`.

Edge states: an ASIN never fetched (`last_fetched_at IS NULL`) renders the title from the keyword data (`keyword_weekly_metrics.top_clicked_product_n_title`) with a "not fetched yet" line and the keywords table; a delisted ASIN renders with a "delisted" badge; an unknown ASIN is a 404.

## 7. Keyword page link-back

`app/(app)/explorer/keyword/[id]/TopProductsSection.tsx`: the product title links to `/products/[asin]` when the viewer is an admin (the page passes `isAdmin`); non-admins see today's plain text. No other change to the keyword page.

## 8. Query layer and contracts

- `lib/products/filters.ts`: `ProductFilters` zod schema (the §5.1 params with the same bounds the explorer uses for integers), `parseProductFilters(searchParams)`, `productFiltersToSearchParams(filters)`.
- `lib/products/searchProducts.ts`, `loadProduct.ts`, `loadProductHistory.ts`, `loadProductKeywords.ts`: pure SQL builders + loaders over the Neon `sql` client (`NeonQueryFunction<false, false>`), never importing the service's modules.
- `lib/research/contracts.ts` gains `productSearchSchema` (= the filters schema) and the `ProductSummary` / `ProductDetails` result types; `lib/research/products.ts` wraps the loaders for the tools so the page and the tools share one query.

## 9. AI tools (last in the plan)

Two entries in `lib/research/tools.ts` (`RESEARCH_TOOLS`), registered for MCP through `lib/mcp/tools/registerResearchTools.ts` and for Ask AI through `lib/ask/tools.ts` as today:

- `search_products(filters, sort, page)` → up to 50 `ProductSummary` rows + total.
- `get_product_details(asin)` → facts, a history summary (first/last snapshot, points), and the keyword list (cap 100, sorted by rank) with weeks in top 3.

A new `adminOnly: true` flag on the definition is honoured by both registries (the tool is not listed, and a direct call returns the existing "unknown tool" error, for non-admin actors). `get_research_guide` text gains a short "products" section describing the filters and the meaning of the badge and the ratio.

## 10. Access

`requireAdmin()` (`lib/auth/requireAdmin.ts`) at the top of both pages; the `TabNav` entry renders only for admins (the layout already knows the user). Tools: `adminOnly`. Opening up later = remove the three gates.

## 11. Testing

- Unit: filter parsing (bounds, defaults, round-trip to params); `productSearchSql` pinned against schema columns and the base predicate; the build statements (SQL text for the current partition, streak join, swap, guards); loaders with a fake `sql`; page components (filter panel round-trips the URL, results table formatting, ASIN page blocks and edge states); tool contracts (schema ↔ filters), `adminOnly` listing.
- Owner-gated integration (`RUN_INTEGRATION=1`): `tests/integration/topAsinsBuild.test.ts` runs the build for the current week inside a transaction that is rolled back (asserts row count ≈ 3 × keywords with a top-1 ASIN, streak ≥ 1, meta row), and `tests/integration/productsQueries.test.ts` runs each page query once read-only (EXPLAIN uses the partial indexes).
- Smoke after the push: the owner's example search (age 180, sold ≥ 1,000, reviews ≤ 300) returns rows; an ASIN page for one of them with charts and keywords; keyword page → ASIN page → keyword page; the tools from Claude.

## 12. Ship steps (owner-gated, in order)

1. Apply 0051 + ratio backfill (`APPLY_0051=yes …applyMigration0051.ts`; quiet hour; indexes on 2.6M rows take a few minutes each).
2. Backfill the reverse table (`BACKFILL_TOP_ASINS=yes …backfillTopAsins.ts`, 1–2 h over 77 weeks).
3. Integration tests.
4. Push (checkActiveJobs first; the worker restarts and the Keepa service redeploys for the `pgStore.ts` change). Inngest: no new function, no sync needed. Verify the next import's `[top-asins] week … rows=… in …s` line.
5. Smoke, then the tools' tasks.

## 13. Follow-ups (not this arc)

- #2 new entrants: keyword-side filter over `keyword_top_asins` (`streak_started_week` within K weeks, `weeks_in_top3 ≥ M`) + review count at entry from `asin_snapshots` (nearest snapshot at or before `streak_started_week`); an explorer sort/filter and an ASIN-page badge.
- #3 / #4: `top3_no_fba_count`, `top3_amazon_count` on `keyword_current_summary` via the nightly sync, two indexes, two explorer filters (after the read-source flip).
- Saved views and CSV export for products; non-admin access; multi-week history of a keyword's top 3 on the ASIN page; delisted products in search.

## 14. Amendments as landed (2026-10-09/10, from the implementation reviews)

Where a section above and this list disagree, this list is what shipped.

- **§3.2.** `search_term_id` is `uuid` (as `search_terms.id` and `keyword_weekly_metrics.search_term_id` are), not bigint. The previous build is RETAINED as `keyword_top_asins_prev` (an advance renames current → `_prev` after dropping the old `_prev`); a same-week rebuild (a re-imported week, a manual re-run) carries its streaks from `_prev` and drops the stale current table, so rebuilds are idempotent; a forced older-week rewind restarts every streak at 1 and drops `_prev`. The table COMMENTs are re-applied in the swap.
- **§3.1.** The six product-search indexes are composite `(key, asin)` (the tie-break follows the sort direction, so a forward or backward index scan serves the top-N without a sort). `rank_ratio_x100` is a point-in-time fact like `sales_rank`: kept on the row for delisted products (the service never nulls facts), hidden by readers; the SUCCESS write guards int4 overflow (`sales_rank < 21474836 × avg30`) and yields null instead of an error. The 0051 apply script builds the indexes `CONCURRENTLY` on Neon's direct endpoint after the ratio backfill (20k-row cursor batches under the enqueue advisory lock, `IS DISTINCT FROM`, so it is re-runnable after the Keepa redeploy).
- **§4.1.** The streak carry is a plain join against `SELECT DISTINCT ON (search_term_id, asin) … ORDER BY …, weeks_in_top3 DESC` (hash-joinable; the LATERAL form was a nested loop of 8M probes). Builds serialize on `pg_advisory_xact_lock(TOP_ASINS_LOCK_KEY = 20261009)` taken right after `BEGIN ISOLATION LEVEL READ COMMITTED` (the meta read and the `_prev` probe run inside the lock); `SET LOCAL work_mem = '256MB'`; `SET LOCAL lock_timeout = '120s'` immediately before the swap (a long reader makes the build fail and roll back rather than queue every new reader); ANALYZE isolated (`analyzeError` on the result); a Pool is refused (`top_asins_bad_client`). The import phase is `top_asins_build` (fail-soft; only `top_asins_older_than_meta` is a skip; log `[top-asins] week …: rows=… previous=… carried=…`); the admin import chip labels `keepa_enqueue` and `top_asins_build`.
- **§4.2.** The backfill walks the weeks present in `keyword_weekly_metrics` (77 from 2025-04-19; listed by a recursive loose index scan on the parent table), two scratch tables rotated by rename each week under the advisory lock, a run token stamped as a COMMENT on the scratch table and checked before every write (`top_asins_run_conflict`; the newer run wins), empty mid-walk weeks skipped (streaks carry across them; an empty last week stops the run), and a final swap-in in one locked transaction that leaves `_prev` = the previous walked week. About 2–3 hours; readers can queue up to 120 s behind the final swap; a swap-in failure means a full re-run.
- **§5.1 / §5.3.** Sorts hide rows whose sort key is null (the explorer's rule for its price/review sorts), so each sort is index-served; the page shows "Products without a <label> are hidden under this sort." — including the default view (monthly sold), which therefore shows only badge-carrying products. The search pages first and counts keywords only for the page's rows (`sort=keywords` stays single-level and is slow on broad filters). The builder is `productSearchSql(filters)`; the count is capped at `PRODUCT_MAX_PAGE × PRODUCT_PAGE_SIZE`. The sold buckets reach 100,000.
- **§5.2.** Title links open the ASIN page in a new tab (like the explorer) and carry `from=<the current /products URL>` so "Back to products" restores the filters; the BSR-ratio chip shows both directions; offers read "FBA n / FBM n"; the Amazon column shows the availability label; the pager is driven by the total ("Page N of M", "of 200+" when capped). The list page lives in the route group `app/(app)/products/(list)/` so its skeleton never wraps the ASIN page. The client components import from the zod-free `lib/products/filterParams.ts` (the zod schema stays server-side; ≈63 KB gzip saved).
- **§6.** An ASIN present in `keyword_top_asins` but not in the catalog (the enqueue skips excluded categories; a failed enqueue leaves the same gap) renders "Not in the Keepa catalog (usually because its category is excluded from enrichment)" with the keywords table only (`ProductFacts.inCatalog = false`); an ASIN in neither table is a 404. The fallback title for a never-fetched ASIN comes from `keyword_current_summary.top_clicked_product_1_title_current` only when that slot-1 product IS the ASIN (the summary can lag the reverse table by hours). The back control accepts `from=/products…` ("Back to products") and `from=/explorer/keyword/<uuid>` ("Back to keyword"), uses `router.back()` only when the history can go back (`navigation.canGoBack` / `history.length`), never nests `from`. History charts render as a lazy recharts chunk (not in the route's first-load JS); never-fetched rows skip the snapshot read. `formatVolume` renders exact numbers ('4,879,000 / mo'; the page adds `~`).
- **§8.** The tool input is a dollar/star-based `productSearchInputSchema` (two-decimal dollars and one-decimal stars enforced by a refine, not `multipleOf`, which division-based JSON-Schema validators mis-evaluate) mapped onto `ProductFilters` by `toProductFilters`; no zod defaults, so re-parsing is idempotent; INT4/dollar caps keep the mapped filters inside `::int`. `productUrlFor` lives in `links.ts`. The search response carries `adminOnly: true` and no `dataWeek`.
- **§9.** The MCP server's init callback runs per request (mcp-handler 2.2.0), so the two tools ARE listed only for admin actors (an `AsyncLocalStorage` listing context set around the request); the service's `FORBIDDEN` stays as the backstop; Ask AI hides them for non-admins. The tool returns the newest 60 history points (`PRODUCT_TOOL_HISTORY_POINTS`) with `first`/`last`/`pointsTotal` over the loaded window (≤ 400), keywords capped at 100 with `keywordsTotal`; the guide gained a Products section generated from the schema's field descriptions (admins only; `GUIDE_VERSION` 3); Ask AI shows "Searching products" / "Loading product details" and may link product urls.
- **§12.** Run `tests/integration/topAsinsBuild.test.ts` right after the 0051 apply and BEFORE the backfill (it proves the INSERT and the auto-generated `_next` index/constraint names the swap relies on, with nothing persisted); re-run the apply script after the Keepa redeploy (the ratio catch-up); never run `tests/integration/ingestion-flow.test.ts` / `replace-week.test.ts` before the backfill (they import a real week and would build the live table from 2026-04-11). The worker log line has no duration: `[top-asins] week …: rows=… previous=… carried=…`.
