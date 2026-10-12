# Products: Brand Analytics broad category — design

**Date:** 2026-10-12 · **Status:** approved in brainstorming (owner, 2026-10-12) · **Follows:** `2026-10-12-products-category-filters-design.md` (arc 8, §11 follow-up "Brand Analytics broad category on products")

## 1. Goal

Give the admin-only Products page (`/products`), the ASIN page and the `search_products` / `get_product_details` tools the same broad categories the Explorer uses for keywords — the Brand Analytics code each weekly-report row files a clicked product under (`Home`, `Apparel`, `Biss`, `Toys`, `Pet Supplies`, …) — carried onto the weekly keyword-to-ASIN table by the build that already makes it. The Keepa department filter from arc 8 stays: the two are different lists and both remain available.

Owner's condition: no noticeable slowdown of the weekly refresh. Measured answer in §2.

## 2. Facts the design rests on (production, week ending 2026-10-03, measured 2026-10-12)

| Fact | Value |
|---|---|
| Weekly refresh, last three imports | 7–8 h in total: `kwm_insert` 3.2–3.4 h, `summary_refresh` 3.5–4.5 h, `copy_to_staging` ~3 min, `search_terms_upsert` ~8 min |
| The reverse-table build (`lib/topAsins/buildWeek.ts`) | one INSERT of the week's three slots with the streak carry, then a rename swap; 50–137 s per week in the backfill, fail-soft inside the import |
| `keyword_top_asins` today | 8,310,634 rows; heap 669 MB, pkey 320 MB, asin index 516 MB (1.5 GB total); `_prev` retained alongside |
| The code the report gives per clicked product (`top_clicked_category_{1,2,3}` on the kwm row) | slot 1: 2,775,289 ASIN rows, every one coded; slot 2: 2,771,791 rows, 2,058,433 coded (74 %); slot 3: 2,763,554 rows, 1,297,118 coded (47 %); codes average 9 characters, longest 32 |
| Distinct codes | 120 across the three slots; 102 on slot 1 (what the Explorer's `listCategories` shows — it reads the keyword's number-one product's code); 18 appear only on slot-2/3 products (`Ebook`, `Magazines`, `Household_Essentials`, `Designer_Fashion`, …) |
| Products per code | largest: `Home` 315,122 ASINs (669,650 rows), `Apparel` 267,350, `Biss` 195,613, `Toys` 185,763, `Sports` 148,717; smallest: single-ASIN codes (`Alexa`, `Digital_Periodicals`, …) |
| Per-ASIN consistency | of 1,908,290 coded top-3 ASINs, 634,603 (33 %) carry two or more codes across their keywords → the product filter is any-of |
| Coverage | 2,493,148 distinct top-3 ASINs this week; 1,068,193 are in-scope catalog products and 928,802 of those carry a code; products with no keyword row this week are reachable only through the Keepa department |

Cost of the carry: the code comes from the same kwm row the build already reads (no extra scan or join); the row grows by ~12 bytes (~100 MB over 8.3M rows); one partial index over the coded rows (~6.1M entries, ~250 MB) is maintained during the INSERT like the two existing ones. Expected: seconds more per build, doubled on disk because `_prev` is retained. Nothing else in the refresh changes.

## 3. Data: migration 0052

`db/migrations/0052_top_asins_broad_category.sql` (hand-numbered; applied by the UNTRACKED `scripts/applyMigration0052.ts` gated by `APPLY_0052=yes`; never drizzle-kit — the journal is frozen). Additive; safe before the code deploys (the old build INSERT lists its eight columns and leaves the ninth null).

```sql
ALTER TABLE keyword_top_asins ADD COLUMN IF NOT EXISTS broad_category varchar(255);
--> statement-breakpoint
COMMENT ON COLUMN keyword_top_asins.broad_category IS
  'Brand Analytics code the weekly report files this clicked product under for this keyword (top_clicked_category_<slot> on the kwm row; null when the report gave none). A product belongs to every code it carries across its keywords (any-of).';
--> statement-breakpoint
ALTER TABLE IF EXISTS keyword_top_asins_prev ADD COLUMN IF NOT EXISTS broad_category varchar(255);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS keyword_top_asins_broad_category_idx ON keyword_top_asins (broad_category, asin)
  WHERE broad_category IS NOT NULL;
```

The apply script runs the index statement as `CREATE INDEX CONCURRENTLY` outside the transaction (as 0051's six did) and asserts `indisvalid`; on the live table every row is still null, so the index is empty and the statement is a scan of the heap, seconds. The `_prev` ALTER keeps the two tables shaped alike (the backfill rebuilds `_prev` with `SELECT *`). Drizzle mirror: `db/schema/keywordTopAsins.ts` gains `broadCategory: varchar('broad_category', { length: 255 })` and the partial index; `keywordTopAsins.test.ts` pins the nine columns and the 0052 statements.

## 4. The build carries the code

`lib/topAsins/buildWeek.ts`:

- `slotSelect(partition, slot)` adds `top_clicked_category_${slot} AS broad_category` to its select list.
- `insertText` lists nine columns (`…, week_end_date, broad_category`) and selects `p.broad_category` in both the carry and the carry-from-nothing forms. The streak carry is untouched (it still reads four columns of the carry table).
- The swap renames the third index like the second: `promoteNext` adds `ALTER INDEX keyword_top_asins_next_broad_category_asin_idx RENAME TO keyword_top_asins_broad_category_idx` (the name `LIKE … INCLUDING ALL` generates for a `(broad_category, asin)` index on `_next`, by the same rule that names the asin copy `keyword_top_asins_next_asin_search_term_id_idx`); the advance adds `ALTER INDEX keyword_top_asins_broad_category_idx RENAME TO keyword_top_asins_prev_broad_category_idx` after the asin rename. The rewind plan needs nothing more (it drops `_prev` and the current table); the same-week plan adds one statement (next bullet).
- Both broad-index renames are `ALTER INDEX IF EXISTS`, and the same-week swap first renames a canonical name found on `_prev` to `_prev`'s name: an old-code build between the apply of 0052 and the deploy carries the index along unrenamed (index names are schema-wide), and a fixed-name rename would otherwise fail on every later build. The live table's name converges within two new-code builds (`_prev`'s may take a third after two old-code builds); nothing else depends on the names.
- `lib/topAsins/backfill.ts` shares `slotSelect`: its INSERT column list gains `broad_category`, its promotion renames the third index, and its `_prev` rebuild comment says nine columns. The scratch tables are `LIKE keyword_top_asins`, so they carry the column already.
- Header comments: "eight columns" → "nine"; the partial index joins the list of what the swap renames.

The import phase (`inngest/functions/importFile.ts`) is unchanged: same call, same fail-soft logging. ANALYZE after the swap covers the new column's statistics.

**One-off fill.** The current week's table was built before the column existed, so it is filled by one same-week rebuild: `TOP_ASINS_WEEK=<meta week> node --env-file=.env.local --import tsx scripts/buildTopAsinsWeek.ts` with the new code, run locally against production on the owner's go. It is the normal build: carry from `_prev` (exact streaks), 1–2 minutes, readers may queue up to 120 s at the swap; quiet hour, no import running. If a weekly import lands between the migration and the deploy, that week's rows carry no codes (old worker code) and the same command is run once more for that week after the deploy.

## 5. Filter semantics and SQL

A product matches a broad category when at least one of its pair rows this week carries that code (any-of). `lib/products/searchProducts.ts` adds, after the Keepa category predicate:

```sql
EXISTS (SELECT 1 FROM keyword_top_asins k WHERE k.asin = a.asin AND k.broad_category = $n::text)
```

Postgres treats it as a semi-join and picks, per code, a nested loop over the sort-key index with one probe of `keyword_top_asins_broad_category_idx` per candidate (large codes: `Home` finds 51 matches within the first few hundred best-sellers) or the code's ASIN set first (tiny codes), both through the partial index (`= $n` implies `IS NOT NULL`). Department, Keepa categories and the broad category combine with AND. The `keywords` sort and the result count are unaffected beyond the extra predicate. The file's header lists the new index with the others.

`ProductFilters` (`lib/products/filterParams.ts`) gains `broadCategory: string | null` (default null); `PRODUCT_MAX_BROAD_CATEGORY_LENGTH = 255` (the column's width); URL key `broad`, parsed like `dept` (trimmed, `usablePath`, bounded) and serialised when set. Every full-literal `ProductFilters` site gains the field (the arc-8 lesson): `toProductFilters` in `lib/research/contracts.ts`, `pendingToFilters` in the panel, the fixtures in `filters.test.ts` and `searchProducts.test.ts`, and any other found by `grep -rn "customCategoryIds: \[\]"`.

## 6. The list of codes

`lib/products/listCategories.ts` gains `listProductBroadCategories(): Promise<string[]>` next to `listProductDepartments`: `cache(unstable_cache(fetchBroadCategoriesSorted, ['product-broad-categories', BROAD_CATEGORY_LIST_SQL], { revalidate: 3600, tags: ['product-categories'] }))`. The statement text is an exported constant (`BROAD_CATEGORY_LIST_SQL`, so the integration test runs the identical text) and a key part of the cache, which is what makes an edit to it a new data-cache entry (Next keys on the callback's source plus the key parts; the callback references the constant). The read runs through `neonRunner`, so it is capped by the page's 30 s statement timeout like every other web read of the pair table (a reader holds a lock the weekly swap waits on). The list is the codes present on the table — what the filter can match — so it is 120 today where the Explorer's is 102. A loose index scan keeps it to ~120 index probes whatever the table size:

```sql
WITH RECURSIVE codes AS (
  (SELECT broad_category AS code FROM keyword_top_asins WHERE broad_category IS NOT NULL ORDER BY broad_category LIMIT 1)
  UNION ALL
  SELECT (SELECT k.broad_category FROM keyword_top_asins k WHERE k.broad_category > c.code ORDER BY k.broad_category LIMIT 1)
  FROM codes c WHERE c.code IS NOT NULL
)
SELECT code FROM codes WHERE code IS NOT NULL
```

Sorted in JS with `compareCodeUnits` like the departments. A failed read rejects (never caught inside the cached function); the page degrades it to `[]`, the tools reject.

## 7. Products page

- `app/(app)/products/(list)/page.tsx` reads the fourth list in parallel with the other three, `.catch(() => [])` like them, and passes `broadCategories` to the panel.
- `ProductFilterPanel.tsx`: a `Field label="Broad category" htmlFor="pf-broad"` directly under Department, a `<select>` with `All broad categories` first then the codes; pending state `broad: string` ('' = all); a pending value missing from the list is appended last so the select shows it (as `departmentOptions` does); `pendingToFilters` maps '' → null; `canonicalQuery` includes `broad` (order-insensitive dirty check as before); Reset clears it. Both selects may be set.
- The results table is unchanged.

## 8. ASIN page

`lib/products/loadProduct.ts`: `ProductFacts.broadCategories: string[]`, most keywords first, from `productBroadCategoriesSql(asin)` run with the facts read (the asin index serves it: a few rows per ASIN on average):

```sql
SELECT broad_category FROM keyword_top_asins
WHERE asin = $1 AND broad_category IS NOT NULL
GROUP BY broad_category ORDER BY count(*) DESC, broad_category
```

`FactsCard.tsx` renders a "Broad categories" line: the codes joined with ", " (`Home, Pet Supplies`), or the card's dash when the list is empty (no keyword rows this week, or none coded). The line sits in the full fact list, under Category; the "Not fetched yet" and "Not in the catalog" shapes are unchanged (the keywords section below them still lists the rows). A failed read fails the page as the facts read does; nothing is hidden behind a dash. The codes read runs in parallel with the facts read, so first paint costs no extra round trip; it does put every ASIN page on the pair table before first paint (before, only title-less rows and stubs were), so during the weekly swap's lock window (up to 120 s) a page can wait or hit its 30 s cap where it used to paint and only the keywords section failed soft — rare and admin-only. A non-empty code list proves the ASIN is on the pair table, so the stub path skips its tracked probe then.

## 9. Tools

- `lib/research/contracts.ts`: `search_products.filters.broadCategory` — `z.string().trim().min(1).max(255).optional()`, described as "One Brand Analytics code, spelled as a keyword row's broadCategory carries it ('Home', 'Apparel', 'Biss', 'Pet Supplies'): the weekly report filed the product under it on at least one keyword where it was a top-3 clicked product this week (the product's own code on that row, which can differ from the keyword's broadCategory; a product can carry several codes and any one matches). Independent of filters.department (the product's own Keepa storefront department); both may be set. An unknown code fails with CATEGORY_NOT_AVAILABLE and the valid codes." `toProductFilters` maps it to `broadCategory`. The `get_product_details` output's `product` gains `broadCategories: string[]` (most keywords first); search rows are unchanged.
- `lib/research/products.ts`: `ProductLoaders` gains `broadCategories: () => Promise<string[]>` (→ `listProductBroadCategories`); the validate step (before reserve) checks the code against the list: unknown → `ResearchError('CATEGORY_NOT_AVAILABLE', '"X" is not a broad category of this week's clicked products. Pass one of: a; b; …', { details: [{ path: 'filters.broadCategory', message: 'unknown broad category' }] })`; an empty list → message "No broad categories are available yet (the weekly keyword-to-product table is empty)." with the same details. `ProductFacts.broadCategories` flows into the details output through the shared loader.
- `lib/research/tools.ts`: the `search_products` description adds "broad category (the Brand Analytics code a keyword row's broadCategory carries, any of a product's codes)" to its filter list.
- `lib/research/catalog.ts`: `GUIDE_VERSION` 4 → 5; `PRODUCT_RULES` gains one line: "filters.broadCategory is a Brand Analytics code as search_keywords' broadCategory and a keyword row's broadCategory carry it ('Home', 'Apparel', 'Biss' …): the weekly report filed the product under that code on at least one keyword where it was a top-3 clicked product this week — the product's own code on that row, which can differ from the keyword's broadCategory (the number-one product's code), so a search_keywords cross-check may not find the keyword; a product can carry several codes and any one matches. filters.department is the product's own Keepa storefront department — a different list; both may be set. An unknown code fails with CATEGORY_NOT_AVAILABLE and the message lists the valid codes. get_product_details returns the product's codes as broadCategories, most keywords first." `PRODUCT_FILTER_DEFINITIONS` picks the field up from the schema. Ask AI inherits everything through `RESEARCH_TOOLS`. `search_keywords` is unchanged.

## 10. Error handling

- Build: unchanged fail-soft phase; a missing column (migration not applied) fails the INSERT with a coded error and the import continues on the old table.
- Page: a failed list read shows an empty Broad category select (as the other lists); a value not in the list stays selectable and matches nothing or something, as the table has it.
- Tools: unknown code → `CATEGORY_NOT_AVAILABLE` with the codes in the message; list read failure → the request fails (coded, log-safe), as for departments.
- Never log a DB error's message; `errFields` only.

## 11. Testing

Unit (vitest, no DB): filters parse/serialise (`broad`, trim, bound, round trip); `productSearchSql` predicate text and bind position, header names the index; `listProductBroadCategories` with the recording `next/cache` mock (key parts incl. the statement text, revalidate, tag, the callback naming the constant) and the rejection rule; page test (fourth list reaches the panel; a failed read → `[]`); panel (options, "All broad categories", missing value appended, URL round trip, dirty check, Reset); `loadProduct` SQL + mapping; `FactsCard` line and dash; `buildWeek` statements (select list, nine columns, the guard and the `IF EXISTS` renames per plan); `backfill` statements; schema mirror + 0052 text; contracts (field, description, `toProductFilters`), `products.ts` (valid code passes, unknown → error message lists the codes, empty list message, order refuse → validate → reserve), `service.test.ts` pins, `catalog.test.ts` (`GUIDE_VERSION` 5, the rule present), `tools.test.ts` description.

Integration (owner-gated, `RUN_INTEGRATION=1`, run with `--disableConsoleIntercept`): `topAsinsBuild.test.ts` — the scratch INSERT yields `broad_category` equal to the partition's `top_clicked_category_<slot>` for sampled rows, the naming-rule table proves `keyword_top_asins_next_broad_category_asin_idx`; `productsQueries.test.ts` — after the one-off fill: the largest code and a single-ASIN code under the default sort both plan on `keyword_top_asins_broad_category_idx` with cold timings printed; the list query under 1 s; the ASIN codes query for a sampled multi-code ASIN returns most-keywords-first. All read-only (the build test rolls back, as today).

## 12. Shipping (each step on the owner's go, in order)

1. `node --env-file=.env.local --import tsx scripts/checkActiveJobs.ts` (quiet), then `APPLY_0052=yes node --env-file=.env.local --import tsx scripts/applyMigration0052.ts` — expect the ALTERs, "index valid", seconds.
2. One-off fill with the new local code (§4): `TOP_ASINS_WEEK=<meta week> … scripts/buildTopAsinsWeek.ts` — expect `rows=8.3M previous=<meta week> carried=prev`, 1–2 min.
3. `RUN_INTEGRATION=1 pnpm vitest run tests/integration/topAsinsBuild.test.ts tests/integration/productsQueries.test.ts --disableConsoleIntercept` — plans name the partial index.
4. `checkActiveJobs`, then a bare `git push origin main` as its own call; watch the three deploys (`gh api … /status`; an empty commit if Vercel creates none).
5. If an import landed between steps 1 and 4 and its rows carry no codes, run step 2 for the meta week again.
6. Smoke, page: `Home`; `Home` + a department; a broad code + a leaf pick; an old link with a bogus code shows it in the select and zero rows; an ASIN page shows its codes. Tools: a `broadCategory` search; a typo returns the codes; `get_product_details` shows `broadCategories`.
7. Results table below + memory.

| Step | Date | Outcome | Notes |
|---|---|---|---|
| 0052 applied | | | |
| One-off fill | | | |
| Integration | | | |
| Push + deploys | | | |
| Page smoke | | | |
| Tools smoke | | | |
| First weekly build with codes | | | |

## 13. Out of scope / follow-ups

- Keyword counts per code on the ASIN page ("Home (12)") — the GROUP BY has them; display only if wanted.
- A broad-category column in the products table and on `search_products` rows (one aggregate per listed row).
- The Explorer's list stays at the slot-1 codes; it could show the 18 slot-2/3 codes but they are not keyword broad categories.
- The arc-8 §11 items (Explorer sidebar parity, typeahead placeholder prop, path-array cap, `compareCodeUnits` duplication, implied parent paths) remain open.
