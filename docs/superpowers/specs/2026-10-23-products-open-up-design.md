# Products open-up — design

**Date:** 2026-10-23 · **Owner's decision:** open the Products tab, both product pages, the product links on keyword pages and the two MCP product tools to every signed-in account, AI connectors included, in one deploy. The owner's example of what a member should be able to ask an AI client: "Show me products in the supplements niche which sell over 1,000 units per day and were listed within the last 60 days."

## 1. Goal

A member (any signed-in account) sees the Products tab, opens the list and any product page, reaches product pages from keyword pages, and their AI connector can call `search_products` and `get_product_details`. Usage of all of that shows up in the daily usage digest. No combination of filters and sorts on the list page exceeds the 30-second read cap on a cold cache. The help page explains the tab.

## 2. Access (five gates become "signed in")

| Where | Today | After |
|---|---|---|
| `app/(app)/layout.tsx` → `TabNav showProducts` | `user.role === 'admin'` | `true` (every signed-in user; the layout already requires one) |
| `app/(app)/products/(list)/page.tsx` | `requireAdmin()` → redirect | the signed-in user from `getCurrentUser()`; null → redirect to `/sign-in`; the admin-only `PerfPanel` keeps its `admin={user.role === 'admin'}` |
| `app/(app)/products/[asin]/page.tsx` | `requireAdmin()` | the same signed-in check; everything else unchanged |
| `app/(app)/explorer/keyword/[id]/page.tsx` → `TopProductsSection linkProducts` | `user?.role === 'admin'` | `user !== null` (the page already has the user) |
| Comments saying "admin-only" in the files above, `BackToProducts`, `TopProductsSection`, `FactsCard`, `lib/research/products.ts` docs | admin-only wording | reworded to "signed-in accounts" |

`TabNav`'s `showProducts` prop stays (tests pass `true`/`false`); the layout just passes `true`. Admin pages, the Ask AI eligibility and the Connect AI eligibility are untouched.

## 3. The AI tools

- `lib/research/tools.ts`: `adminOnly: true` comes off the two product definitions; `isOfferedTo` and the `adminOnly` mechanism stay for any future tool.
- `lib/research/products.ts`: `assertAdmin` and `productsForbiddenError` go (every actor may call the tools; the per-account rate limits already cover them).
- `lib/research/service.ts`: the guide gets `products: true` for every actor.
- `lib/research/catalog.ts`: `PRODUCT_RULES[0]` ("admin accounts only for now…") is replaced by two rules, and `GUIDE_VERSION` 7 → 8:
  - "A niche or category in a product question means: resolve the words with resolve_categories first and pass the returned selection in filters.categories (the supplements niche → the Vitamins, Minerals & Supplements selection), optionally narrowed with department or broadCategory."
  - "Sales asked per day or per week map onto monthlySoldMin: multiply by 30 or by 4 (1,000 a day → monthlySoldMin 30000). monthlySold is Amazon's 'bought in past month' floor, so read the result as 'at least'. Listed within N days → listedWithinDays (60, 90, 180 or 365; pick the smallest that covers the ask and say so)."
- `lib/research/tools.ts` tool descriptions: the products tools' descriptions drop "(admin only)" wording if present.
- Ask AI (`lib/ask/tools.ts`) offers the tools through the same `isOfferedTo`, so it follows automatically; Ask AI itself stays admin-only.
- The example question joins the shared example list (`lib/ask/examples.ts` `MORE_EXAMPLES`, shown on the Connect AI page and in Ask AI): "Show me products in the supplements niche that sell over 1,000 units a day and were listed within the last 60 days".
- Tests: `catalog.test.ts` (GUIDE_VERSION 8, the products section present for a non-admin guide), `service.test.ts` / `products.test.ts` (a member's product search is served, the FORBIDDEN path is gone), `registerDefinitions.test.ts` and `lib/ask/tools.test.ts` (the two tools offered to a member), `contracts.test.ts` if it pins descriptions.

## 4. Usage counters

- `lib/activity/bump.ts` `UserActivityMetric` gains `'products_query'` (one per list-page render that runs a search) and `'product_view'` (one per product-page render). The storage column is a varchar, so no migration.
- The list page bumps `products_query` where the Keywords tab bumps `explorer_query`; the product page bumps `product_view` where the keyword page bumps `detail_view` (fire-and-forget, after auth, before the reads).
- The MCP and Ask AI tool calls are already counted under `mcp_request` / `ask_tool_call` (+ rows); no second counter.
- Daily usage digest (`lib/notifications/abuseDigest/*`): `USER_METRICS`, `PerUserActivity` and `assemblePerUserActivity` gain `productsQueries` and `productViews`; the reads rank and `totalReads` include them; `evaluateFlags` adds them to the per-user reads threshold (same amber 500 / red 2000); the email's text and table gain two columns ("Products", "Product views") after "Detail views"; plus the "Slow product searches" section and flag of §5b. Tests follow.

## 5. Performance: the keywords sort

Today `sort=keywords` counts a product's keywords with a lateral subquery per candidate row; under a wide filter (broad category Home, 315k products) that is 315k index probes before the sort, past the 30 s cap cold (5.4 s warm). Documented in spec 2026-10-12 §13.

**Decision: store the count.** `asin_products.keyword_count integer NOT NULL DEFAULT 0` + index `asin_products_keyword_count_idx (keyword_count, asin)` (migration 0056, applied by hand like 0051–0055), written weekly by a new phase `keyword_counts_build` right after `top_asins_build` inside the import (`UPDATE asin_products a SET keyword_count = c.n FROM (SELECT asin, count(*)::int AS n FROM keyword_top_asins GROUP BY asin) c WHERE a.asin = c.asin AND a.keyword_count IS DISTINCT FROM c.n`, then `UPDATE … SET keyword_count = 0 WHERE keyword_count <> 0 AND NOT EXISTS (… keyword_top_asins k WHERE k.asin = a.asin)`), plus a one-off backfill script for this week. The keywords sort then reads `ORDER BY a.keyword_count DESC, a.asin` off the index exactly like the other sorts (the `keyColumn` path), and the list's Keywords column reads the stored value instead of a lateral count on every page. Why this over "aggregate first, then join" (the §13 idea): the stored column makes every combination an index walk, removes the per-page lateral work, and matches how the other five sorts already behave; the aggregate form still scans the 9.4M-row pair table per request.

- Semantics unchanged: the count is the current week's keywords the product is a top-3 clicked product for; keyword_top_asins changes only at imports, so a weekly write is exact. The research tool's `keywordCount` and the list column read the column.
- Timing: `keyword_counts_build` on 2.5M catalog rows is measured on the first run (expected a minute or two; the rows that changed are the only writes). The phase appears in the import timings and the admin chip like `category_facets_build`.
- The page's safety net stays: `PRODUCT_READ_TIMEOUT_MS` 30 s. New: the list page catches SQLSTATE 57014 from the rows read and renders an inline notice in place of the table, "This combination took too long to load. Narrow the filters or try again.", instead of the error page; every other error still throws.

### 5b. The slow-search log (owner's ask 2026-10-23: know what runs long, fix it)

- New table `slow_queries` (migration 0056, with the column above): `id bigserial PK`, `surface text NOT NULL` (`'products'` now; the Keywords tab can join later), `happened_at timestamptz NOT NULL DEFAULT now()`, `user_id uuid NULL` (the account; null if unknown), `query_string text NOT NULL` (the filter combination exactly as the URL carries it: sort, direction, scope, every filter), `elapsed_ms integer NOT NULL`, `timed_out boolean NOT NULL`; index `(surface, happened_at)`.
- The list page records a row when its rows read times out (57014; `elapsed_ms` = the measured time, `timed_out = true`) or completes slower than `SLOW_PRODUCT_SEARCH_MS` = 8,000 (`timed_out = false`). Fire-and-forget after the response is decided, log-safe (a failed insert is a one-line warn, never an error for the person); the person's page is unchanged by the recording.
- The daily usage digest (§4) gains a section "Slow product searches" for the digest's day: timeouts and slow runs counted separately, then the top ten query strings by occurrences with their occurrence and distinct-account counts (the query string is shown verbatim: it holds filters, never personal data). One or more timeouts raise an amber flag ("product search timeouts: N"), so it shows in the digest's flag list; slow runs alone do not flag. The admin usage page shows the same section.
- Reproduction loop: paste a recorded query string into the integration harness's product search (it parses the same `parseProductFilters`), run it cold with EXPLAIN ANALYZE, fix with an index or a guard.
- Retention: rows older than 90 days are deleted by the digest job after it reads (one statement); the table stays small.
- No immediate email (owner's decision): the digest is the channel.
- Integration (`tests/integration/productsQueries.test.ts`, owner's go): `broad=Home&sort=keywords` cold rows + count under the cap, and the plan uses `asin_products_keyword_count_idx`; the stored counts agree with a fresh GROUP BY on a sample.

## 6. Help and copy

- `app/(marketing)/help/page.tsx`: a section "The Products tab" after "The competition lens": what the list shows (Keepa catalog of the top-3 clicked products: listing age, monthly sold floor, rating and reviews, BSR and its 30-day trend, price, FBA and Amazon presence, keyword count), the filters, the product page (facts, history charts that fill in week by week, the keywords it ranks for), and that the catalog refreshes continuously with each product re-fetched about weekly.
- `app/(marketing)/pricing/page.tsx` `INCLUDED`: "The Products tab — the catalog behind the top-clicked products" after the Keywords bullet.
- `docs/marketing/keywordquarry-product-profile.md`: the "Products" and "Ask AI" presentation lines say Products is open to all members (Ask AI stays admin-only).

## 7. Riders

- `app/(app)/products/ProductResultsTable.tsx`: the BSR cell reads "#1,234" like the facts card and the keyword table.
- One exported constant `BOUGHT_IN_PAST_MONTH` = `Amazon’s “bought in past month” badge` in `lib/products/format.ts`, used by the list header title, the filter panel hint (plus its period), the facts card note and the keyword table header.

## 8. Out of scope

The keyword page's remaining ISO dates; a products CSV export; plan or payment gating (Products is free with the account); opening Ask AI; any change to what the Keepa service fetches.

## 9. Tests and ship

Unit tests per task as listed; the full gate; migration 0056 (the column, its index, `slow_queries`) and the keyword-count backfill on the owner's go (before the push, as 0055 was); integration run on the owner's go; push on the owner's go; Vercel + worker deploys (Inngest re-sync); smoke as a member (the owner's standard account) on the tab, the list (Home + keywords sort cold), a product page, a keyword page's product link, and the connector asking the owner's example question; the next morning's digest shows the two new columns and the slow-search section; the next import's timings show `keyword_counts_build`.
