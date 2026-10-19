# Products list polish: facets table, perf panel, columns, filters, tab memory — design

Status: approved in conversation 2026-10-19 (owner: facets table over lazy loading; FBA / Amazon as check / X to try first; no rating sort). Mini-arc after arcs 10 and 11; the owner's six-point feedback on the Products tab (2026-10-19) is the requirement list.

## 1. Goal

Make `/products` fast on every load and measurable on the page, and lay it out the way the owner reads it: the column order below, FBA / Amazon as icons at the end, the category filters in the Explorer's order, an Amazon magnifier per row, and a Products tab that returns to the last filtered list instead of wiping it.

## 2. Facts the design rests on (production, measured 2026-10-19)

Timed in the owner's signed-in Chrome (time to results = the document stream's end) and read-only against Neon:

| Load | Time to results | Document (uncompressed / wire) |
|---|---|---|
| `/products`, first load of the day | 2.3 s | 2.8 MB / 232 KB |
| `/products`, reload | 0.9 s | 2.8 MB / 232 KB |
| `/products?broad=Pet+Products` | 1.5 s | 2.8 MB / 231 KB |
| `/explorer`, reload (server perf line: 84 ms) | 0.55 s | 2.95 MB / 232 KB |

- Both pages inline their full leaf-category lists (Products 23,429 paths ≈ 2.0 MB raw; Explorer 20,843 ≈ 1.7 MB). The payload is the same class on both pages and is not what makes the Products page slow.
- The Products lists come from `lib/products/listCategories.ts`: a departments scan (`SELECT DISTINCT category_root …`, 1.3 s warm) and then 36 per-department `SELECT DISTINCT category_path …` bitmap scans over `asin_products` (1.4 GB table + 1.0 GB indexes, 1,176,481 rows behind the list). Clothing alone reads 780 MB in 1.5 s warm; the whole set takes several seconds warm and far longer on a cold Neon. The Explorer's list is a precomputed facets table read in milliseconds.
- Those scans are `unstable_cache`d for an hour. Next 16 serves a stale entry and revalidates it in the background (`node_modules/next/dist/server/web/spec-extension/unstable-cache.js`: "If the entry is stale we return it but revalidate the entry in the background"), so the scans block a visitor only when the entries are MISSING: after a deploy that changes that callback's source text (the cache key includes it; arc 10 did, right before the owner's smoke) or after eviction. That is the "very long" load.
- The search itself is cheap warm: the landing (sold desc) 30 ms; `broad=Pet Products` 5 ms (nested loop with a memoize over `ba_category_crosswalk_code_idx`). The known cold outlier (broad + keywords sort, arc 9 §13) is unchanged by this arc.
- `category_root` equals the path's first segment for all 1,176,481 rows (0 NULL, 0 mismatches), and a `GROUP BY category_path` over them takes 1.5 s warm (23,429 paths, 36 departments).
- The `?broad=Pet+Products` "default" the owner saw was Chrome's address bar completing the last visited URL; the tab links to bare `/products`.

## 3. Design in one paragraph

A small table, `product_category_facets` (one row per distinct catalog path with its department and product count), is rebuilt by every weekly import in one transaction right after the crosswalk phase, and by hand once after the migration; the three list readers become index reads of it, so the catalog is never scanned at request time and a cache miss costs milliseconds. The page gets the admin perf panel the other pages have. The results table gets the owner's column order, BSR and its 30-day comparison as two columns, Rating and Reviews as two columns, a magnifier that opens the listing on Amazon, and FBA / Amazon as a green check or red X at the end. The filter panel's category block takes the Explorer's order (broad, then department, then leaf categories), with the department narrowing the leaf typeahead. The Products tab remembers the last list URL exactly as the Explorer tab does.

## 4. Data: `product_category_facets` (migration 0055)

```sql
CREATE TABLE IF NOT EXISTS product_category_facets (
  category_path text PRIMARY KEY,          -- as asin_products.category_path
  department    text NOT NULL,             -- asin_products.category_root of those rows (= the path's first segment)
  product_count integer NOT NULL,          -- catalog rows at exactly this path
  built_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS product_category_facets_department_idx ON product_category_facets (department, category_path);
```

- Hand-numbered `db/migrations/0055_product_category_facets.sql` (header in the 0053 style; `--> statement-breakpoint` between the three statements: table, index, `COMMENT ON TABLE`), applied by the UNTRACKED `scripts/applyMigration0055.ts` gated by `APPLY_0055=yes`, on the owner's go, BEFORE the code deploys (the readers fail loudly without it, and show empty lists while it is empty). Never through drizzle-kit (the journal is frozen). Drizzle schema `db/schema/productCategoryFacets.ts`, exported from `db/schema/index.ts`, for the type pin only.
- Membership rule, the same as today's lists: `in_scope AND enrichment_status IN ('active', 'no_price') AND category_path IS NOT NULL AND category_root IS NOT NULL`. Weekly rebuild means a path first seen by the Keepa service mid-week joins the typeahead at the next import; the search predicate always runs on live `asin_products`, so any offered path matches correctly. `product_count` is stored because it is free and self-describing; nothing reads it yet (§14).

## 5. The builder: `lib/products/buildCategoryFacets.ts`

`buildProductCategoryFacets(client: Queryable): Promise<{ paths: number; departments: number; products: number }>`, the replace step of `lib/baCategory/buildCrosswalk.ts` reused in spirit:

```sql
BEGIN;
SET LOCAL statement_timeout = '600s';
LOCK TABLE product_category_facets IN SHARE ROW EXCLUSIVE MODE;   -- builders queue; readers never wait
DELETE FROM product_category_facets;                              -- DELETE, not TRUNCATE (readers keep the old rows until COMMIT)
INSERT INTO product_category_facets (category_path, department, product_count)
SELECT category_path, category_root, count(*)::int
FROM asin_products
WHERE in_scope AND enrichment_status IN ('active', 'no_price') AND category_path IS NOT NULL AND category_root IS NOT NULL
GROUP BY category_path, category_root;
COMMIT;
-- best effort, after the COMMIT, as the crosswalk does: VACUUM ANALYZE product_category_facets
```

- Grouping by both columns and keeping the primary key on `category_path` means a path that ever carried two roots fails the build loudly (duplicate key) instead of storing a wrong department; today no path does.
- Stats come from the INSERT's row count and one `SELECT count(DISTINCT department), sum(product_count)` after it, inside the transaction. The log line: `[category-facets] paths=… departments=… products=…`.
- Import phase `category_facets_build` in `inngest/functions/importFile.ts`, immediately after `ba_crosswalk_build`, under the same condition and in the same shape: its own one-connection pool, dropped-socket guards, errors caught and logged with `errFields` (`[category-facets] failed (import continues)`), `rows_affected` = paths (null on failure). `app/admin/ImportStatusChip.tsx` labels it "Category list". A failed build leaves the previous week's rows in place (the replace is one transaction).
- One-off / repair script `scripts/buildProductCategoryFacets.ts` (tracked, the `scripts/buildBaCrosswalk.ts` pattern): refuses without `DATABASE_URL`; `PRODUCT_FACETS_DRY_RUN=1` runs the SELECT only and prints the counts; the real run prints the stats. Idempotent.

## 6. Readers: `lib/products/listCategories.ts`

- `listProductDepartments`: `SELECT DISTINCT department FROM product_category_facets ORDER BY department`, re-sorted by code units, React-`cache`d per render and `unstable_cache`d an hour as today.
- `listProductCategoryPaths`: unchanged assembly (`assemblePathLists`) over `cachedPathsForDepartment(dept)`, which becomes `SELECT category_path FROM product_category_facets WHERE department = $1 ORDER BY category_path` through the department index. Per-department caching stays for the reason it exists: Next's data cache refuses entries over 2 MB and the whole list is about that size; the per-department entries stay well under it.
- `listProductBroadCategories`: unchanged.
- The header comment is rewritten: no catalog scan at request time; the lists refresh weekly with the facets build; an empty table gives empty lists (the page shows no category options and the tools reject category scopes with CATEGORY_NOT_AVAILABLE), which is why the first build precedes the deploy (§13). The cache keys change with the callbacks' text, so the deploy starts from fresh entries, now milliseconds each.
- Nothing else changes for the callers: `app/(app)/products/(list)/page.tsx` and `lib/research/products.ts` (the tools' scope validation) keep their imports and semantics.

## 7. Perf panel on `/products`

- `PerfPanel` (`app/(app)/PerfPanel.tsx`, admin-gated by `user.role === 'admin'` as the Watchlist does) renders above the count line in the results area.
- The page starts `startHandlerTimer()` before the admin gate, marks `auth` after it, and hands the timer to the results component. `loadProductsPage` times each of its five parallel reads individually with a new `timed(promise)` helper in `lib/perf/handlerTimer.ts` (`{ value, ms }`), marks one `loads` step = the wall time of the `Promise.all`, and puts the per-read times in that step's note: `parallel: search 310 · departments 25 · broad 20 · paths 180 (23,429 · 2.0 MB) · custom 30 ms`. The paths note carries the count and the raw byte size of the list (sum of lengths) so a payload regression shows on the page. `totalMs` is read while the results component builds its JSX, right after the `loads` mark, so the panel's remainder row is near zero here (as on the Watchlist): the render and serialization happen after it is taken. `loads` itself runs from the `auth` mark, so it also holds the parse and the hop into the Suspense content (a millisecond or two); the note's per-read times are the exact figures.
- The panel never throws: a failed read is already caught in `loadProductsPage`; its time still shows.

## 8. Results table: `app/(app)/products/ProductResultsTable.tsx`

Columns, left to right (sortable = an existing `SortHeader`; nothing new is sortable):

| # | Header | Cell | Sort |
|---|---|---|---|
| 1 | (visually empty; sr-only "Open on Amazon") | magnifier icon (lucide `Search`, the Explorer's classes) linking `https://www.amazon.com/dp/<ASIN>` in a new tab (`rel="noopener noreferrer nofollow"`, title "Open the listing on Amazon", aria-label "Open <ASIN> on Amazon"); empty when the value is not ASIN-shaped | — |
| 2 | Product | title link to the product page (unchanged); below it brand · ASIN, the ASIN now plain mono text (the magnifier is the row's Amazon link; two links to one target was clutter) | — |
| 3 | Leaf category | unchanged | — |
| 4 | Monthly sold | unchanged | sold |
| 5 | Rating | `★ 4.4` (yellow, as today's inline style) or a dash; right-aligned; title "Average star rating" | — |
| 6 | Reviews | the count only (`formatReviewCount`) | reviews |
| 7 | Listed | date + age, unchanged | listed |
| 8 | BSR | the rank or a dash | bsr |
| 9 | vs 30d avg | the existing green / red chip, `0%`, or a dash, in its own cell; title "BSR vs its 30-day average" | ratio |
| 10 | Price | unchanged | price |
| 11 | Keywords | unchanged | keywords |
| 12 | FBA | green check when `fbaOfferCount > 0`; red X when it is 0; dash when null. Cell title = today's `offers()` text ("FBA 3 / FBM 1"); header title "New offers fulfilled by Amazon; hover for the FBA / FBM counts" | — |
| 13 | Amazon | green check when `amazonAvailability >= 0` (Amazon has an offer: in stock, pre-order, availability unknown, back-order, delayed); red X when −1 (no Amazon offer); dash when null. Cell title = `availabilityLabel(code)`; header title "Amazon's own offer on the listing" | — |

- Icons: lucide `Check` / `X`, `h-4 w-4`, centered, `text-emerald-600` / `text-rose-600`, `aria-hidden`, with sr-only "Yes" / "No" text so the cells read in assistive tech and in tests. The old combined BSR header (two sort links in one `th`) and the `ReviewsCell` go away; `BsrCell` becomes the rank cell and the chip moves to column 9.
- Everything else (count line, sort hint, empty state, "Go to page 1", pending overlay, `from` for the ASIN page) is unchanged.

## 9. Filter panel: `app/(app)/products/ProductFilterPanel.tsx`

- The category block, in the Explorer's order and with the source named like the Explorer's labels: **Broad category (Brand Analytics)** → **Department (Keepa)** → **Leaf categories (Keepa)** with the Leaf | Custom toggle. Its position in the panel (after "BSR vs 30-day avg", before "FBA offer") is unchanged; the URL parameters and their semantics are unchanged.
- Hints: Broad: "Amazon's Brand Analytics category, as on the Explorer; one per product, mapped from its Keepa category." Department: "Narrows the leaf search below; also filters on its own." Leaf (Leaf side): "{n} categories in {department} — type to search, click or Enter to add. Each pick includes its sub-categories; several match with OR." without the "in {department}" when no department is chosen.
- Department narrows the typeahead's options to that department's paths (the department itself and everything under it, `useMemo` over the list); it does not touch existing picks (a pick outside the chosen department simply matches nothing, as today). The Custom side is unchanged.
- The Explorer's own labels are not touched (§14).

## 10. Tab memory: `app/(app)/TabNav.tsx`

- The Explorer tab's mechanism (localStorage key, `useSyncExternalStore` read, effect write, null server snapshot) is lifted into one helper used by both tabs, e.g. `useRememberedListUrl({ key, base, onListPage, currentUrl })`, and the Products tab uses it with key `kw-analytics.last-products-url`, base `/products`, `onListPage = pathname === '/products'` (never `/products/[asin]`, as the Explorer never remembers a keyword page). The tab's href: the current URL on the list page, else the remembered URL, else bare `/products`; the server render and the hydrating client render show bare `/products`.
- The ASIN page's "Back to products" (`from`) is unchanged and already returns to the exact list.

## 11. Error handling

- Facets build: one transaction; a failure (timeout, duplicate key, lost socket) is logged with coded fields and the import continues with the previous rows in place; the one-off script re-runs it.
- Empty facets table: empty lists (page: no category options; tools: CATEGORY_NOT_AVAILABLE). Prevented by the ship order; fixed by the one-off script.
- Reader failure: as today (the page shows empty lists; nothing empty is cached; the tools reject).
- `localStorage` unavailable or throwing: the Products tab links bare `/products`.
- Null Keepa fields: dashes, never a check or an X.

## 12. Testing

- `lib/products/listCategories.test.ts`: the readers' statements name `product_category_facets` (text pins), the per-department entries and the assembly order are unchanged, the departments list is re-sorted by code units.
- `lib/products/buildCategoryFacets.test.ts`: with a fake client, the statement order (BEGIN, SET LOCAL, LOCK, DELETE, INSERT, stats, COMMIT; ROLLBACK on a thrown statement), the INSERT's text (membership rule, `GROUP BY category_path, category_root`), the returned stats.
- `inngest/functions/importFile.test.ts`: phase order `keepa_enqueue, top_asins_build, ba_crosswalk_build, category_facets_build, summary_refresh`; a failed build logs and the import continues; `rows_affected` = paths. `app/admin/ImportStatusChip.test.tsx`: the label.
- `app/(app)/products/ProductResultsTable.test.tsx`: the header order; BSR and vs-30d as separate cells with a dash in the vs-30d cell when the ratio is null; Rating and Reviews split; the check / X / dash rules for FBA (null, 0, >0) and Amazon (null, −1, 0, 4); the magnifier's href and its absence for a non-ASIN value; the ASIN rendered as text, not a link.
- `app/(app)/products/ProductFilterPanel.test.tsx`: the labels and order; the typeahead's options narrow with the department and widen back; picks survive a department change; the hint's count follows the narrowed list.
- `app/(app)/TabNav.test.tsx`: the Products tab records the list URL on `/products?…`, restores it from `/explorer` and from `/products/B0…`, does not record `/products/B0…`, server-renders bare `/products`, and the Explorer cases still pass against the shared helper.
- `app/(app)/products/(list)/page.test.tsx`: the panel receives the perf data and renders for an admin only; the loaders are still called in parallel.
- Suite green, `pnpm typecheck`, `pnpm exec eslint` on touched files, `pnpm build`.
- Vitest never type-checks: the facets row type and `timed()`'s result type get type-only pins.

## 13. Shipping (each step on the owner's go, in order)

1. Code complete on local `main`, per-task spec + quality reviews, final whole-diff review.
2. `APPLY_0055=yes node --env-file=.env.local --import tsx scripts/applyMigration0055.ts` (instant: new empty table + index).
3. `node --env-file=.env.local --import tsx scripts/buildProductCategoryFacets.ts` — expect about 23.4k paths, 36 departments, about 1.18M products, a few seconds; cross-check the counts read-only.
4. `scripts/checkActiveJobs.ts` → bare `git push origin main` → Vercel + Railway worker (+ Keepa service) green.
5. Smoke in the owner's Chrome: `/products` renders the perf line with a small `loads` step; the typeahead has options and narrows with the department; the column order, the two BSR columns, Rating / Reviews, the checks and Xs, the magnifier; filter → Explorer tab → Products tab returns to the filtered URL.
6. The 2026-10-20 import: `category_facets_build` appears in the timings after `ba_crosswalk_build` with rows ≈ 23k. (The admin chip maps the phase to "Category list", but the chip cannot show any post-import hook phase: its active list drops a file at mark_imported — a pre-existing gap, §14.)

Rollback: reverting the code needs no DDL; the table can stay.

## 14. Out of scope / follow-ups

- Opening the Products page and tools to all accounts (the owner's prerequisite for the comments campaign) — a separate, deliberate step.
- A rating sort (needs an index; skipped on purpose: a rating sort reads like a reviews sort).
- Dropping the FBA / Amazon columns if the owner dislikes the icons after seeing them.
- Showing `product_count` in the typeahead ("(1,234)"); a typeahead placeholder prop (arc 8 follow-up); unifying the Explorer's category labels with these.
- A keep-warm tick for the search if the perf panel ever shows cold-search pain; the arc 9 §13 broad + keywords cold sort.
- The product pages themselves: the owner's next feedback round.
- The admin import-status chip never shows the hook phases that run after mark_imported (keepa_enqueue, top_asins_build, ba_crosswalk_build, category_facets_build, summary_refresh): the route's active list requires import_started_at, which mark_imported nulls. Fix in the route (a fresh heartbeat + a non-terminal phase), separately.
- `inngest/functions/importFile.ts` now carries four near-identical pooled hook phases (~220 lines): extract one helper (pool options, socket guards, stage tracking, errFields logging, pool.end() swallowed) and a `connectChain` test helper, as a behaviour-free commit between arcs; the first `processFileImport` describe should also hand out hook clients so it stops printing four stray TypeError lines.
- The typeahead's hard-coded placeholder ("Type to search 11k+ categories…") now sits under a hint that says "N categories in <department>": the arc-8 placeholder-prop follow-up is more visible now.
- A leaf pick outside the chosen department stays as a chip and matches nothing, with no note saying so; a Leaf-side line like the Custom side's missing-category note would tell the user (owner's call).
- Under the "Amazon selling: No" filter (predicate `IS NULL OR = -1`, spec 2026-10-09), products never re-fetched since the legacy seed show a dash among the red Xs; decide whether `amazon=no` should mean `= -1` only.
- The magnifier icon's `text-gray-400` (the Explorer's class too) is about 2.6:1 on white, under the 3:1 guideline for an icon-only link; raise both to gray-500 together if wanted.
- The facets builder has no floor guard: a build that wrote zero rows would commit an empty list until the next build (the hand-run script exits 2 on it; the import phase logs success). Add a floor if it ever matters.
