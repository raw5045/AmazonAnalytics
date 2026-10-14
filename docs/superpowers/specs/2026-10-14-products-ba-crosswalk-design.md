# Products: one Brand Analytics category per product, by a Keepa-path crosswalk — design

Date: 2026-10-14. Supersedes the product side of `2026-10-12-products-broad-category-design.md` (arc 9). The Explorer's keyword-side broad category (Top Clicked Category #1) is unchanged.

## 1. Goal

Every product the Products page can return carries exactly one Brand Analytics category, the same taxonomy the Explorer filters keywords by, so the owner can filter products and keywords by the same broad categories. The category is the product's own, not a trace of the searches it ranked for.

Owner's decisions (2026-10-14): one category per product; every product must have one; take it from what Keepa knows about the product (its category path), mapped onto the Brand Analytics codes.

## 2. Facts the design rests on (production, week ending 2026-10-10, measured 2026-10-14)

| Fact | Value |
|---|---|
| What the weekly report carries per search term | three separate ranked lists: Top Clicked Brand #1–#3, Top Clicked Category #1–#3, Top Clicked Product #1–#3 (ASIN, title, click share, conversion share). No category is attached to a product; category #N is the N-th largest share of clicks across every product clicked for the term |
| Arc 9's pairing (category #N onto product #N) | wrong for products #2/#3: of the 126,132 ASINs that are product #2 on five or more keywords, 72 % carry two or more different category-#2 values and 53 % are blank on some keywords and coded on others; under the Pet Products filter only 5 of the top 50 by monthly sold were pet products |
| Where the report's signal is reliable | an ASIN that is product #1 holds category #1 as its own in nearly every case: of 29,932 ASINs holding a majority of clicks as product #1 on three or more keywords, 9 carry two different codes; the medicube stick is product #1 on 267 keywords, category #1 Beauty on all 267 |
| Training set | 614,676 fetched products with a product-#1 vote (the mode of category #1 over the keywords where the product is #1), across 20,176 Keepa paths and 33 departments |
| A Keepa path predicts the code | the path's majority code equals the product's own vote for 88.6 % of training products (88.8 % inside paths with 20+ products; 87 % of training products sit in such paths); the department alone predicts 68.5 %. Part of the 11 % is the vote's own noise, so the true agreement is higher |
| Examples | Pet Supplies → Pet Products for 97 % of its products; `Health & Household › Household Supplies › Tissues, Toilet Paper & Sprays › Toilet Paper` → Health & Personal Care for 70 of 78 (8 are bulk packs the report files under Biss); Home & Kitchen splits by path into Home / Kitchen / Furniture, Clothing into Apparel / Shoes / Jewelry, Electronics into PC / Electronics / Camera / Wireless |
| Catalog paths | 23,968 distinct `asin_products.category_path` values; depth 1–10, 4.5 on average |
| Direct coverage | 5,194 paths have 20+ training products; they hold 928,514 of the 1,076,381 fetched products with a path (86 %; a snapshot a few minutes after the row below, the service was fetching); the rest need the parent-path backoff |
| Searchable universe | 1,074,610 in-scope active/no-price products have a path; 8,521 (0.8 %) do not (Keepa gave no category) |
| Size of the result | paths per code at most a few hundred directly (Home 573, Apparel 541, Health & Personal Care 339); products per code under the leaf majority: Apparel 186,593, Home 99,118, Beauty 82,240, Toys 63,702 |
| Cost of the signal | the per-product vote over one week's slot-1 rows joined to the catalog: 31–40 s on production when read from the pair table's slot-1 rows (the 2026-10-14 diagnostics); the builder reads the kwm partition instead (~3.2M wide rows), unmeasured until the first build (§13 step 2 records it); the distinct catalog paths: 2.4 s |
| Where the weekly build runs | `inngest/functions/importFile.ts`, phase `top_asins_build` right after `keepa_enqueue`, inside `if (!isReplay)`, fail-soft, own `pg.Pool` (max 1) with a 30-minute statement timeout (spec 2026-10-09 §4.1) |

## 3. Design in one paragraph

A small table, the crosswalk, maps every Keepa path in the catalog to one Brand Analytics code: the majority code of the training products in that path, backing off to the parent path, then its parent, up to the department, when the path has fewer than 20 training products. It is relearned at each weekly import from that week's report, right after the pair table, and applied at read time: a product's broad category is the code of its path. Amazon's own classification decides the mapping; every fetched product has exactly one code the moment Keepa gives it a path; products in the same path always share a code. Arc 9's column on the pair table is retired.

## 4. Data

### 4.1 Migration 0053: the crosswalk table (applied BEFORE the deploy)

```sql
CREATE TABLE IF NOT EXISTS ba_category_crosswalk (
  category_path text PRIMARY KEY,                       -- a Keepa path exactly as asin_products.category_path stores it
  code          varchar(255) NOT NULL,                   -- the Brand Analytics code (Top Clicked Category spelling)
  source_path   text NOT NULL,                           -- the path whose vote decided it: the path itself, or the ancestor it backed off to
  votes         integer NOT NULL,                        -- training products at source_path, all codes
  share_pct     smallint NOT NULL,                       -- the winning code's share of those votes, 0–100
  week_end_date date NOT NULL,                           -- the report week that trained it
  built_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ba_category_crosswalk_code_idx ON ba_category_crosswalk (code, category_path);
COMMENT ON TABLE ba_category_crosswalk IS 'Keepa category path → Brand Analytics code, one row per path in the catalog; relearned at each weekly import (lib/baCategory/buildCrosswalk.ts). A product''s broad category is the code of its path.';
```

The index serves the search predicate's subquery (an index-only scan of one code's paths) and the code list. The table is ~24k rows; nothing about it is hot.

Mirror: `db/schema/baCategoryCrosswalk.ts` (+ a `getTableConfig` pin test). The drizzle journal stays frozen: hand-numbered, applied by an untracked `scripts/applyMigration0053.ts` gated by `APPLY_0053=yes`, idempotent, coded output only.

### 4.2 Migration 0054: retire arc 9's column (applied AFTER the deploy is green)

```sql
ALTER TABLE keyword_top_asins DROP COLUMN IF EXISTS broad_category;            -- drops keyword_top_asins_broad_category_idx with it
ALTER TABLE IF EXISTS keyword_top_asins_prev DROP COLUMN IF EXISTS broad_category;
```

Metadata-only, instant; it takes a brief exclusive lock (readers queue for milliseconds). `DROP COLUMN` removes the partial indexes whatever name they carry. Hard rule: never before the deploy, because the live readers until then select the column (42703 would take the page down).

### 4.3 Why two migrations

The new readers need the crosswalk table before they deploy (a missing table fails the search loudly, 42P01), while the old readers need the pair-table column until they are replaced. So 0053 goes first, the deploy second, 0054 last.

## 5. The builder: `lib/baCategory/buildCrosswalk.ts`

Two functions, so the computation is testable without writing:

- `computeCrosswalk(client, week)` → `{ rows, stats }`, read-only: both reads run in one `REPEATABLE READ READ ONLY` transaction with `SET LOCAL statement_timeout = '1800s'` and `work_mem = '256MB'` (one snapshot: every voting path is among the catalog paths, so a week with votes always yields rows).
- `writeCrosswalk(client, rows, week)` → one transaction: `SET LOCAL statement_timeout = '1800s'`, `SET LOCAL lock_timeout = '120s'`, `LOCK TABLE ba_category_crosswalk IN SHARE ROW EXCLUSIVE MODE` (builders serialize; readers are never blocked), the older-week guard under that lock (`max(week_end_date) > $1::date` → `ba_crosswalk_older_than_built`; a re-run of the same week is allowed), `DELETE FROM ba_category_crosswalk`, then the INSERTs chunked by `WRITE_CHUNK` (10,000 rows) via `unnest($1::text[], $2::text[], $3::text[], $4::int[], $5::smallint[])` with the week. Readers keep the previous rows until the commit and never wait. Idempotent for the same week.
- `buildCrosswalk(client, week)` = compute, write, then a best-effort `VACUUM (ANALYZE, TRUNCATE false) ba_category_crosswalk` after the commit (reclaims the replaced rows, refreshes the statistics and the visibility map; `TRUNCATE false` because a plain VACUUM may take a brief page-trim lock, and readers must never wait); returns the stats. `client` is one dedicated connection, never a Pool: both steps open a transaction and set their limits with `SET LOCAL`, because a pool-level `statement_timeout` does not bind through Neon's pooler (the arc-9 lesson; the sibling builders do the same).

### 5.1 The training signal (SQL, read-only)

```sql
-- one vote per product: the mode of category #1 over the keywords where the product is product #1
SELECT a.category_path, v.code, count(*)::int AS products
FROM (
  SELECT m.top_clicked_product_1_asin AS asin,
         mode() WITHIN GROUP (ORDER BY m.top_clicked_category_1) AS code
  FROM keyword_weekly_metrics_<year> m            -- the week's yearly partition, as lib/topAsins/buildWeek.ts picks it
  WHERE m.week_end_date = $1::date
    AND m.top_clicked_product_1_asin ~ '^[A-Z0-9]{10}$'
    AND m.top_clicked_category_1 IS NOT NULL
  GROUP BY 1
) v
JOIN asin_products a ON a.asin = v.asin
WHERE a.category_path IS NOT NULL
GROUP BY 1, 2;
-- the paths to map
SELECT DISTINCT category_path FROM asin_products WHERE category_path IS NOT NULL;
```

One vote per product (not per keyword row) so a product with 500 keywords does not outvote a path; `mode()` breaks ties deterministically (the smallest value). The first statement returns ~45k (path, code) rows (31–40 s measured on the pair-table form; the kwm form is timed at the first build); both run inside the read transaction's 30-minute `SET LOCAL statement_timeout` (the pool-level option does not bind through the pooler). The mode's tie-break orders `COLLATE "C"`, the code-unit order `assignCodes` uses.

### 5.2 Assignment (TypeScript, pure, unit-tested)

`assignCodes(votes: Array<{ path, code, products }>, catalogPaths: string[]): Array<CrosswalkRow>`:

1. Prefix totals: for every vote row, add `products` to the code's count at the path itself and at each of its ancestors (`PATH_SEP` from `lib/categoryBuilder/buildTree` splits the levels: `Health & Household`, `Health & Household › Household Supplies`, …).
2. For each catalog path, walk from the path itself up to its department (level 1). The first prefix with total votes ≥ `MIN_VOTES` (20) decides: `code` = the code with the most votes there, ties broken by code text ascending; `source_path` = that prefix; `votes` = its total; `share_pct` = round(100 × winner / total).
3. If no prefix reaches 20 (a department with fewer than 20 training products), the department's majority still decides when it has at least one vote.
4. A path whose department has no vote at all gets no row: the product shows no category. Expected to be rare (the 33 departments in the training set cover every department with sellable products; measured in the integration test).

> **Amendment (2026-10-14, the review of Task 2).** A path's own products decide first: when the votes at the exact path reach `MIN_VOTES`, they decide it (`source_path` = the path; `votes` and `share_pct` from those products alone). Only otherwise does the walk start, over subtree totals (the path with its descendants, then each ancestor's subtree), as steps 2–3 say. An interior path with enough products of its own is therefore never outvoted by its descendants, and a thin interior path is decided by its subtree at itself. On a row, `votes` counts the path's own products when they decided it, else the whole subtree at `source_path`; `direct` in the stats means "decided at the path itself" either way. The `minVotes` parameter is gone (not configurable).

**Mixed paths.** Some paths hold products the report files under two codes: `Movies & TV › Movies` is Digital_Video_Download 50 % / Video DVD 44 % (streaming versus disc), `Toys & Games › Dress Up & Pretend Play › Costumes` is Toys 58 % / Apparel 42 %, party packs are Kitchen 51 % / Toys 41 %, cosmetic bags Beauty 44 % / Luggage 36 %. Measured over the 5,196 paths with 20+ votes: 66 % of training products sit in paths with a 90 %+ majority, 21 % in 70–89 %, 10 % in 50–69 %, 3 % in paths with no majority (188 paths, 13,654 products). The rule is the same everywhere: the majority code wins and the minority products take it; `share_pct` records how mixed the path was, so the mixed paths can be listed (`WHERE share_pct < 70`) and judged on real data. A per-product override for products that carry their own report signal is a follow-up (§14), not part of this arc.

`MIN_VOTES = 20`: with 20 votes an 85 % majority is a 17–3 split; lower and single-keyword accidents decide leaves, higher and the backoff loses the fine split the leaf gives (86 % of fetched products match a path with 20+ votes today). A constant with this rationale beside it; not configurable.

### 5.3 Stats returned and logged (coded fields only)

`{ week, paths, direct, backedOff, uncoded, trainingProducts, codes }` (the duration is the phase's `import_phase_timings` row; the script times itself); the import logs `[ba-crosswalk] week <date>: paths=… direct=… backedOff=… uncoded=… trainingProducts=… codes=…`, and an older week as `[ba-crosswalk] skipped: ba_crosswalk_older_than_built (week <date>)`.

### 5.4 The import phase `ba_crosswalk_build`

In `inngest/functions/importFile.ts`, right after `top_asins_build` and before `summary_refresh`, inside `if (!isReplay)`: the same shape as the pair-table phase (own `pg.Pool` max 1, keepalive, error listeners, 30-minute statement timeout, a dedicated client checked out for the build), fail-soft: a failure logs `{ week, stage: 'connect' | 'build', error, code }` (coded fields only, the shape of the two phases before it) and the import continues with the previous crosswalk in place. Recorded in `import_phase_timings` like every phase (`rows_affected` = paths written).

### 5.5 The tracked script `scripts/buildBaCrosswalk.ts`

`BA_CROSSWALK_WEEK=YYYY-MM-DD node --env-file=.env.local --import tsx scripts/buildBaCrosswalk.ts` (defaults to the Explorer week from `keyword_current_summary_meta`, which during and right after an import is still the previous week: pass the week explicitly then): a `Pool({ max: 1 })` with one checked-out client as `scripts/buildTopAsinsWeek.ts` (the builder's transactions set their own 30-minute limits), prints the stats, the time and the eight largest codes with their product counts; a week older than the built one is refused with a hint to pass that week; a failed summary query after a committed build does not fail the run. Never run it while an import of the same week is in flight (`scripts/checkActiveJobs.ts`): the week's kwm rows land over hours and a partial week would train the crosswalk. Used for the one-off first build and for a re-run after a Keepa reclassification. Also `BA_CROSSWALK_DRY_RUN=1` runs `computeCrosswalk` only.

> **Amendment (2026-10-14, the reviews of Tasks 3 and 4).** The rebuild does not truncate. It takes `LOCK TABLE ba_category_crosswalk IN SHARE ROW EXCLUSIVE MODE` (builders serialize; readers are never blocked), checks the built week under that lock and refuses a strictly older one with `ba_crosswalk_older_than_built` (a re-run of the same week is allowed; no force option; the import phase logs it as an expected skip), then `DELETE`s and re-inserts in chunks of `WRITE_CHUNK` (10,000 rows), all in one transaction with its own `SET LOCAL statement_timeout = '1800s'` and `lock_timeout = '120s'` (a 55P03 against another builder rolls back; the phase fails soft and the script re-runs). Readers keep the previous rows until the commit and never see an empty table; the ~24k dead rows a week are reclaimed by a best-effort `VACUUM (ANALYZE, TRUNCATE false)` after the commit. The two reads run in one `REPEATABLE READ READ ONLY` transaction with the same `SET LOCAL` limits, because a pool-level `statement_timeout` does not bind through Neon's pooler. So a gap-fill or replacement import of an older week never regresses the live crosswalk, and a by-hand run with the lagging default week (the Explorer week during and right after an import) is refused rather than silently retraining on the previous week.

## 6. Filter semantics and SQL

`ProductFilters.broadCategory` (URL `broad`, `PRODUCT_MAX_BROAD_CATEGORY_LENGTH` 255, `usableCode`) and the select keep their names and shapes. The predicate in `lib/products/searchProducts.ts` becomes

```sql
a.category_path IN (SELECT x.category_path FROM ba_category_crosswalk x WHERE x.code = $n::text)
```

AND-ed with everything else (department, leaf picks, custom categories, the numeric filters). A semi-join against at most a few hundred paths from `ba_category_crosswalk_code_idx`; `asin_products_category_path_idx` (text_pattern_ops) serves equality probes. The integration test records the plans for the largest code (Apparel), a mid code and the smallest code, each alone and with a department, cold first, and bounds every statement under the page's 30 s cap. Documented fallback if a cold case misbehaves: fetch the code's paths first (cached an hour beside the code list) and bind them as `= ANY($n::text[])`, the form arc 8 measured up to 2,000 paths.

> **Amendment (2026-10-14, Task 8 as landed).** The integration cases are the ten broad cases recorded in the plan's Task 8 landed-shape bullet: the code list; the code with the most paths; the facts join; the code with the fewest paths; a mismatched department (Pet Products in Tools & Home Improvement, with a cache-independent verdict: the EXPLAIN ANALYZE re-run's buffer accesses under 400,000); the most-paths code with its own department; Pet Products in Pet Supplies; the most-paths code with a leaf pick; the most paths per sellable product; the most products per path. There is no mid code.

Products with no path (0.8 %) never match a code; a product whose path arrived after the last build and is not yet in the crosswalk (a path new to the catalog) matches no code until the next weekly build.

## 7. The list of codes

`listProductBroadCategories` in `lib/products/listCategories.ts` reads `SELECT DISTINCT code FROM ba_category_crosswalk ORDER BY code` through `neonRunner` (the 30 s cap), cached as today (`unstable_cache`, the SQL text as a key part, 3600 s, tag `PRODUCT_CATEGORIES_TAG`). A code with zero sellable products may appear; harmless. Empty before the first build. The tool's empty-list message becomes "No broad categories are available yet: the Keepa-to-Brand-Analytics crosswalk has not been built."

## 8. Products page

The "Broad category" select is unchanged. Its hint becomes: "Brand Analytics category, as on the Explorer, mapped from the product's Keepa category. One per product." (one line; the owner may reword at smoke).

## 9. ASIN page

`ProductFacts.broadCategory: string | null` replaces `broadCategories: string[]`. `lib/products/loadProduct.ts` reads it inside the facts statement with `LEFT JOIN ba_category_crosswalk x ON x.category_path = a.category_path` (no second read; the parallel codes read and its "skip the tracked probe when codes exist" rule go away, the tracked probe stays as before arc 9). The facts card shows one line, "Broad category", with the code or the dash, in the full fact list only; the stub and "Not fetched yet" shapes show nothing, as today.

## 10. Tools

- `search_products.filters.broadCategory`: unchanged (validated in `resolveProductCategoryScope` against the list after the reserve; `CATEGORY_NOT_AVAILABLE` lists the codes). Its description now says the code is the product's own Brand Analytics category, mapped from its Keepa path.
- `get_product_details.product.broadCategory: string | null` replaces `broadCategories`. Stub products: null (the keyword side no longer supplies codes).
- `GUIDE_VERSION = 6`. The rule: "A product's broadCategory is the Brand Analytics code its Keepa category path maps to: one per product, relearned weekly from the report. A keyword's broadCategory is the category most clicked for that search. The two agree for most keyword–product pairs, not all; use get_product_details for the product's own."
- Ask AI uses the same tools; no change of its own.

## 11. Error handling

- Builder: coded errors (`ba_crosswalk_bad_date`, `ba_crosswalk_bad_client`, `ba_crosswalk_no_votes` when the week has no slot-1 rows, which means the week is not imported, `ba_crosswalk_older_than_built` when the table already holds a newer week); fail-soft inside the import (the older-week case is logged as an expected skip, like the pair-table phase's); the script exits 1 with the code.
- Readers: a missing table (42P01) is a deploy-order error and fails loudly, so 0053 precedes the deploy. The page's list degrades to `[]` on a failed read, the search surfaces the page's error state, the tool rejects, all as today.
- Never log a DB error's `.message` (`errFields`); never print emails.

## 12. Testing

- `assignCodes`: backoff level by level; the 20 threshold at exactly 20; ties by code text; a department under 20 still decides; a path with no votes anywhere gets no row; `share_pct` rounding; prefix splitting with ` › ` and a path of depth 10.
- `computeCrosswalk` / `writeCrosswalk`: SQL pins (partition name from the week, the regex, `mode()`), the transaction shape (SET LOCAL limits, LOCK … SHARE ROW EXCLUSIVE, the older-week guard, DELETE, INSERTs chunked by WRITE_CHUNK, one transaction; VACUUM (ANALYZE, TRUNCATE false) after the COMMIT), stats.
- The inngest phase: order after `top_asins_build` and before `summary_refresh`, the pool shape, fail-soft, skipped on replay (extend `importFile.test.ts`'s existing pattern).
- Readers: `searchProducts` predicate pin + binds; `listCategories` SQL pin; `loadProduct` facts join; FactsCard singular line; ProductFilterPanel hint; contracts (`broadCategory` scalar), `tools.ts` descriptions, `catalog.ts` rule + version, service tests.
- Pair table: `buildWeek.ts` / `backfill.ts` back to eight columns, `BROAD_INDEX` / `PREV_BROAD_GUARD` and the index-name model test removed; `db/schema/keywordTopAsins.ts` without the column; the integration carried-code check removed.
- Integration (owner's go only, read-only against production): `tests/integration/productsQueries.test.ts` broad cases rewritten (largest / mid / smallest code, each alone and with a department, a code + a leaf; cold first; plans printed; every statement under 30 s); a new `tests/integration/baCrosswalk.test.ts` running `computeCrosswalk` for the Explorer week without writing: every catalog path at most once, `source_path` is the path or an ancestor, `share_pct` within 0–100, `direct` ≥ 80 % of paths' products, `uncoded` under 1 %, and the two example paths (Pet Supplies' majority Pet Products; the toilet paper path → Health & Personal Care).

> **Amendment (2026-10-14, Task 8 as landed).** See §6's amendment: ten broad cases, no mid code; the full list, the order and the review rounds are in the plan's Task 8 landed-shape bullet.

## 13. Shipping (each step on the owner's go, in order)

1. `node --env-file=.env.local --import tsx scripts/checkActiveJobs.ts`, then `APPLY_0053=yes … scripts/applyMigration0053.ts` (creates the table and index; seconds; idempotent).
2. One-off first build with the new local code: `BA_CROSSWALK_WEEK=2026-10-10 … scripts/buildBaCrosswalk.ts` (minutes: the first timing of the kwm form; prints the stats and the time; note both in the Results table). The live site is untouched: the old readers still use the pair-table column.
3. Integration: `RUN_INTEGRATION=1 pnpm vitest run tests/integration/productsQueries.test.ts --disableConsoleIntercept` alone first (cold plans), then `tests/integration/baCrosswalk.test.ts`.
4. `checkActiveJobs` → bare `git push origin main` → three deploys green (Vercel may need an empty-commit re-trigger).
5. Smoke, page: the select lists the codes; Pet Products (expect pet products on top); a code + a department; a code + a leaf; `?broad=Nope` → selected, zero rows; the toilet paper ASIN B0FFPF97RV shows "Health & Personal Care"; the medicube B0GHMZXX8Y shows "Beauty". Tools: a `broadCategory` search; a typo returns the codes; `get_product_details.broadCategory`; one Ask AI question.
6. `APPLY_0054=yes … scripts/applyMigration0054.ts` (drops the 0052 column on both tables; instant on an idle table; no import and no backfill run in flight; a rollback to the arc-9 code afterwards needs 0052 re-applied first, which is idempotent). Then the Results table and memory.
7. The next import (week ending 2026-10-17, run 2026-10-20) runs `ba_crosswalk_build` on its own: check its phase timing and that `week_end_date` on the table advanced.

`main` depends on 0053 from the reader tasks on: no push before step 1.

## 14. Out of scope / follow-ups

- Training on several weeks (more paths with 20+ votes, stabler majorities); today one week is simple and fresh.
- A per-product override for mixed paths: a product that is product #1 somewhere has its own vote; where it disagrees with its path's code, a small side table (asin → code, only the disagreeing products, rebuilt with the crosswalk) could win at read time (`coalesce(override, path code)`), at the cost of a two-table predicate and products in one path no longer sharing a code. Decide after seeing the mixed paths in production (`share_pct < 70`).
- Admin overrides (a manual mapping for a path) and showing the mapping's confidence on the facts card.
- The reverse crosswalk (Brand Analytics code → Keepa department) for an Explorer department filter on keywords.
- Paths new to the catalog between builds (no code until the next build); a nightly top-up if it ever matters.
- The 8,521 fetched products without a Keepa path.
- Arc 9's keywords-sort limitation under the largest code (spec 2026-10-12 §13) stays as recorded; the predicate change does not address it.
- A floor on `trainingProducts` (a degenerate report week, e.g. mostly blank categories, must not replace a good crosswalk; ~615k today); product-weighted `direct`/`uncoded` in the phase's log line, so it compares with §2's targets; a shared helper for the three near-identical import hook blocks (`keepa_enqueue`, `top_asins_build`, `ba_crosswalk_build`), as a behaviour-neutral commit after the ship.
