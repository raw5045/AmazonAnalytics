# Products Open-Up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every signed-in account (and its AI connector) gets the Products tab, both product pages and the two product tools; product usage is counted in the daily digest; the keywords sort reads a stored per-product count so no list combination exceeds the 30 s cap; slow or timed-out product searches are logged and reported in the digest; the help page explains the tab (spec `docs/superpowers/specs/2026-10-23-products-open-up-design.md`).

**Architecture:** One migration (0056: `asin_products.keyword_count` + index, `slow_queries`), one weekly import phase (`keyword_counts_build`) with a hand-run backfill, the list query switched to the stored column, a tiny fire-and-forget recorder on the list page, two usage metrics and one digest section, five gate flips, guide text + version 8, copy. No change to what Keepa fetches or to the MCP contracts' shapes.

**Tech Stack:** Next 16 app router, drizzle (type mirrors only; journal frozen), node-postgres on the worker, neon-http on Vercel, Inngest, vitest + Testing Library, zod descriptions for the MCP guide.

**Conventions (every task):** read `node_modules/next/dist/docs/` before touching page code; TDD; `git add` named files only; trailer exactly `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; local commits on main, never push; no DDL and nothing that connects to `.env.local`'s DATABASE_URL (production) — scripts are written, not run; EOL-preserving edits (Edit/Write tools, never Bash text with backslashes or non-ASCII); lint touched files only with `pnpm exec eslint`; log-safe errors (`errFields`, never a DB error's `.message`); never print member emails.

**Task order:** 1 → 2 → 3 → 4 → 6 → 5 → 7 → 8 (one implementer at a time; Task 6 goes before Task 5 so both product pages already hold the signed-in user when the counters land). Task 9 is the controller's review + gate; Task 10 is the owner-gated ship.

---

### Task 1: Migration 0056 and the schema mirrors

**Files:**
- Create: `db/migrations/0056_keyword_counts_and_slow_queries.sql`, `db/schema/slowQueries.ts`, `db/schema/slowQueries.test.ts`, untracked `scripts/applyMigration0056.ts` (written only; the owner runs it)
- Modify: `db/schema/asinProducts.ts` (the column + index), `db/schema/index.ts` (export), `db/schema/asinProducts.test.ts` if it pins columns

- [ ] **Step 1: Pin the mirrors in tests first.** `db/schema/slowQueries.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { slowQueries } from './slowQueries';
import { asinProducts } from './asinProducts';

describe('slow_queries (migration 0056)', () => {
  it('mirrors the table: columns, nullability, the (surface, happened_at) index', () => {
    const t = getTableConfig(slowQueries);
    expect(t.name).toBe('slow_queries');
    expect(t.columns.map((c) => [c.name, c.notNull])).toEqual([
      ['id', true], ['surface', true], ['happened_at', true], ['user_id', false], ['query_string', true], ['elapsed_ms', true], ['timed_out', true],
    ]);
    expect(t.indexes.map((i) => i.config.name)).toEqual(['slow_queries_surface_happened_at_idx']);
  });
  it('asin_products carries keyword_count (not null, default 0) and its index', () => {
    const t = getTableConfig(asinProducts);
    const col = t.columns.find((c) => c.name === 'keyword_count');
    expect(col?.notNull).toBe(true);
    expect(col?.hasDefault).toBe(true);
    expect(t.indexes.map((i) => i.config.name)).toContain('asin_products_keyword_count_idx');
  });
});
```

- [ ] **Step 2:** run it → fails (no module / no column).
- [ ] **Step 3: The migration** `db/migrations/0056_keyword_counts_and_slow_queries.sql` (same header style as 0055; `user_id` takes the type of `users.id` — check `db/schema/users.ts`; the plan assumes `uuid`):

```sql
-- db/migrations/0056_keyword_counts_and_slow_queries.sql
-- 0056 (hand-numbered, applied by the untracked scripts/applyMigration0056.ts on the owner's go;
-- never through drizzle-kit — the journal is frozen). Spec 2026-10-23 (products open-up) §5 and §5b.
-- ADDITIVE. (1) asin_products.keyword_count: the current week's count of keywords the product is a
-- top-3 clicked product for, written weekly by the import's keyword_counts_build phase (and once by hand,
-- scripts/buildKeywordCounts.ts); 0 until then. ADD COLUMN ... DEFAULT 0 is instant (catalog default);
-- the index build takes a brief write lock on asin_products (the Keepa service's batch writes wait).
-- (2) slow_queries: one row per product search that timed out (57014) or ran slower than
-- SLOW_PRODUCT_SEARCH_MS, read by the daily usage digest; pruned to 90 days by the digest job.
-- Apply BEFORE the code deploys: the keywords sort reads the column (42703 without it).

ALTER TABLE asin_products ADD COLUMN IF NOT EXISTS keyword_count integer NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS asin_products_keyword_count_idx ON asin_products (keyword_count, asin);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS slow_queries (
  id bigserial PRIMARY KEY,
  surface text NOT NULL,
  happened_at timestamptz NOT NULL DEFAULT now(),
  user_id uuid NULL,
  query_string text NOT NULL,
  elapsed_ms integer NOT NULL,
  timed_out boolean NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS slow_queries_surface_happened_at_idx ON slow_queries (surface, happened_at);
```

- [ ] **Step 4: Mirrors.** `db/schema/slowQueries.ts`:

```ts
// db/schema/slowQueries.ts
import { pgTable, bigserial, text, timestamp, uuid, integer, boolean, index } from 'drizzle-orm/pg-core';

/**
 * Slow or timed-out searches (migration 0056; spec 2026-10-23 §5b): one row per product search that hit the
 * 30 s cap (timed_out) or ran slower than SLOW_PRODUCT_SEARCH_MS, with the filter combination as the URL
 * query string, so the daily usage digest can list what runs long and the integration harness can replay it.
 * `surface` is 'products' today; the Keywords tab can join later. Written by lib/products/slowQueries.ts,
 * read by lib/notifications/abuseDigest/loadAbuseDigestData.ts, pruned by the digest job. Type mirror only.
 */
export const slowQueries = pgTable(
  'slow_queries',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    surface: text('surface').notNull(),
    happenedAt: timestamp('happened_at', { withTimezone: true }).notNull().defaultNow(),
    userId: uuid('user_id'),
    queryString: text('query_string').notNull(),
    elapsedMs: integer('elapsed_ms').notNull(),
    timedOut: boolean('timed_out').notNull(),
  },
  (t) => ({
    surfaceHappenedAtIdx: index('slow_queries_surface_happened_at_idx').on(t.surface, t.happenedAt),
  }),
);
export type SlowQueryRow = typeof slowQueries.$inferSelect;
```

  `db/schema/asinProducts.ts`: add `keywordCount: integer('keyword_count').notNull().default(0),` with a doc comment ("current week's top-3 keyword count, keyword_counts_build; spec 2026-10-23 §5") and the index `keywordCountIdx: index('asin_products_keyword_count_idx').on(t.keywordCount, t.asin)`. `db/schema/index.ts`: `export * from './slowQueries';`.

- [ ] **Step 5: The apply script** (untracked; the 0055 one is the template: reads the SQL file, splits on `--> statement-breakpoint`, refuses unless `APPLY_0056=yes`, runs each statement on a `pg` Client with a 600 s statement timeout, prints each statement's first line and elapsed time). Do not run it.
- [ ] **Step 6:** tests green (`pnpm exec vitest run db/schema`), `pnpm typecheck`, eslint; commit `feat(db): migration 0056 — asin_products.keyword_count + index, slow_queries (mirrors; applied by hand)`.

---

### Task 2: The weekly keyword counts (builder, import phase, backfill script)

**Files:**
- Create: `lib/products/buildKeywordCounts.ts`, `lib/products/buildKeywordCounts.test.ts`, `scripts/buildKeywordCounts.ts` (committed, like buildProductCategoryFacets.ts; run by the owner)
- Modify: `inngest/functions/importFile.ts` (new phase right after `top_asins_build`), `inngest/functions/importFile.test.ts` (phase presence/order), `app/admin/ImportStatusChip.tsx` (label), `app/admin/ImportStatusChip.test.tsx` if it pins labels

- [ ] **Step 1: Failing builder tests** (`lib/products/buildKeywordCounts.test.ts`, a fake client capturing `query(text, values)` calls like `buildCategoryFacets.test.ts` does):
  - runs `BEGIN`, `SET LOCAL statement_timeout = '600s'`, the two UPDATEs, `COMMIT`; returns `{ updated, zeroed, seconds }` from the two statements' `rowCount`s;
  - a failing statement → `ROLLBACK` and the error rethrown as `KeywordCountsBuildError` with code `keyword_counts_bad_client` only when the client is not a pg client (mirror `facets_bad_client`), otherwise the original error;
  - the two statements' text contains `IS DISTINCT FROM` and `NOT EXISTS` (the only rows written are the changed ones).
- [ ] **Step 2:** run → fails.
- [ ] **Step 3: The builder** `lib/products/buildKeywordCounts.ts`:

```ts
// lib/products/buildKeywordCounts.ts
/**
 * Writes asin_products.keyword_count (spec 2026-10-23 §5): the current week's count of keywords the product
 * is a top-3 clicked product for, from keyword_top_asins (rebuilt by top_asins_build, current week only).
 * Runs weekly as the import's keyword_counts_build phase right after top_asins_build, and by hand
 * (scripts/buildKeywordCounts.ts). Two statements in one transaction: set the changed counts, zero the
 * products that dropped out. Only changed rows are written, so a quiet week writes little. Idempotent.
 */
import type { Client, PoolClient } from 'pg';

export type KeywordCountsClient = Pick<Client | PoolClient, 'query'>;
export interface KeywordCountsResult { updated: number; zeroed: number; seconds: number }

export const SET_COUNTS_SQL = `UPDATE asin_products a SET keyword_count = c.n
  FROM (SELECT asin, count(*)::int AS n FROM keyword_top_asins GROUP BY asin) c
  WHERE a.asin = c.asin AND a.keyword_count IS DISTINCT FROM c.n`;
export const ZERO_DROPPED_SQL = `UPDATE asin_products a SET keyword_count = 0
  WHERE a.keyword_count <> 0 AND NOT EXISTS (SELECT 1 FROM keyword_top_asins k WHERE k.asin = a.asin)`;

export async function buildKeywordCounts(client: KeywordCountsClient): Promise<KeywordCountsResult> {
  const started = Date.now();
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL statement_timeout = '600s'");
    const set = await client.query(SET_COUNTS_SQL);
    const zero = await client.query(ZERO_DROPPED_SQL);
    await client.query('COMMIT');
    return { updated: set.rowCount ?? 0, zeroed: zero.rowCount ?? 0, seconds: (Date.now() - started) / 1000 };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  }
}
```

  (Keep it this simple; a bad-client wrapper is unnecessary — the phase's catch logs `errFields`.) Adjust Step 1's second bullet accordingly: a failing statement → ROLLBACK + rethrow.

- [ ] **Step 4: The import phase.** In `inngest/functions/importFile.ts`, right after the `top_asins_build` `timePhase(...)` block (before `ba_crosswalk_build`), add a block modelled on the `category_facets_build` one: a `Pool({ max: 1, statement_timeout: 600_000, keepAlive… })`, `timePhase(file.id, 'keyword_counts_build', async () => { … buildKeywordCounts(client) … console.log('[keyword-counts] updated=… zeroed=… seconds=…') … catch → console.error('[keyword-counts] failed (import continues)', JSON.stringify({ week, stage, error, code })) → null }, (r) => (r ? r.updated + r.zeroed : null))`. Comment: a failure never fails the import (the previous counts stay; the by-hand script re-runs it); skipped on replays like the neighbours. `importFile.test.ts`: the phase runs after `top_asins_build` and before `ba_crosswalk_build`, logs its counts, and a thrown builder error is swallowed with the coded log line (mirror the facets tests).
- [ ] **Step 5: The chip.** `app/admin/ImportStatusChip.tsx`: `case 'keyword_counts_build': return 'Keyword counts';` (+ its test if labels are pinned).
- [ ] **Step 6: The by-hand script** `scripts/buildKeywordCounts.ts` (modelled on `scripts/buildProductCategoryFacets.ts`: refuses without DATABASE_URL; `KEYWORD_COUNTS_DRY_RUN=1` runs only `SELECT count(*) FROM (SELECT asin FROM keyword_top_asins GROUP BY asin) c` and prints the distinct-ASIN count; otherwise a `pg` Pool client → `buildKeywordCounts` → prints updated / zeroed / seconds). Written, not run.
- [ ] **Step 7:** tests (`pnpm exec vitest run lib/products/buildKeywordCounts.test.ts inngest/functions/importFile.test.ts app/admin`), typecheck, eslint; commit `feat(import): keyword_counts_build writes asin_products.keyword_count weekly after top_asins_build; by-hand script`.

---

### Task 3: The keywords sort reads the stored count

**Files:**
- Modify: `lib/products/searchProducts.ts` (the keywords sort and the Keywords column read `a.keyword_count`; the lateral count goes), `lib/products/searchProducts.test.ts`, `lib/products/filterParams.ts` only if needed (keep `NullableKeySort` as is), `tests/integration/productsQueries.test.ts` (new cases, run by the owner)

- [ ] **Step 1: Failing unit tests** in `searchProducts.test.ts` (it pins SQL text): for `sort: 'keywords'` the rows statement contains `ORDER BY a.keyword_count DESC, a.asin DESC` (and ASC for `dir: 'asc'`), contains no `LATERAL`, and selects `a.keyword_count`; for every other sort the statement is unchanged apart from `a.keyword_count` in the page columns and no `kc.` reference; the count statement is unchanged.
- [ ] **Step 2:** run → fails.
- [ ] **Step 3: Implement.** In `searchProducts.ts`: add `a.keyword_count` to `PAGE_COLUMNS`; delete the `keywordCount` lateral helper; compute `const keyColumn = f.sort === 'keywords' ? 'keyword_count' : sortHidesNullKey(f.sort) ? SORT_COLUMN[f.sort] : null;` and push `a.<key> IS NOT NULL` only when `sortHidesNullKey(f.sort)` (keyword_count is NOT NULL); the rows statement is always the "page first" shape, now without the outer lateral: `SELECT ${PAGE_COLUMNS} FROM asin_products a WHERE ${whereSql} ORDER BY a.${keyColumn} ${dir}, a.asin ${dir} LIMIT … OFFSET …` (a single level is enough once nothing is joined). `Raw.keyword_count` and the row mapping stay; update the file's header comment (the 30 s rationale now reads "the keywords sort walks asin_products_keyword_count_idx like the others"). `lib/research/products.ts` needs no change (it calls `searchProducts`).
- [ ] **Step 4: Integration cases** (`tests/integration/productsQueries.test.ts`, inside the existing describe, same helpers): (a) `{ ...PRODUCT_DEFAULTS, sort: 'keywords', broadCategory: 'Home' }` explained: the plan contains `asin_products_keyword_count_idx` and no Sort over more than a page; rows + count statements each under `PRODUCT_READ_TIMEOUT_MS / 1000` cold (log the seconds); (b) the stored counts agree with a fresh count: `SELECT count(*) FROM (SELECT a.asin FROM asin_products a JOIN LATERAL (SELECT count(*)::int n FROM keyword_top_asins k WHERE k.asin = a.asin) c ON true WHERE a.keyword_count <> c.n LIMIT 1000) m` is 0 after the backfill (skip with a console note while every `keyword_count` is 0: `SELECT max(keyword_count) FROM asin_products` = 0 means the backfill has not run).
- [ ] **Step 5:** unit tests green, typecheck, eslint; commit `feat(products): the keywords sort and the Keywords column read the stored keyword_count`.

---

### Task 4: The slow-search log and the in-page timeout notice

**Files:**
- Create: `lib/products/slowQueries.ts`, `lib/products/slowQueries.test.ts`
- Modify: `lib/products/searchProducts.ts` (export `isStatementTimeout`), `app/(app)/products/(list)/page.tsx`, `app/(app)/products/(list)/page.test.tsx`

- [ ] **Step 1: Failing tests.** `slowQueries.test.ts` (mock `@/lib/db`'s `db.insert(...).values(...)`): `recordSlowProductSearch({ userId, queryString, elapsedMs, timedOut })` inserts `{ surface: 'products', userId, queryString, elapsedMs, timedOut }`; a rejected insert resolves anyway and `console.warn`s one line with `errFields` (no message text); `SLOW_PRODUCT_SEARCH_MS` is 8000. `page.test.tsx`: (a) the search rejects with `{ code: '57014' }` → the page renders the notice text and no results table, keeps the filter panel, and `recordSlowProductSearch` was called with `timedOut: true`, the filters' query string (`productFiltersToSearchParams(filters).toString()`) and a numeric `elapsedMs`; (b) a search that resolves after the mocked timer reports 9,000 ms → called with `timedOut: false`; (c) a fast search → not called; (d) any other rejection still throws.
- [ ] **Step 2:** run → fails.
- [ ] **Step 3: Implement.** `lib/products/slowQueries.ts`:

```ts
// lib/products/slowQueries.ts
/**
 * Records a product search that ran long (spec 2026-10-23 §5b): the page calls it after the search settled,
 * fire-and-forget, so recording never delays or fails the response. The daily usage digest reads the rows.
 */
import { db } from '@/lib/db';
import { slowQueries } from '@/db/schema';
import { errFields } from '@/lib/log/errFields';

/** A product search slower than this is recorded even when it completes. */
export const SLOW_PRODUCT_SEARCH_MS = 8_000;

export async function recordSlowProductSearch(args: { userId: string | null; queryString: string; elapsedMs: number; timedOut: boolean }): Promise<void> {
  try {
    await db.insert(slowQueries).values({ surface: 'products', userId: args.userId, queryString: args.queryString, elapsedMs: Math.round(args.elapsedMs), timedOut: args.timedOut });
  } catch (e) {
    console.warn('[slow-queries] record failed', JSON.stringify({ outcome: 'record_failed', ...errFields(e) }));
  }
}
```

  (Use the repo's actual `errFields` import path and `db` instance; check `lib/activity/bump.ts` for both.) `searchProducts.ts`: `export function isStatementTimeout(e: unknown): boolean { return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === STATEMENT_TIMEOUT; }`.

  `app/(app)/products/(list)/page.tsx`: in `loadProductsPage`, wrap the search: time it (`timed` already measures ms); on rejection with `isStatementTimeout(e)` → `void recordSlowProductSearch({ userId, queryString, elapsedMs, timedOut: true })` and continue with `result = null`; on success with `ms > SLOW_PRODUCT_SEARCH_MS` → record with `timedOut: false`; other rejections rethrow. Return `timedOut: result === null`. In `ProductsResults`, when `timedOut`, render in place of `ProductResultsTable`:

```tsx
<p role="status" className="card-app px-4 py-6 text-sm text-gray-700">
  This combination took too long to load. Narrow the filters or try again.
</p>
```

  keeping the filter panel and the perf panel. `queryString = productFiltersToSearchParams(filters).toString()`.
- [ ] **Step 4:** tests green, typecheck, eslint; commit `feat(products): slow and timed-out searches are recorded; the list shows an inline notice on a timeout`.

---

### Task 5: Usage counters and the digest

**Files:**
- Modify: `lib/activity/bump.ts`, `app/(app)/products/(list)/page.tsx`, `app/(app)/products/[asin]/page.tsx`, `lib/notifications/abuseDigest/{types,assembleStats,loadAbuseDigestData,evaluateFlags,buildAbuseDigestEmail}.ts`, `inngest/functions/sendAbuseDigest.ts` (retention), and their tests (`assembleStats.test.ts`, `evaluateFlags.test.ts`, `buildAbuseDigestEmail.test.ts`, the two page tests, `app/admin/abuse-digest/page.test.tsx` if it pins sections)

- [ ] **Step 1: Failing tests.** Metrics: the list page bumps `products_query` once per render with a search and the product page bumps `product_view` once (mock `bumpUserActivity`; fire-and-forget, after auth). Digest: `assemblePerUserActivity` maps `products_query` → `productsQueries` and `product_view` → `productViews`, and the reads sort includes them; `evaluateFlags` counts them in the per-user reads threshold and adds `{ severity: 'amber', message: 'N product search timeouts (amber threshold: 0)' }` when `stats.slowSearches.timeouts > 0`; `buildAbuseDigestEmail` renders the two new columns ("Products", "Product views") after "Detail views" in both the text and the HTML table, and a "Slow product searches" section (text + HTML) with the timeout and slow counts and the top rows (`queryString`, `occurrences`, `accounts`), or "none" when empty; `loadAbuseDigestData` returns `slowSearches` for the day (mock the db).
- [ ] **Step 2:** run → fails.
- [ ] **Step 3: Implement.**
  - `bump.ts`: `| 'products_query' | 'product_view'` with doc lines.
  - List page: `void bumpUserActivity(user.id, 'products_query')` right after the auth mark (as `explorer/page.tsx` does for `explorer_query`); product page: `void bumpUserActivity(user.id, 'product_view')` after auth (both pages hold the signed-in user since Task 6).
  - `types.ts`: `PerUserActivity` gains `productsQueries: number; productViews: number;`; `AbuseDigestStats` gains `slowSearches: SlowSearchesSummary` with `interface SlowSearchesSummary { timeouts: number; slow: number; top: Array<{ queryString: string; occurrences: number; accounts: number }> }`.
  - `assembleStats.ts`: `USER_METRICS` gains `productsQuery: 'products_query', productView: 'product_view'`; `rowFor` initialises both to 0; the mapping assigns them; the reads rank adds them.
  - `loadAbuseDigestData.ts`: one query over `slow_queries` for the digest day (ET day bounds, same helper the counters use): counts by `timed_out`, and the top ten `query_string`s by occurrences with `count(distinct user_id)`; returns `slowSearches`.
  - `evaluateFlags.ts`: reads = `explorerQueries + detailViews + productsQueries + productViews`; new `THRESHOLDS.productSearchTimeoutsPerDay = { amber: 0 }` and the flag.
  - `buildAbuseDigestEmail.ts`: the two columns in the text line and the table (every window table, like the others); `totalReads` includes them; the new section after the daily active users: heading "Slow product searches (timeouts N, slow M)", then up to ten rows "<occurrences>× by <accounts> account(s): <query string>" (escape HTML; monospace in HTML), or "none".
  - `inngest/functions/sendAbuseDigest.ts`: after the send step, a `prune-slow-queries` step: `DELETE FROM slow_queries WHERE happened_at < now() - interval '90 days'` (drizzle `lt`), logged with the row count.
- [ ] **Step 4:** tests green (`pnpm exec vitest run lib/notifications/abuseDigest lib/activity "app/(app)/products" inngest/functions/sendAbuseDigest.test.ts app/admin/abuse-digest`), typecheck, eslint; commit `feat(digest): product searches and views are counted; slow product searches get a section and a flag; 90-day pruning`.

---

### Task 6: The five gates open to signed-in accounts

**Files:**
- Modify: `app/(app)/layout.tsx` (`showProducts={true}`), `app/(app)/products/(list)/page.tsx` + test (auth via `getCurrentUser`), `app/(app)/products/[asin]/page.tsx` + test, `app/(app)/explorer/keyword/[id]/page.tsx` (`linkProducts={user !== null}`), comments in `BackToProducts.tsx`, `TopProductsSection.tsx`, `FactsCard.tsx`, `lib/research/products.ts` ("admin-only" → "signed-in accounts")

- [ ] **Step 1: Failing tests.** List page + product page tests: swap the `requireAdmin` mock for a `getCurrentUser` mock; a `{ role: 'member' }` user renders the page; `null` redirects to `/sign-in`; the admin PerfPanel still renders only for `role: 'admin'`. Layout test (if any) pins `showProducts` true for a member; `TabNav.test.tsx` unchanged (it tests the prop). Keyword page test (if one renders the section) pins the product link for a member.
- [ ] **Step 2:** run → fails.
- [ ] **Step 3: Implement.** List page:

```ts
  const user = await getCurrentUser();
  if (!user) redirect('/sign-in');
```

  (drop the `requireAdmin` import and the `AuthError` branch; keep `admin={user.role === 'admin'}` on the PerfPanel; comments say "signed-in accounts (spec 2026-10-23 §2)"). Product page the same (it needs the user for Task 5's counter). Layout: `showProducts={true}` with a one-line comment. Keyword page: `linkProducts={user !== null}`. Reword the four comment spots.
- [ ] **Step 4:** tests green, typecheck, eslint; commit `feat(products): the Products tab, both pages and the keyword-page product links open to every signed-in account`.

---

### Task 7: The AI tools for everyone, the guide, the example

**Files:**
- Modify: `lib/research/tools.ts` (`adminOnly` off the two product definitions; any "admin only" wording in their descriptions), `lib/research/products.ts` (`assertAdmin`/`productsForbiddenError` removed), `lib/research/service.ts` (`products: true`), `lib/research/catalog.ts` (rules + `GUIDE_VERSION` 8), `lib/ask/examples.ts` (the example), and tests: `lib/research/tools.test.ts`, `lib/research/products.test.ts`, `lib/research/service.test.ts`, `lib/research/catalog.test.ts`, `lib/mcp/tools/registerResearchTools.test.ts`, `lib/ask/tools.test.ts`, `lib/research/contracts.test.ts` only if a description changed

- [ ] **Step 1: Failing tests.** A member actor's `search_products` / `get_product_details` are served (the FORBIDDEN cases become served cases); the two definitions are offered to a member in the MCP listing and in Ask AI; `GUIDE_VERSION` is 8 and the guide of a member actor carries the products section; `PRODUCT_RULES` contains the two new rules and not "admin accounts only"; `MORE_EXAMPLES` contains the new question.
- [ ] **Step 2:** run → fails.
- [ ] **Step 3: Implement.** `catalog.ts`: replace `PRODUCT_RULES[0]` with

```ts
  'A niche or category in a product question means: resolve the words with resolve_categories first and pass the returned selection in filters.categories (the supplements niche → the Vitamins, Minerals & Supplements selection), optionally narrowed with department or broadCategory.',
  "Sales asked per day or per week map onto monthlySoldMin: multiply by 30 or by 4 (1,000 a day → monthlySoldMin 30000). monthlySold is Amazon's 'bought in past month' floor, so read the result as 'at least'. Listed within N days → listedWithinDays (60, 90, 180 or 365; pick the smallest that covers the ask and say so).",
```

  `GUIDE_VERSION = 8` with the doc-comment entry "8: the products tools are offered to every account; niche and per-day rules (spec 2026-10-23 §3)". `service.ts`: `products: true` (comment updated). `products.ts`: delete `assertAdmin`, `productsForbiddenError` and their call sites (and the `FORBIDDEN` import if now unused). `tools.ts`: remove `adminOnly: true` from the two definitions (keep the mechanism and its doc). `examples.ts`: add `'Show me products in the supplements niche that sell over 1,000 units a day and were listed within the last 60 days.'` to `MORE_EXAMPLES`.
- [ ] **Step 4:** tests green (`pnpm exec vitest run lib/research lib/mcp lib/ask`), typecheck, eslint; commit `feat(mcp): the product tools are offered to every account; guide v8 with niche and per-day rules; a products example question`.

---

### Task 8: Help, pricing, profile, and the two riders

**Files:**
- Modify: `app/(marketing)/help/page.tsx`, `app/(marketing)/pricing/page.tsx`, `docs/marketing/keywordquarry-product-profile.md`, `lib/products/format.ts` (the constant), `app/(app)/products/ProductResultsTable.tsx` (BSR "#", header title constant) + test, `app/(app)/products/ProductFilterPanel.tsx` (hint constant) + test, `app/(app)/products/[asin]/FactsCard.tsx` (note constant), `app/(app)/explorer/keyword/[id]/TopProductsSection.tsx` (header title constant)

- [ ] **Step 1: Failing tests.** `ProductResultsTable.test.tsx`: the BSR cell reads `#1,234` (adjust the fixture pin); `format.test.ts`: `BOUGHT_IN_PAST_MONTH` equals `Amazon’s “bought in past month” badge`; the three component tests keep their string pins (the constant must equal them).
- [ ] **Step 2:** run → fails.
- [ ] **Step 3: Implement.** `format.ts`: `export const BOUGHT_IN_PAST_MONTH = 'Amazon’s “bought in past month” badge';` (doc: the one wording for the badge note, used by the list header, the filter hint, the facts card and the keyword table). Use it in the four places (the filter hint renders `{BOUGHT_IN_PAST_MONTH}.`). BSR cell: `#${row.salesRank.toLocaleString('en-US')}`. Help page, after "The competition lens": 

```tsx
      <Section title="The Products tab">
        <p>
          Every product that is one of the three most-clicked results for any keyword sits in the Products tab,
          with Keepa catalog data: listing date and age, monthly sold (Amazon&apos;s &ldquo;bought in past month&rdquo;
          floor), rating and reviews, best sellers rank and how it compares with its own 30-day average, price,
          whether FBA and Amazon itself sell it, and how many keywords it currently wins. Filter by department,
          leaf or custom category, age, sales, reviews, rating, price and rank; sort by any of them. Open a product
          for its facts, its history charts (one point per fetch, filling in week by week) and every keyword it
          ranks for. The catalog refreshes continuously; each product is re-fetched about weekly.
        </p>
      </Section>
```

  Pricing `INCLUDED`: `'The Products tab — the catalog behind the top-clicked products'` after the Keywords bullet. Profile doc: the Products presentation line says open to all members; Ask AI stays admin-only.
- [ ] **Step 4:** tests green, typecheck, eslint; commit `feat(copy): Products section on the help page, the pricing bullet; BSR shows "#"; one wording for the badge note`.

---

### Task 9: Final review, gate, docs (controller)

- [ ] Dispatch the whole-diff review (spec compliance + quality over Tasks 1–8); nits back to the implementers.
- [ ] Gate: `pnpm exec vitest run`, `pnpm typecheck`, `pnpm build`, eslint on every touched file.
- [ ] Fill the Results table; commit the docs.

### Task 10: Ship (owner-gated, in this order)

Order matters: the pushed code reads `asin_products.keyword_count` on every list sort and the digest reads `slow_queries`, so a deploy BEFORE 0056 fails the list page (42703) and the next morning's digest (42P01). 0056 and a "built" backfill (VACUUM included) come before the push.

0. `node --env-file=.env.local --import tsx scripts/checkActiveJobs.ts` first: no import running, the Keepa service idle enough (0056's index build takes a brief write lock on asin_products; the backfill holds the enqueue advisory lock for its minutes). Not during an import.
1. `APPLY_0056=yes node --env-file=.env.local --import tsx scripts/applyMigration0056.ts` (the owner's go; per-statement transactions, lock_timeout 5 s with retries; the index build briefly blocks the Keepa service's writes).
2. `node --env-file=.env.local --import tsx scripts/buildKeywordCounts.ts` (the owner's go; prints updated / zeroed / seconds / vacuum; several minutes on 2.5M rows). The gate is the word `built` in its last line; if it prints `vacuum=failed`, run `VACUUM (ANALYZE) asin_products` by hand before the push (the partial index's statistics feed the planner).
3. `RUN_INTEGRATION=1 pnpm exec vitest run tests/integration/productsQueries.test.ts --disableConsoleIntercept` (the owner's go; `-t "keywords sort"` for the coldest reading first): the keyword-sort cases under the cap cold with `asin_products_keyword_count_idx` in the plan, the sampled counts agree.
4. `scripts/checkActiveJobs.ts` again → bare `git push origin main` on the owner's "go push" (outside 03:30–06:59 ET) → Vercel + worker + Keepa deploys → `curl -X PUT https://amazonanalytics-production.up.railway.app/api/inngest`.
5. Smoke as a member (the owner's standard account): the tab shows; `/products` loads; `broad=Home&sort=keywords` loads; a product page; a keyword page's product title links; `get_research_guide` → guideVersion 8 and the products section from a member connector in a NEW conversation (connectors cache the tool list and guide of an open one); the owner's example question through the connector.
6. Next morning: the digest shows the two columns and the slow-search section (likely "none"). Next import: `keyword_counts_build` in the timings and the chip.
7. When the digest lists a slow query string: `PRODUCTS_REPLAY_QUERY='<the string>' RUN_INTEGRATION=1 pnpm exec vitest run tests/integration/productsQueries.test.ts -t replay --disableConsoleIntercept` prints the cold plan and timing for that exact filter set; fix with an index or a guard.

## Results

| Step | Result |
|---|---|
| Task 1 | e30bcba (sonnet) + 32f7f34 review fixes: 0056 = keyword_count column, a PARTIAL index on the list's base predicate (reviewer: a plain index would walk ~300k retired count-0 rows on an ascending sort), slow_queries; the untracked apply script runs one statement per transaction with SET LOCAL lock_timeout/statement_timeout (a Client-option timeout is ignored behind Neon's pooler), takes the Keepa enqueue lock for the index build, verifies indisvalid + pg_get_indexdef; review: pass/approve |
| Task 2 | 3806093 (opus) + 3ec0e41 + b8e1d08: buildKeywordCounts takes the EXCLUSIVE enqueue advisory lock (deadlock-safe vs the Keepa service's shared lock, the enqueue precedent), SET LOCAL work_mem 256MB, refuses an empty pair table (keyword_counts_no_rows), configurable statement limit (600 s in the phase, 1800 s in the by-hand script), VACUUM (ANALYZE) after COMMIT (dead index entries would slow the ascending sort until autovacuum), coded-only warns; phase keyword_counts_build after top_asins_build inside the replay guard; chip 'Keyword counts'; review: pass/approve after the VACUUM change |
| Task 3 | 264ad3c (opus) + d50be2c: every sort is one level (the two-level shape only existed for the lateral), keywords sort = ORDER BY a.keyword_count; 67 SQL pins incl. a mapper-vs-selected-columns check; integration cases (a)/(b) Home + keywords desc/asc under the cap with the index in the plan, (c) a 6,000-product sampled stored-vs-fresh check through the index (the full pass is opt-in via PRODUCTS_FULL_COUNT_CHECK=1); review: pass/approve |
| Task 4 | 4577b87 (opus) + 71259e0: recordSlowProductSearch (coded-only warn, no length cap: the producer re-serialises a URL-bounded filter set), isStatementTimeout exported, the list page records on the search's own settle via a guarded after() (direct fallback), null-on-timeout renders the inline notice with the panel kept; 8,001/8,000 boundary pinned; review: pass/approve |
| Task 5 | 887a0e7 (opus) + 09db293: products_query (list render, after auth, before reads) and product_view (after the isAsin check); digest columns in all three tables, totalReads + the reads threshold include them; 'Slow product searches (timeouts N, slow M)' section (top 10, 400-char display cap, escaped after truncation, 'none'), amber flag '1 product search timeout yesterday (amber threshold: 0)'; prune-slow-queries step (90 days, cannot fail the digest); bump.ts warns coded fields only; review: ship |
| Task 6 | d4e057f (sonnet): layout showProducts=true, both pages getCurrentUser + /sign-in redirect (PerfPanel still admin-only), keyword page linkProducts = signed in; role enum is admin | standard_user; reviewer's security pass found no admin assumption left (loaders, ?from=, custom categories owner-scoped, proxy gate); review: ship |
| Task 7 | fa46702 (opus) + 99f3025: adminOnly off the two tools (mechanism kept + tested), assertAdmin gone, answers' adminOnly=false (shape kept), guide products:true for every actor (research service AND the Ask AI chat route), GUIDE_VERSION 8, the two rules (final wording names filters.categories.selections, the 100000 cap, the over-365-days case), example question appended, tool/page copy mention products; 971 tests; review: ship |
| Task 8 | b3ab880 (sonnet): help section 'The Products tab', pricing bullet, profile doc clarification, BSR '#1,234', BOUGHT_IN_PAST_MONTH constant in the four places, two stale describe titles renamed; a mid-task sed stripped CRs from TabNav.test.tsx and was restored (verify EOLs in the final review) |
| Final review + gate | Whole-diff review (opus) of e30bcba..f770b14: "Ship after nits" (N1 comments claimed a replay hook that did not exist; N2 by-hand pair-table rebuilds must be followed by scripts/buildKeywordCounts.ts; S1 BASE-vs-partial-index test; I1 the tools' timeouts were neither logged nor answered honestly). Follow-up commits (opus implementer, one at a time): 25a0320 (search_products records under surface products_tool, answers a non-retryable QUERY_TIMEOUT, digest marks "via AI tools", opt-in replay case PRODUCTS_REPLAY_QUERY, BASE exported + pinned to the seven partial indexes), 841e927 (the tool's string carries its scope: leaf= / custom= page form + leafExact=), aa68aec (string cap + PRODUCTS_REPLAY_FILE). Review of those three (opus): "Not yet" — the MCP route's maxDuration 30 equalled the product read cap, so a timed-out tool search was a Vercel 504 before the tool could record or answer it; a cut string replayed as a smaller search. Fixed in 4446d36: maxDuration 60 + source-reading pin test, scheduleSlowSearchRecord (after() + fallback) shared by page and tool, cap raised to a 1,000,000-character safety bound, the replay refuses a cut string, parseRecordedProductSearch/scopeForReplay shared by harness and unit test, the replay also times the count, viaToolTotal in the heading, surface in the warn. Gate at 4446d36: `pnpm exec vitest run` 251 files / 3,193 tests green; `pnpm typecheck` 0; `pnpm build` compiled; eslint clean on the 24 touched files; `next/server` verified to load in plain Node (the worker's runtime) with after() throwing into the fallback outside a request. Re-review of 4446d36 (same reviewer): "Ship after nits" — every earlier item closed; the worker's esbuild import graph (125 modules) has no `next` (the digest loader's slowQueries import is type-only); after() verified to register inside the MCP tool callback on both protocol paths; the remaining nits were doc/comment wording (spec §10 after() sentence and the size claim, the psql snippet replaced by a node one-liner, the count's warm timing noted, the Ask AI clause), applied by the controller. |
| 0056 + backfill + integration | 2026-10-24, each on the owner's go: 0056 applied ~14:02 UTC (4 statements; the partial index built in 3.8 s; the script's verification passed; the auto-mode permission layer denied the first run as a "Production Deploy" and allowed the retry the owner asked for). Backfill ~14:10 UTC: `built: updated=2408240 zeroed=0 seconds=228.0 vacuum=ok`. Integration (reads only): the two keywords-sort cases alone first — Home + keywords desc rows 0.06 s / count 0.08 s, asc rows 0.08 s / count 0.16 s, both plans on asin_products_keyword_count_idx (before the arc: over the 30 s cap cold); then the whole file 25 passed / 2 skipped (the opt-in full-count pass and the replay), stored counts vs a fresh GROUP BY: 3,555 sampled products, 0 mismatched; slowest rows statement in the file 3.27 s. |
| Push / deploys | 2026-10-24 17:12 UTC on "go push" (a981fe4..169eb02, 26 commits; checkActiveJobs clean). Statuses: worker green 17:13:12, Vercel green 17:13:13, Keepa service green 17:15:32. Worker health on 169eb02 (13 functions, booted 17:13:08); Inngest PUT → "Successfully registered", modified. Public pages on production: the help page's "The Products tab" section and the pricing bullet render. Keepa service rebooted 17:15:29 on the new build and kept fetching (800 fetches in the following 5 min, due lane; its last_error_code is the 2026-10-22 rotation's 402, nothing new). |
| Smoke | |
| Digest + next import | |
