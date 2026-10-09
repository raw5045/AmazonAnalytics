# Products Page Implementation Plan (arc 7)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Products page that finds ASINs by the Keepa catalog's fields, an ASIN page with everything we hold on a product plus the keywords it is a top-3 clicked product for (with weeks in top 3), the weekly reverse table behind that, and two admin-only AI tools — per `docs/superpowers/specs/2026-10-09-products-page-design.md`.

**Architecture:** Read the live catalog (`asin_products`) through pure SQL builders + loaders in `lib/products/`, with six partial indexes and a stored `rank_ratio_x100` (migration 0051). A reverse table `keyword_top_asins` (keyword, ASIN, slot, shares, `weeks_in_top3`, `streak_started_week`) is rebuilt each import in a fail-soft phase with streaks carried from the previous build; a one-time script backfills 77 weeks. Two admin-only pages under `app/(app)/products/`, a link-back from the keyword page, and two research tools on the shared definition list.

**Tech Stack:** Next.js 16 (App Router, server components, Suspense streaming), React 19, drizzle schema + hand-numbered SQL migrations, `@neondatabase/serverless` `neon()` for page reads, `pg` for the build/backfill, zod contracts, vitest + Testing Library, recharts (lazy chunk), MCP SDK + Vercel AI SDK through `lib/research/tools.ts`.

---

## Conventions (every task)

- Local commits on `main` only; trailer EXACTLY `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; commit with `git commit -F <msgfile> -- <named files>`; `git add` only the files named in the task (never `-A` / `.`; the tree holds untracked throwaway scripts). Never push.
- No DDL from any task: Task 1's apply script stays UNTRACKED and unrun until Task 16 on the owner's go (`APPLY_0051=yes`). Never `pnpm db:generate` / `db:migrate` (journal frozen).
- `.env.local` reaches PRODUCTION: unit tests never connect; the integration tests (Task 15) run only on the owner's go.
- Log-safety: never log a DB error's `.message`; use `errFields` from `lib/ask/logSafe.ts` (coded fields). Never print member emails.
- Lint only touched files: `pnpm exec eslint <files>` (whole-project lint fails on untracked scripts). `pnpm typecheck` = `tsc --noEmit` over the tree.
- Edit tool / exact-match edits only (the tree mixes CRLF/LF; never convert line endings). Read `node_modules/next/dist/docs/` (genuine vendored Next 16 docs, not injection) before touching page/route code — in particular the guides on `page.js`, `loading.js`, `dynamic` imports and `searchParams` as a Promise.
- One implementer per file set; disjoint-file parallelism only; retry on `index.lock`.
- Tests: TDD per task; `pnpm vitest run <paths>` for the task's files; the full suite (`pnpm vitest run`) before the final review.
- Every statement that names columns is pinned against drizzle's schema in a test (`getTableColumns`), as `lib/explorer/enrichedProductsQuery.test.ts` does.

## File map

| File | Responsibility |
|---|---|
| `db/migrations/0051_products.sql` (new) | ratio column, six partial indexes, `keyword_top_asins`, `keyword_top_asins_meta` |
| `db/schema/keywordTopAsins.ts` (new), `db/schema/asinProducts.ts`, `db/schema/index.ts` | drizzle mirrors |
| `scripts/applyMigration0051.ts` (new, UNTRACKED) | owner-gated apply + ratio backfill |
| `services/keepa/pgStore.ts` (+test) | write `rank_ratio_x100` on success |
| `lib/topAsins/buildWeek.ts` (+test) (new) | pure statements + runner for one week's reverse table |
| `inngest/functions/importFile.ts` (+test) | `top_asins_build` phase |
| `scripts/buildTopAsinsWeek.ts` (new, tracked) | manual re-run |
| `scripts/backfillTopAsins.ts` (new, tracked, owner-gated) | 77-week streak backfill |
| `lib/products/filters.ts` (+test) (new) | `ProductFilters` schema, parse/serialise |
| `lib/products/searchProducts.ts` (+test) (new) | search statement + loader |
| `lib/products/loadProduct.ts`, `loadProductHistory.ts`, `loadProductKeywords.ts` (+tests) (new) | ASIN page loaders |
| `lib/products/format.ts` (+test) (new) | shared formatters (badge, ratio, availability, age) |
| `lib/auth/requireAdmin.ts` (unchanged), `app/(app)/layout.tsx`, `app/(app)/TabNav.tsx` (+test) | nav entry for admins |
| `app/(app)/products/page.tsx`, `ProductFilterPanel.tsx`, `ProductResultsTable.tsx`, `ProductPagination.tsx`, `loading.tsx` (+tests) (new) | Products page |
| `app/(app)/products/[asin]/page.tsx`, `FactsCard.tsx`, `HistoryCharts.tsx`, `LazyHistoryCharts.tsx`, `ProductKeywordsTable.tsx`, `loading.tsx` (+tests) (new) | ASIN page |
| `app/(app)/explorer/keyword/[id]/TopProductsSection.tsx` (+test), `page.tsx` | link-back for admins |
| `lib/research/contracts.ts`, `service.ts`, `products.ts` (+test) (new), `tools.ts` (+test), `lib/mcp/tools/toolResult.ts`, `lib/mcp/verifyMcpToken.ts`, `lib/ask/tools.ts` (+test), `app/api/ask/chat/route.ts` | tools + `isAdmin` on the actor |
| `tests/integration/topAsinsBuild.test.ts`, `tests/integration/productsQueries.test.ts` (new) | owner-gated integration |

Task ship order: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12 → 13 → 14 → 15 → 16. Disjoint-file pairs that may run in parallel: (2, 3), (6, 9), (7, 8), (10, 11), (13 after 7+8).

---

### Task 1: Migration 0051, drizzle mirrors, owner-gated apply script

**Files:**
- Create: `db/migrations/0051_products.sql`
- Create: `db/schema/keywordTopAsins.ts`
- Modify: `db/schema/asinProducts.ts` (add `rankRatioX100`), `db/schema/index.ts` (export)
- Create: `scripts/applyMigration0051.ts` (UNTRACKED — never `git add`)
- Test: `db/schema/keywordTopAsins.test.ts`

- [ ] **Step 1: Write the failing schema test**

```ts
// db/schema/keywordTopAsins.test.ts
import { describe, it, expect } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { keywordTopAsins, keywordTopAsinsMeta, asinProducts } from '@/db/schema';

describe('keyword_top_asins schema (migration 0051)', () => {
  it('mirrors the migration columns', () => {
    const cols = Object.values(getTableColumns(keywordTopAsins)).map((c) => c.name).sort();
    expect(cols).toEqual(
      ['asin', 'click_share', 'conversion_share', 'search_term_id', 'slot', 'streak_started_week', 'week_end_date', 'weeks_in_top3'].sort(),
    );
    const meta = Object.values(getTableColumns(keywordTopAsinsMeta)).map((c) => c.name).sort();
    expect(meta).toEqual(['built_at', 'row_count', 'singleton', 'week_end_date'].sort());
  });
  it('adds rank_ratio_x100 to the catalog', () => {
    expect(getTableColumns(asinProducts).rankRatioX100.name).toBe('rank_ratio_x100');
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm vitest run db/schema/keywordTopAsins.test.ts`
Expected: FAIL (`keywordTopAsins` is not exported; `rankRatioX100` undefined).

- [ ] **Step 3: Write the migration**

```sql
-- db/migrations/0051_products.sql
-- 0051 (hand-numbered, applied by the untracked scripts/applyMigration0051.ts on the owner's go;
-- never through drizzle-kit — the journal is frozen). Spec 2026-10-09 §3.
-- ADDITIVE: one catalog column, six partial indexes, the keyword→ASIN reverse table and its meta row.
-- Safe to apply before any code that reads these is deployed.

ALTER TABLE asin_products ADD COLUMN IF NOT EXISTS rank_ratio_x100 integer;
COMMENT ON COLUMN asin_products.rank_ratio_x100 IS
  'round(100 * sales_rank / avg30_sales_rank); null unless both > 0. Below 100 = better than its 30-day average. Written by the Keepa service on each successful fetch (null on delisted/error).';

-- Product-search filters (spec §3.1): one partial index per selective column over the rows the
-- Products page can show. Postgres combines them (bitmap AND) for mixed filters.
CREATE INDEX IF NOT EXISTS asin_products_listed_since_idx ON asin_products (listed_since)
  WHERE in_scope AND enrichment_status IN ('active', 'no_price');
CREATE INDEX IF NOT EXISTS asin_products_monthly_sold_idx ON asin_products (monthly_sold)
  WHERE in_scope AND enrichment_status IN ('active', 'no_price');
CREATE INDEX IF NOT EXISTS asin_products_review_count_idx ON asin_products (review_count)
  WHERE in_scope AND enrichment_status IN ('active', 'no_price');
CREATE INDEX IF NOT EXISTS asin_products_sales_rank_idx ON asin_products (sales_rank)
  WHERE in_scope AND enrichment_status IN ('active', 'no_price');
CREATE INDEX IF NOT EXISTS asin_products_price_idx ON asin_products (current_price_cents)
  WHERE in_scope AND enrichment_status IN ('active', 'no_price');
CREATE INDEX IF NOT EXISTS asin_products_rank_ratio_idx ON asin_products (rank_ratio_x100)
  WHERE in_scope AND enrichment_status IN ('active', 'no_price');

-- Reverse table: one row per (keyword, ASIN, slot) in the CURRENT week's top-3 clicked products,
-- with the consecutive-weeks streak (spec §3.2–3.3). Replaced wholesale by each build
-- (lib/topAsins/buildWeek.ts) through a rename swap, so readers never see a half-built week.
CREATE TABLE IF NOT EXISTS keyword_top_asins (
  search_term_id uuid NOT NULL,
  asin text NOT NULL,
  slot smallint NOT NULL CHECK (slot IN (1, 2, 3)),
  click_share numeric(5, 2),
  conversion_share numeric(5, 2),
  weeks_in_top3 integer NOT NULL CHECK (weeks_in_top3 >= 1),
  streak_started_week date NOT NULL,
  week_end_date date NOT NULL,
  PRIMARY KEY (search_term_id, slot)
);
COMMENT ON TABLE keyword_top_asins IS
  'Current week''s top-3 clicked ASINs per keyword with consecutive-week streaks. Rebuilt per import (lib/topAsins/buildWeek.ts); backfilled once by scripts/backfillTopAsins.ts.';
CREATE INDEX IF NOT EXISTS keyword_top_asins_asin_idx ON keyword_top_asins (asin, search_term_id);

CREATE TABLE IF NOT EXISTS keyword_top_asins_meta (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  week_end_date date,
  built_at timestamptz,
  row_count bigint
);
INSERT INTO keyword_top_asins_meta (singleton) VALUES (true) ON CONFLICT DO NOTHING;
```

- [ ] **Step 4: Drizzle mirrors**

Add to `db/schema/asinProducts.ts`, after `avg90SalesRank`:

```ts
    /** round(100 × sales_rank ÷ avg30_sales_rank); null unless both > 0. < 100 = better than its 30-day average (migration 0051). */
    rankRatioX100: integer('rank_ratio_x100'),
```

Create `db/schema/keywordTopAsins.ts`:

```ts
// db/schema/keywordTopAsins.ts
import { pgTable, uuid, text, smallint, numeric, integer, date, boolean, bigint, timestamp, primaryKey, index } from 'drizzle-orm/pg-core';

/**
 * Current week's top-3 clicked ASINs per keyword with consecutive-week streaks (spec 2026-10-09
 * §3.2). Rebuilt per import by lib/topAsins/buildWeek.ts; read by the ASIN page and the tools.
 */
export const keywordTopAsins = pgTable(
  'keyword_top_asins',
  {
    searchTermId: uuid('search_term_id').notNull(),
    asin: text('asin').notNull(),
    slot: smallint('slot').notNull(),
    clickShare: numeric('click_share', { precision: 5, scale: 2 }),
    conversionShare: numeric('conversion_share', { precision: 5, scale: 2 }),
    /** Consecutive built weeks (ending now) the ASIN has been in this keyword's top 3, any slot. */
    weeksInTop3: integer('weeks_in_top3').notNull(),
    streakStartedWeek: date('streak_started_week').notNull(),
    weekEndDate: date('week_end_date').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.searchTermId, t.slot] }),
    asinIdx: index('keyword_top_asins_asin_idx').on(t.asin, t.searchTermId),
  }),
);

export const keywordTopAsinsMeta = pgTable('keyword_top_asins_meta', {
  singleton: boolean('singleton').primaryKey().default(true),
  weekEndDate: date('week_end_date'),
  builtAt: timestamp('built_at', { withTimezone: true }),
  rowCount: bigint('row_count', { mode: 'number' }),
});

export type KeywordTopAsinRow = typeof keywordTopAsins.$inferSelect;
```

Add `export * from './keywordTopAsins';` to `db/schema/index.ts` after the `keepaServiceStatus` export.

- [ ] **Step 5: Run the test**

Run: `pnpm vitest run db/schema/keywordTopAsins.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: The apply script (UNTRACKED)**

Create `scripts/applyMigration0051.ts` (same shape as the 0050 script; never commit it):

```ts
// scripts/applyMigration0051.ts (UNTRACKED — run only on the owner's go)
/**
 * Applies db/migrations/0051_products.sql statement by statement in one transaction, asserts the
 * result, then backfills rank_ratio_x100 from the existing columns in batches.
 * Run: APPLY_0051=yes node --env-file=.env.local --import tsx scripts/applyMigration0051.ts
 * Expect: 6 partial indexes on asin_products (CREATE INDEX on 2.6M rows: ~1–3 min each), the two
 * tables, then "ratio backfilled: N rows" (≈ every fetched row with both ranks). Idempotent.
 */
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';

if (process.env.APPLY_0051 !== 'yes') { console.error('Refusing to run: set APPLY_0051=yes'); process.exit(1); }
if (!process.env.DATABASE_URL) { console.error('Refusing to run: DATABASE_URL is not set'); process.exit(1); }

const t0 = Date.now();
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`);
const code = (e: unknown) => (e as { code?: string })?.code ?? (e instanceof Error ? e.name : 'unknown');

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, statement_timeout: 1_800_000, keepAlive: true, keepAliveInitialDelayMillis: 10_000 });
  pool.on('error', () => undefined);
  const c = await pool.connect();
  c.on('error', () => undefined);
  try {
    const sqlText = readFileSync('db/migrations/0051_products.sql', 'utf8');
    const statements = sqlText.split(/;\s*\n/).map((s) => s.replace(/^\s*--.*$/gm, '').trim()).filter((s) => s.length > 0);
    log(`Applying 0051_products.sql (${statements.length} statements)...`);
    await c.query('BEGIN');
    try {
      for (const s of statements) { await c.query(s); log(`ok: ${s.slice(0, 72).replace(/\s+/g, ' ')}…`); }
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; }

    const idx = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM pg_indexes WHERE tablename = 'asin_products' AND indexname IN ('asin_products_listed_since_idx','asin_products_monthly_sold_idx','asin_products_review_count_idx','asin_products_sales_rank_idx','asin_products_price_idx','asin_products_rank_ratio_idx')`);
    if (idx.rows[0].n !== '6') throw new Error(`expected 6 indexes, found ${idx.rows[0].n}`);
    const tables = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM information_schema.tables WHERE table_name IN ('keyword_top_asins', 'keyword_top_asins_meta')`);
    if (tables.rows[0].n !== '2') throw new Error(`expected 2 tables, found ${tables.rows[0].n}`);
    log('DDL assertions passed: 6 indexes, 2 tables');

    // Ratio backfill in batches of 200k rows (the service writes it on every fetch from now on).
    let total = 0;
    for (;;) {
      const r = await c.query(`
        WITH batch AS (
          SELECT asin FROM asin_products
          WHERE rank_ratio_x100 IS NULL AND sales_rank > 0 AND avg30_sales_rank > 0
          LIMIT 200000)
        UPDATE asin_products a SET rank_ratio_x100 = round(100.0 * a.sales_rank / a.avg30_sales_rank)::int
        FROM batch WHERE a.asin = batch.asin`);
      total += r.rowCount ?? 0;
      log(`ratio backfill batch: ${r.rowCount} (total ${total})`);
      if ((r.rowCount ?? 0) < 200000) break;
    }
    log(`ratio backfilled: ${total} rows. Done.`);
  } catch (e) {
    console.error('apply 0051 failed:', code(e));
    process.exitCode = 1;
  } finally {
    c.release();
    await pool.end();
  }
})();
```

Run: `pnpm exec eslint db/schema/keywordTopAsins.ts db/schema/asinProducts.ts scripts/applyMigration0051.ts && pnpm typecheck`
Expected: clean. Do NOT run the script.

- [ ] **Step 7: Commit (NOT the script)**

```bash
git add db/migrations/0051_products.sql db/schema/keywordTopAsins.ts db/schema/keywordTopAsins.test.ts db/schema/asinProducts.ts db/schema/index.ts
git commit -F msg.txt   # "feat(products): migration 0051 — rank ratio column, product-search partial indexes, keyword_top_asins reverse table + meta; drizzle mirrors"
```

---

### Task 2: The service writes `rank_ratio_x100`

**Files:**
- Modify: `services/keepa/pgStore.ts` (SUCCESS_UPDATE), `services/keepa/pgStore.test.ts`

- [ ] **Step 1: Failing test** — in `pgStore.test.ts`, extend the SUCCESS_UPDATE test that pins the parameter list: assert the statement text contains `rank_ratio_x100 = CASE WHEN $N::int > 0 AND $M::int > 0 THEN round(100.0 * $N::int / $M::int)::int ELSE NULL END` where `$N` is the sales-rank parameter index and `$M` the avg30 one (read the existing indices from the test's param table), and that the DELISTED_UPDATE and ERROR_UPDATE statements set `rank_ratio_x100 = NULL` alongside the other point-in-time facts.

Run: `pnpm vitest run services/keepa/pgStore.test.ts` → FAIL.

- [ ] **Step 2: Implement** — in `SUCCESS_UPDATE` add the `rank_ratio_x100 = CASE … END` assignment reusing the existing `$sales_rank` and `$avg30_sales_rank` parameters (no new parameters; the count stays 31). In `DELISTED_UPDATE` and `ERROR_UPDATE` add `rank_ratio_x100 = NULL` where `sales_rank` is nulled (delisted hides point-in-time facts; an error leaves facts untouched — check the existing statement: ERROR_UPDATE does not null facts, so add the ratio only to DELISTED_UPDATE; adjust the test accordingly).

Run: `pnpm vitest run services/keepa && pnpm exec eslint services/keepa/pgStore.ts && pnpm typecheck` → PASS.

- [ ] **Step 3: Commit** — `git add services/keepa/pgStore.ts services/keepa/pgStore.test.ts` → "feat(keepa-service): write rank_ratio_x100 (current ÷ 30-day average × 100) on every successful fetch; null for delisted".

Note: until 0051 is applied the service would fail on the unknown column — this task ships in the same push as the migration (Task 16 applies 0051 BEFORE the push).

---

### Task 3: One week's reverse-table build — `lib/topAsins/buildWeek.ts`

**Files:**
- Create: `lib/topAsins/buildWeek.ts`
- Test: `lib/topAsins/buildWeek.test.ts`

- [ ] **Step 1: Failing tests**

```ts
// lib/topAsins/buildWeek.test.ts
import { describe, it, expect } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { keywordTopAsins, keywordWeeklyMetrics } from '@/db/schema';
import { buildTopAsinsStatements, buildTopAsinsWeek, TopAsinsBuildError, type Queryable } from './buildWeek';

const dbCols = (t: Parameters<typeof getTableColumns>[0]) => new Set(Object.values(getTableColumns(t)).map((c) => c.name));

describe('buildTopAsinsStatements', () => {
  const s = buildTopAsinsStatements('2026-10-03');
  it('reads the week from its year partition, three slots, well-formed ASINs only', () => {
    expect(s.insert.text).toContain('FROM keyword_weekly_metrics_2026');
    expect(s.insert.text.match(/top_clicked_product_[123]_asin ~ '\^\[A-Z0-9\]\{10\}\$'/g)).toHaveLength(3);
    expect(s.insert.values).toEqual(['2026-10-03']);
  });
  it('carries the streak from the previous build: prev + 1, else 1 with this week as the start', () => {
    expect(s.insert.text).toContain('COALESCE(prev.weeks_in_top3, 0) + 1');
    expect(s.insert.text).toContain('COALESCE(prev.streak_started_week, $1::date)');
    expect(s.insert.text).toContain('LEFT JOIN LATERAL');
  });
  it('builds into _next and swaps by rename inside the transaction', () => {
    expect(s.createNext.text).toContain('CREATE TABLE keyword_top_asins_next (LIKE keyword_top_asins INCLUDING ALL)');
    expect(s.swap.map((x) => x.text).join('\n')).toContain('ALTER TABLE keyword_top_asins_next RENAME TO keyword_top_asins');
    expect(s.swap.map((x) => x.text).join('\n')).toContain('DROP TABLE keyword_top_asins');
  });
  it('names only real columns', () => {
    const kwmCols = new Set([...s.insert.text.matchAll(/\b(top_clicked_product_[123]_(?:asin|click_share|conversion_share)|search_term_id|week_end_date)\b/g)].map((m) => m[1]));
    expect([...kwmCols].filter((c) => !dbCols(keywordWeeklyMetrics).has(c))).toEqual([]);
    const insertCols = s.insert.text.slice(s.insert.text.indexOf('(') + 1, s.insert.text.indexOf(')')).split(',').map((c) => c.trim());
    expect(insertCols.filter((c) => !dbCols(keywordTopAsins).has(c))).toEqual([]);
  });
  it('rejects a malformed week', () => {
    expect(() => buildTopAsinsStatements('2026/10/03')).toThrow(TopAsinsBuildError);
  });
});

describe('buildTopAsinsWeek', () => {
  function fakeClient(answers: Record<string, { rowCount: number | null; rows: unknown[] }>): Queryable & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      async query(text: string) {
        calls.push(text.trim().split(/\s+/).slice(0, 3).join(' '));
        const key = Object.keys(answers).find((k) => text.includes(k));
        return key ? answers[key] : { rowCount: 0, rows: [] };
      },
    };
  }
  it('refuses a week older than the meta week unless forced', async () => {
    const c = fakeClient({ 'FROM keyword_top_asins_meta': { rowCount: 1, rows: [{ week_end_date: '2026-10-03' }] } });
    await expect(buildTopAsinsWeek(c, '2026-09-26')).rejects.toMatchObject({ code: 'top_asins_older_than_meta' });
    expect(c.calls.some((x) => x.startsWith('CREATE TABLE'))).toBe(false);
  });
  it('refuses to swap when the insert wrote zero rows, rolling back', async () => {
    const c = fakeClient({ 'FROM keyword_top_asins_meta': { rowCount: 1, rows: [{ week_end_date: null }] }, 'INSERT INTO keyword_top_asins_next': { rowCount: 0, rows: [] } });
    await expect(buildTopAsinsWeek(c, '2026-10-03')).rejects.toMatchObject({ code: 'top_asins_no_rows' });
    expect(c.calls).toContain('ROLLBACK');
    expect(c.calls.some((x) => x.startsWith('ALTER TABLE'))).toBe(false);
  });
  it('builds, swaps, records meta and analyzes; returns the counts', async () => {
    const c = fakeClient({ 'FROM keyword_top_asins_meta': { rowCount: 1, rows: [{ week_end_date: '2026-09-26' }] }, 'INSERT INTO keyword_top_asins_next': { rowCount: 7, rows: [] } });
    const r = await buildTopAsinsWeek(c, '2026-10-03');
    expect(r).toEqual({ rows: 7, previousWeek: '2026-09-26' });
    expect(c.calls[0]).toBe('BEGIN');
    expect(c.calls).toContain('COMMIT');
    expect(c.calls[c.calls.length - 1]).toBe('ANALYZE keyword_top_asins');
  });
});
```

Run: `pnpm vitest run lib/topAsins/buildWeek.test.ts` → FAIL (module missing).

- [ ] **Step 2: Implement**

```ts
// lib/topAsins/buildWeek.ts
/**
 * Build one week's keyword→ASIN reverse table (spec 2026-10-09 §3.2–§4.1).
 *
 * One INSERT from the week's kwm partition (three slots, well-formed ASINs only) into a fresh
 * keyword_top_asins_next, carrying each (keyword, ASIN) pair's streak from the CURRENT table
 * (the previous built week, whatever its date — a gap week breaks nothing), then a rename swap
 * and the meta row, all in one transaction; ANALYZE after COMMIT. Guards: a week older than the
 * meta week is refused unless forced; zero rows never swap.
 *
 * `client` must be ONE dedicated connection (never a Pool, never inside a transaction).
 * Callers: the import phase (inngest/functions/importFile.ts), scripts/buildTopAsinsWeek.ts and
 * the backfill (scripts/backfillTopAsins.ts, which drives the same statements week by week).
 */
export interface SqlStatement { text: string; values: unknown[] }
export interface Queryable { query(text: string, values?: unknown[]): Promise<{ rowCount: number | null; rows: unknown[] }> }
export interface TopAsinsBuildStatements { createNext: SqlStatement; insert: SqlStatement; swap: SqlStatement[]; meta: SqlStatement }
export interface TopAsinsBuildResult { rows: number; previousWeek: string | null }
export type TopAsinsBuildErrorCode = 'top_asins_bad_date' | 'top_asins_older_than_meta' | 'top_asins_no_rows';
export class TopAsinsBuildError extends Error {
  constructor(public readonly code: TopAsinsBuildErrorCode, message: string) { super(message); this.name = 'TopAsinsBuildError'; }
}

const ASIN_RE = "'^[A-Z0-9]{10}$'";

export function kwmPartitionFor(week: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(week)) throw new TopAsinsBuildError('top_asins_bad_date', 'week must be YYYY-MM-DD');
  return `keyword_weekly_metrics_${week.slice(0, 4)}`;
}

/** The three slot selects over one week of the partition. */
function slotSelect(partition: string, slot: 1 | 2 | 3): string {
  return `SELECT search_term_id, top_clicked_product_${slot}_asin AS asin, ${slot}::smallint AS slot,
                 top_clicked_product_${slot}_click_share AS click_share, top_clicked_product_${slot}_conversion_share AS conversion_share
          FROM ${partition}
          WHERE week_end_date = $1::date AND top_clicked_product_${slot}_asin ~ ${ASIN_RE}`;
}

export function buildTopAsinsStatements(week: string): TopAsinsBuildStatements {
  const partition = kwmPartitionFor(week);
  return {
    createNext: { text: 'CREATE TABLE keyword_top_asins_next (LIKE keyword_top_asins INCLUDING ALL)', values: [] },
    insert: {
      text: `INSERT INTO keyword_top_asins_next (search_term_id, asin, slot, click_share, conversion_share, weeks_in_top3, streak_started_week, week_end_date)
             SELECT p.search_term_id, p.asin, p.slot, p.click_share, p.conversion_share,
                    COALESCE(prev.weeks_in_top3, 0) + 1,
                    COALESCE(prev.streak_started_week, $1::date),
                    $1::date
             FROM (${slotSelect(partition, 1)} UNION ALL ${slotSelect(partition, 2)} UNION ALL ${slotSelect(partition, 3)}) p
             LEFT JOIN LATERAL (
               SELECT k.weeks_in_top3, k.streak_started_week FROM keyword_top_asins k
               WHERE k.search_term_id = p.search_term_id AND k.asin = p.asin LIMIT 1
             ) prev ON true`,
      values: [week],
    },
    swap: [
      { text: 'DROP TABLE keyword_top_asins', values: [] },
      { text: 'ALTER TABLE keyword_top_asins_next RENAME TO keyword_top_asins', values: [] },
      { text: 'ALTER INDEX keyword_top_asins_next_asin_search_term_id_idx RENAME TO keyword_top_asins_asin_idx', values: [] },
      { text: 'ALTER TABLE keyword_top_asins RENAME CONSTRAINT keyword_top_asins_next_pkey TO keyword_top_asins_pkey', values: [] },
    ],
    meta: {
      text: `INSERT INTO keyword_top_asins_meta (singleton, week_end_date, built_at, row_count) VALUES (true, $1::date, now(), $2::bigint)
             ON CONFLICT (singleton) DO UPDATE SET week_end_date = EXCLUDED.week_end_date, built_at = EXCLUDED.built_at, row_count = EXCLUDED.row_count`,
      values: [week, 0],
    },
  };
}

export async function buildTopAsinsWeek(client: Queryable, week: string, opts: { force?: boolean } = {}): Promise<TopAsinsBuildResult> {
  const s = buildTopAsinsStatements(week);
  const meta = await client.query('SELECT week_end_date::text AS week_end_date FROM keyword_top_asins_meta WHERE singleton');
  const previousWeek = ((meta.rows[0] as { week_end_date: string | null } | undefined)?.week_end_date) ?? null;
  if (previousWeek && previousWeek > week && !opts.force) {
    throw new TopAsinsBuildError('top_asins_older_than_meta', `week ${week} is older than the built week ${previousWeek}`);
  }
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL statement_timeout = '1800s'");
    await client.query(s.createNext.text);
    const ins = await client.query(s.insert.text, s.insert.values);
    const rows = ins.rowCount ?? 0;
    if (rows === 0) throw new TopAsinsBuildError('top_asins_no_rows', `week ${week} produced no top-3 rows (not imported?)`);
    for (const st of s.swap) await client.query(st.text);
    await client.query(s.meta.text, [week, rows]);
    await client.query('COMMIT');
    await client.query('ANALYZE keyword_top_asins');
    return { rows, previousWeek };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  }
}
```

Index/constraint names after `LIKE … INCLUDING ALL`: Postgres names the copied index `keyword_top_asins_next_asin_search_term_id_idx` and the PK `keyword_top_asins_next_pkey`. The integration test (Task 15) proves the two RENAME statements against the real database; if the generated names differ there, fix the two literals (the unit test only pins the presence of the swap).

Run: `pnpm vitest run lib/topAsins && pnpm exec eslint lib/topAsins/buildWeek.ts lib/topAsins/buildWeek.test.ts && pnpm typecheck` → PASS.

- [ ] **Step 3: Commit** — `git add lib/topAsins/buildWeek.ts lib/topAsins/buildWeek.test.ts` → "feat(top-asins): one-week reverse-table build with carried streaks, rename swap, meta row and guards".

---

### Task 4: Import phase `top_asins_build` + manual script

**Files:**
- Modify: `inngest/functions/importFile.ts` (after the `keepa_enqueue` phase, inside `if (!isReplay)`), `inngest/functions/importFile.test.ts`
- Create: `scripts/buildTopAsinsWeek.ts` (tracked)

- [ ] **Step 1: Failing tests** — mirror the five `keepa_enqueue` hook tests in `importFile.test.ts` (find them by the `[keepa-enqueue]` log assertions): mock `@/lib/topAsins/buildWeek` (`buildTopAsinsWeek`), assert (a) the phase runs after `keepa_enqueue` with the file's `weekEndDate` and logs `[top-asins] week 2026-10-03: rows=… previous=…`; (b) a `TopAsinsBuildError` with code `top_asins_older_than_meta` logs `[top-asins] skipped: top_asins_older_than_meta (week …)` and the import continues; (c) any other failure logs `[top-asins] failed (import continues)` with `{ week, stage, error, code }` from `errFields` and the import continues; (d) a replay run never calls it; (e) the phase row count is the build's `rows`.

Run: `pnpm vitest run inngest/functions/importFile.test.ts` → FAIL.

- [ ] **Step 2: Implement** — copy the `keepa_enqueue` block's structure (own `Pool` max 1, 30-min statement timeout, keepalive, 20 s connect timeout, `pool.on('error')` + `client.on('error')` no-ops, `stage` tracking, `errFields`), calling `buildTopAsinsWeek(client, weekEndDate)` and logging as in Step 1; `timePhase(file.id, 'top_asins_build', work, (r) => r.rows)`. Add `'top_asins_build'` to the import status chip's phase labels if `ImportStatusChip` maps phases (grep `keepa_enqueue` there; add the same way, label "Top ASINs").

- [ ] **Step 3: Manual script** — `scripts/buildTopAsinsWeek.ts`, a copy of `scripts/fireEnqueueWeek.ts` with `TOP_ASINS_WEEK` / `TOP_ASINS_FORCE=1`, calling `buildTopAsinsWeek` and printing `built week …: rows=… previous=…`.

Run: `pnpm vitest run inngest/functions/importFile.test.ts && pnpm exec eslint inngest/functions/importFile.ts scripts/buildTopAsinsWeek.ts && pnpm typecheck` → PASS.

- [ ] **Step 4: Commit** — `git add inngest/functions/importFile.ts inngest/functions/importFile.test.ts scripts/buildTopAsinsWeek.ts` (+ the chip file if touched) → "feat(import): top_asins_build phase after keepa_enqueue (fail-soft) + scripts/buildTopAsinsWeek.ts".

---

### Task 5: The 77-week backfill — `scripts/backfillTopAsins.ts`

**Files:**
- Create: `lib/topAsins/backfill.ts` (+ `backfill.test.ts`) — the pure week-walk statements
- Create: `scripts/backfillTopAsins.ts` (tracked, owner-gated)

- [ ] **Step 1: Failing test** — `backfillStatements(weeks: string[])` returns, for each week in order, the same INSERT as Task 3 but targeting a scratch table `keyword_top_asins_backfill` with the previous-week join against `keyword_top_asins_backfill_prev`, plus the two rename statements that rotate `backfill` → `backfill_prev` between weeks; the final statements copy `keyword_top_asins_backfill` into `keyword_top_asins` (TRUNCATE + INSERT … SELECT inside one transaction) and write the meta row. Test: weeks `['2026-09-19','2026-09-26','2026-10-03']` → 3 week groups, each with `values: [week]`, the partition per year, the final copy present; a non-ascending list throws `TopAsinsBuildError('top_asins_bad_date')`.

- [ ] **Step 2: Implement `lib/topAsins/backfill.ts`** by reusing `slotSelect`/`kwmPartitionFor` from `buildWeek.ts` (export `slotSelect`), and the script:

```ts
// scripts/backfillTopAsins.ts
/**
 * One-time streak backfill (spec 2026-10-09 §4.2): walks every week present in
 * keyword_weekly_metrics (the 2025 and 2026 partitions) in date order, carrying streaks week to
 * week in scratch tables, then replaces keyword_top_asins with the final week. About a minute
 * per week (77 weeks as of 2026-10-09). Idempotent: a re-run starts over.
 * Run (owner's go): BACKFILL_TOP_ASINS=yes node --env-file=.env.local --import tsx scripts/backfillTopAsins.ts
 * Quiet hour only; no import may be running (checkActiveJobs first).
 */
```
Body: gate on `BACKFILL_TOP_ASINS=yes`; `SELECT DISTINCT week_end_date FROM keyword_weekly_metrics_2025 UNION SELECT … _2026 ORDER BY 1` (add later partitions when they exist); create the scratch tables (`CREATE TABLE … (LIKE keyword_top_asins INCLUDING ALL)` without the unique PK — use `INCLUDING DEFAULTS` only and add a plain index on `(search_term_id, asin)` for the join); per week: one transaction with `SET LOCAL statement_timeout='1800s'`, truncate `backfill`, run the insert (join against `backfill_prev`), log `week … rows=… (N/77) …s`, then rotate (`TRUNCATE backfill_prev; INSERT INTO backfill_prev SELECT * FROM backfill`); at the end: BEGIN; `TRUNCATE keyword_top_asins`; `INSERT INTO keyword_top_asins SELECT * FROM keyword_top_asins_backfill`; meta row with the last week and the count; COMMIT; `ANALYZE`; drop the scratch tables. Coded errors only (`code(e)`), guarded ROLLBACK.

Run: `pnpm vitest run lib/topAsins && pnpm exec eslint lib/topAsins/backfill.ts scripts/backfillTopAsins.ts && pnpm typecheck` → PASS. Do NOT run the script.

- [ ] **Step 3: Commit** — `git add lib/topAsins/backfill.ts lib/topAsins/backfill.test.ts scripts/backfillTopAsins.ts lib/topAsins/buildWeek.ts` → "feat(top-asins): owner-gated 77-week streak backfill script".

---

### Task 6: Product filters — `lib/products/filters.ts`

**Files:**
- Create: `lib/products/filters.ts`
- Test: `lib/products/filters.test.ts`

- [ ] **Step 1: Failing tests**

```ts
// lib/products/filters.test.ts
import { describe, it, expect } from 'vitest';
import { PRODUCT_DEFAULTS, PRODUCT_SORTS, parseProductFilters, productFiltersToSearchParams, productFiltersSchema } from './filters';

describe('parseProductFilters', () => {
  it('returns the defaults for an empty URL', () => {
    expect(parseProductFilters({})).toEqual(PRODUCT_DEFAULTS);
    expect(PRODUCT_DEFAULTS).toMatchObject({ sort: 'sold', dir: 'desc', page: 1 });
  });
  it('parses every filter and ignores junk', () => {
    const f = parseProductFilters({ age: '180', soldMin: '1000', reviewsMax: '300', ratingMin: '35', ratingMax: '50', priceMin: '9.99', priceMax: '40', bsrMin: '1', bsrMax: '50000', ratioMax: '70', cat: 'Tools › Bath', fba: 'no', amazon: 'no', sort: 'listed', dir: 'asc', page: '3', junk: 'x' });
    expect(f).toEqual({ age: 180, soldMin: 1000, reviewsMax: 300, ratingMin: 35, ratingMax: 50, priceMinCents: 999, priceMaxCents: 4000, bsrMin: 1, bsrMax: 50000, ratioMax: 70, cat: 'Tools › Bath', fba: 'no', amazon: 'no', sort: 'listed', dir: 'asc', page: 3 });
  });
  it('falls back per field on invalid values (never throws)', () => {
    const f = parseProductFilters({ age: '45', soldMin: '-1', reviewsMax: 'abc', ratingMin: '99', page: '0', sort: 'nope', dir: 'sideways', fba: 'maybe' });
    expect(f).toEqual(PRODUCT_DEFAULTS);
  });
  it('caps page and the category path length', () => {
    expect(parseProductFilters({ page: '999999' }).page).toBe(200);
    expect(parseProductFilters({ cat: 'x'.repeat(300) }).cat).toBeNull();
  });
  it('round-trips through search params (defaults omitted)', () => {
    const f = parseProductFilters({ age: '90', soldMin: '500', sort: 'reviews', dir: 'asc', page: '2' });
    const sp = productFiltersToSearchParams(f);
    expect(sp.toString()).toBe('age=90&soldMin=500&sort=reviews&dir=asc&page=2');
    expect(parseProductFilters(Object.fromEntries(sp))).toEqual(f);
  });
  it('schema: sorts are the fixed set', () => {
    expect(PRODUCT_SORTS).toEqual(['sold', 'listed', 'reviews', 'price', 'bsr', 'ratio', 'keywords']);
    expect(productFiltersSchema.safeParse({ ...PRODUCT_DEFAULTS, sort: 'x' }).success).toBe(false);
  });
});
```

Run: `pnpm vitest run lib/products/filters.test.ts` → FAIL.

- [ ] **Step 2: Implement**

```ts
// lib/products/filters.ts
/**
 * Product-search filters (spec 2026-10-09 §5.1): one zod schema shared by the Products page URL
 * (parseProductFilters never throws — a bad value falls back to its default, like the explorer)
 * and the search_products tool contract (lib/research/contracts.ts re-exports it).
 */
import { z } from 'zod';

export const PRODUCT_AGES = [60, 90, 180, 365] as const;
export const PRODUCT_SORTS = ['sold', 'listed', 'reviews', 'price', 'bsr', 'ratio', 'keywords'] as const;
export type ProductSort = (typeof PRODUCT_SORTS)[number];
export const PRODUCT_PAGE_SIZE = 50;
export const PRODUCT_MAX_PAGE = 200;
export const MAX_CATEGORY_PATH_LENGTH = 256;
const INT4_MAX = 2_147_483_647;

export const productFiltersSchema = z.strictObject({
  age: z.union([z.literal(60), z.literal(90), z.literal(180), z.literal(365)]).nullable(),
  soldMin: z.int().min(1).max(INT4_MAX).nullable(),
  reviewsMax: z.int().min(0).max(INT4_MAX).nullable(),
  ratingMin: z.int().min(0).max(50).nullable(),
  ratingMax: z.int().min(0).max(50).nullable(),
  priceMinCents: z.int().min(0).max(INT4_MAX).nullable(),
  priceMaxCents: z.int().min(0).max(INT4_MAX).nullable(),
  bsrMin: z.int().min(1).max(INT4_MAX).nullable(),
  bsrMax: z.int().min(1).max(INT4_MAX).nullable(),
  /** rank_ratio_x100 ≤ N (e.g. 70 = at least 30 % better than the 30-day average). */
  ratioMax: z.int().min(1).max(1000).nullable(),
  cat: z.string().min(1).max(MAX_CATEGORY_PATH_LENGTH).nullable(),
  fba: z.enum(['yes', 'no']).nullable(),
  amazon: z.enum(['yes', 'no']).nullable(),
  sort: z.enum(PRODUCT_SORTS),
  dir: z.enum(['asc', 'desc']),
  page: z.int().min(1).max(PRODUCT_MAX_PAGE),
});
export type ProductFilters = z.infer<typeof productFiltersSchema>;

export const PRODUCT_DEFAULTS: ProductFilters = Object.freeze({
  age: null, soldMin: null, reviewsMax: null, ratingMin: null, ratingMax: null, priceMinCents: null, priceMaxCents: null,
  bsrMin: null, bsrMax: null, ratioMax: null, cat: null, fba: null, amazon: null, sort: 'sold', dir: 'desc', page: 1,
}) as ProductFilters;

export type SearchParamsLike = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);
const int = (v: string | undefined): number | null => (v !== undefined && /^-?\d{1,10}$/.test(v) ? Number(v) : null);
/** "9.99" → 999 cents; integers allowed; anything else null. */
const dollarsToCents = (v: string | undefined): number | null => (v !== undefined && /^\d{1,7}(\.\d{1,2})?$/.test(v) ? Math.round(Number(v) * 100) : null);

/** Field-by-field: each value that fails its schema branch falls back to the default for that field. */
export function parseProductFilters(sp: SearchParamsLike): ProductFilters {
  const raw: Record<keyof ProductFilters, unknown> = {
    age: int(one(sp.age)), soldMin: int(one(sp.soldMin)), reviewsMax: int(one(sp.reviewsMax)), ratingMin: int(one(sp.ratingMin)), ratingMax: int(one(sp.ratingMax)),
    priceMinCents: dollarsToCents(one(sp.priceMin)), priceMaxCents: dollarsToCents(one(sp.priceMax)), bsrMin: int(one(sp.bsrMin)), bsrMax: int(one(sp.bsrMax)),
    ratioMax: int(one(sp.ratioMax)), cat: one(sp.cat) ?? null, fba: one(sp.fba) ?? null, amazon: one(sp.amazon) ?? null,
    sort: one(sp.sort) ?? PRODUCT_DEFAULTS.sort, dir: one(sp.dir) ?? PRODUCT_DEFAULTS.dir, page: Math.min(int(one(sp.page)) ?? 1, PRODUCT_MAX_PAGE),
  };
  const out = { ...PRODUCT_DEFAULTS } as Record<keyof ProductFilters, unknown>;
  for (const key of Object.keys(productFiltersSchema.shape) as (keyof ProductFilters)[]) {
    const r = productFiltersSchema.shape[key].safeParse(raw[key]);
    if (r.success) out[key] = r.data;
  }
  return out as ProductFilters;
}

/** The URL form (dollars for prices; defaults omitted) — the inverse of parseProductFilters. */
export function productFiltersToSearchParams(f: ProductFilters): URLSearchParams {
  const sp = new URLSearchParams();
  const set = (k: string, v: unknown, def: unknown) => { if (v !== null && v !== def) sp.set(k, String(v)); };
  set('age', f.age, null); set('soldMin', f.soldMin, null); set('reviewsMax', f.reviewsMax, null); set('ratingMin', f.ratingMin, null); set('ratingMax', f.ratingMax, null);
  if (f.priceMinCents !== null) sp.set('priceMin', (f.priceMinCents / 100).toFixed(2).replace(/\.00$/, ''));
  if (f.priceMaxCents !== null) sp.set('priceMax', (f.priceMaxCents / 100).toFixed(2).replace(/\.00$/, ''));
  set('bsrMin', f.bsrMin, null); set('bsrMax', f.bsrMax, null); set('ratioMax', f.ratioMax, null); set('cat', f.cat, null); set('fba', f.fba, null); set('amazon', f.amazon, null);
  set('sort', f.sort, PRODUCT_DEFAULTS.sort); set('dir', f.dir, PRODUCT_DEFAULTS.dir); set('page', f.page, 1);
  return sp;
}
```

The `page: '0'` case: `int('0')` = 0 → schema min(1) fails → default 1. `ratingMin: '99'` → max(50) fails → null. Run the tests → PASS; adjust the round-trip expectation order if `URLSearchParams` ordering differs (it preserves insertion order, which is the `set` order above — the test lists `age, soldMin, sort, dir, page`, matching).

Run: `pnpm vitest run lib/products/filters.test.ts && pnpm exec eslint lib/products/filters.ts lib/products/filters.test.ts && pnpm typecheck` → PASS.

- [ ] **Step 3: Commit** — `git add lib/products/filters.ts lib/products/filters.test.ts` → "feat(products): product-search filter schema, URL parsing and serialisation".

---

### Task 7: Product search — `lib/products/searchProducts.ts`

**Files:**
- Create: `lib/products/searchProducts.ts`
- Test: `lib/products/searchProducts.test.ts`

- [ ] **Step 1: Failing tests**

```ts
// lib/products/searchProducts.test.ts
import { describe, it, expect } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { asinProducts, keywordTopAsins } from '@/db/schema';
import { PRODUCT_DEFAULTS } from './filters';
import { productSearchSql, searchProducts, PRODUCT_COUNT_CAP } from './searchProducts';

const dbCols = (t: Parameters<typeof getTableColumns>[0]) => new Set(Object.values(getTableColumns(t)).map((c) => c.name));
const aliasCols = (text: string, alias: string) => new Set([...text.matchAll(new RegExp(`\\b${alias}\\.([a-z0-9_]+)`, 'g'))].map((m) => m[1]));

describe('productSearchSql', () => {
  it('always applies the base predicate and the page', () => {
    const q = productSearchSql(PRODUCT_DEFAULTS);
    expect(q.rows.text).toContain("a.in_scope AND a.enrichment_status IN ('active', 'no_price')");
    expect(q.rows.text).toContain('ORDER BY a.monthly_sold DESC NULLS LAST, a.asin');
    expect(q.rows.values.slice(-2)).toEqual([50, 0]);
    expect(q.count.text).toContain('count(*)');
    expect(q.count.text).toContain(`LIMIT ${PRODUCT_COUNT_CAP}`);
  });
  it('maps every filter to its predicate with bound values', () => {
    const q = productSearchSql({ ...PRODUCT_DEFAULTS, age: 90, soldMin: 1000, reviewsMax: 300, ratingMin: 40, ratingMax: 50, priceMinCents: 999, priceMaxCents: 4000, bsrMin: 1, bsrMax: 50000, ratioMax: 70, cat: 'Tools › Bath', fba: 'no', amazon: 'yes', sort: 'listed', dir: 'asc', page: 3 });
    const t = q.rows.text;
    expect(t).toContain('a.listed_since >= current_date - $1::int');
    expect(t).toContain('a.monthly_sold >= $2::int');
    expect(t).toContain('a.review_count <= $3::int');
    expect(t).toContain('a.average_rating_x10 >= $4::int');
    expect(t).toContain('a.average_rating_x10 <= $5::int');
    expect(t).toContain('a.current_price_cents >= $6::int');
    expect(t).toContain('a.current_price_cents <= $7::int');
    expect(t).toContain('a.sales_rank >= $8::int');
    expect(t).toContain('a.sales_rank <= $9::int');
    expect(t).toContain('a.rank_ratio_x100 <= $10::int');
    expect(t).toContain("(a.category_path = $11::text OR starts_with(a.category_path, $12::text))");
    expect(t).toContain('a.fba_offer_count = 0');
    expect(t).toContain('a.amazon_availability >= 0');
    expect(t).toContain('ORDER BY a.listed_since ASC NULLS LAST, a.asin');
    expect(q.rows.values).toEqual([90, 1000, 300, 40, 50, 999, 4000, 1, 50000, 70, 'Tools › Bath', 'Tools › Bath › ', 50, 100]);
    expect(q.count.values).toEqual(q.rows.values.slice(0, -2));
  });
  it('fba=yes and amazon=no', () => {
    const t = productSearchSql({ ...PRODUCT_DEFAULTS, fba: 'yes', amazon: 'no' }).rows.text;
    expect(t).toContain('a.fba_offer_count > 0');
    expect(t).toContain('(a.amazon_availability IS NULL OR a.amazon_availability = -1)');
  });
  it('sorts by the keyword count through the lateral count', () => {
    const t = productSearchSql({ ...PRODUCT_DEFAULTS, sort: 'keywords' }).rows.text;
    expect(t).toContain('LEFT JOIN LATERAL (SELECT count(*)::int AS keyword_count FROM keyword_top_asins k WHERE k.asin = a.asin) kc ON true');
    expect(t).toContain('ORDER BY kc.keyword_count DESC NULLS LAST, a.asin');
  });
  it('names only real columns', () => {
    const q = productSearchSql({ ...PRODUCT_DEFAULTS, age: 60, cat: 'x', fba: 'yes', amazon: 'yes', ratioMax: 50 });
    expect([...aliasCols(q.rows.text, 'a')].filter((c) => !dbCols(asinProducts).has(c))).toEqual([]);
    expect([...aliasCols(q.rows.text, 'k')].filter((c) => !dbCols(keywordTopAsins).has(c))).toEqual([]);
  });
});

describe('searchProducts', () => {
  it('runs both statements and maps rows', async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const fake = async (text: string, values: unknown[]) => {
      calls.push({ text, values });
      return text.includes('count(*)')
        ? [{ n: 3 }]
        : [{ asin: 'B000000001', title: 'Lamp', brand: 'Acme', listed_since: '2026-08-01', monthly_sold: 1000, review_count: 120, average_rating_x10: 44, current_price_cents: 1999, sales_rank: 1234, rank_ratio_x100: 65, fba_offer_count: 3, fbm_offer_count: 1, amazon_availability: -1, enrichment_status: 'active', keyword_count: 7 }];
    };
    const r = await searchProducts(fake, PRODUCT_DEFAULTS);
    expect(r.total).toBe(3);
    expect(r.totalIsCapped).toBe(false);
    expect(r.rows[0]).toMatchObject({ asin: 'B000000001', monthlySold: 1000, rankRatioX100: 65, keywordCount: 7, amazonAvailability: -1 });
    expect(calls).toHaveLength(2);
  });
});
```

Run: `pnpm vitest run lib/products/searchProducts.test.ts` → FAIL.

- [ ] **Step 2: Implement**

```ts
// lib/products/searchProducts.ts
/**
 * Product search over the live catalog (spec 2026-10-09 §5). Pure statement builder + a loader
 * over a `(text, values) => rows` runner (the page wraps neon's `sql.query`; the tools reuse it).
 * Every predicate rides on a partial index from migration 0051; the base predicate matches those
 * indexes' WHERE clause exactly.
 */
import { PRODUCT_PAGE_SIZE, type ProductFilters } from './filters';

export const PRODUCT_COUNT_CAP = 10_000;
export interface SqlStatement { text: string; values: unknown[] }
export type SqlRunner = (text: string, values: unknown[]) => Promise<unknown[]>;

export interface ProductSummaryRow {
  asin: string; title: string | null; brand: string | null; listedSince: string | null; monthlySold: number | null; reviewCount: number | null;
  averageRatingX10: number | null; currentPriceCents: number | null; salesRank: number | null; rankRatioX100: number | null;
  fbaOfferCount: number | null; fbmOfferCount: number | null; amazonAvailability: number | null; enrichmentStatus: 'active' | 'no_price'; keywordCount: number;
}
export interface ProductSearchResult { rows: ProductSummaryRow[]; total: number; totalIsCapped: boolean; page: number; pageSize: number }

const BASE = "a.in_scope AND a.enrichment_status IN ('active', 'no_price')";
const SORT_COLUMN: Record<ProductFilters['sort'], string> = {
  sold: 'a.monthly_sold', listed: 'a.listed_since', reviews: 'a.review_count', price: 'a.current_price_cents', bsr: 'a.sales_rank', ratio: 'a.rank_ratio_x100', keywords: 'kc.keyword_count',
};
const SELECT = `a.asin, a.title, a.brand, a.listed_since::text AS listed_since, a.monthly_sold, a.review_count, a.average_rating_x10,
  CASE WHEN a.enrichment_status = 'active' THEN a.current_price_cents END AS current_price_cents,
  a.sales_rank, a.rank_ratio_x100, a.fba_offer_count, a.fbm_offer_count, a.amazon_availability, a.enrichment_status::text AS enrichment_status, kc.keyword_count`;
const KEYWORD_COUNT = 'LEFT JOIN LATERAL (SELECT count(*)::int AS keyword_count FROM keyword_top_asins k WHERE k.asin = a.asin) kc ON true';

export function productSearchSql(f: ProductFilters): { rows: SqlStatement; count: SqlStatement } {
  const where: string[] = [BASE];
  const values: unknown[] = [];
  const p = (v: unknown) => { values.push(v); return `$${values.length}`; };
  if (f.age !== null) where.push(`a.listed_since >= current_date - ${p(f.age)}::int`);
  if (f.soldMin !== null) where.push(`a.monthly_sold >= ${p(f.soldMin)}::int`);
  if (f.reviewsMax !== null) where.push(`a.review_count <= ${p(f.reviewsMax)}::int`);
  if (f.ratingMin !== null) where.push(`a.average_rating_x10 >= ${p(f.ratingMin)}::int`);
  if (f.ratingMax !== null) where.push(`a.average_rating_x10 <= ${p(f.ratingMax)}::int`);
  if (f.priceMinCents !== null) where.push(`a.current_price_cents >= ${p(f.priceMinCents)}::int`);
  if (f.priceMaxCents !== null) where.push(`a.current_price_cents <= ${p(f.priceMaxCents)}::int`);
  if (f.bsrMin !== null) where.push(`a.sales_rank >= ${p(f.bsrMin)}::int`);
  if (f.bsrMax !== null) where.push(`a.sales_rank <= ${p(f.bsrMax)}::int`);
  if (f.ratioMax !== null) where.push(`a.rank_ratio_x100 <= ${p(f.ratioMax)}::int`);
  if (f.cat !== null) where.push(`(a.category_path = ${p(f.cat)}::text OR starts_with(a.category_path, ${p(`${f.cat} › `)}::text))`);
  if (f.fba === 'yes') where.push('a.fba_offer_count > 0');
  if (f.fba === 'no') where.push('a.fba_offer_count = 0');
  if (f.amazon === 'yes') where.push('a.amazon_availability >= 0');
  if (f.amazon === 'no') where.push('(a.amazon_availability IS NULL OR a.amazon_availability = -1)');
  const whereSql = where.join(' AND ');
  const dir = f.dir === 'asc' ? 'ASC' : 'DESC';
  const order = `ORDER BY ${SORT_COLUMN[f.sort]} ${dir} NULLS LAST, a.asin`;
  const whereValues = [...values];
  const limit = p(PRODUCT_PAGE_SIZE);
  const offset = p((f.page - 1) * PRODUCT_PAGE_SIZE);
  return {
    rows: { text: `SELECT ${SELECT} FROM asin_products a ${KEYWORD_COUNT} WHERE ${whereSql} ${order} LIMIT ${limit} OFFSET ${offset}`, values },
    count: { text: `SELECT count(*)::int AS n FROM (SELECT 1 FROM asin_products a WHERE ${whereSql} LIMIT ${PRODUCT_COUNT_CAP}) c`, values: whereValues },
  };
}

interface Raw { asin: string; title: string | null; brand: string | null; listed_since: string | null; monthly_sold: number | null; review_count: number | null; average_rating_x10: number | null; current_price_cents: number | null; sales_rank: number | null; rank_ratio_x100: number | null; fba_offer_count: number | null; fbm_offer_count: number | null; amazon_availability: number | null; enrichment_status: 'active' | 'no_price'; keyword_count: number | null }

export async function searchProducts(run: SqlRunner, f: ProductFilters): Promise<ProductSearchResult> {
  const q = productSearchSql(f);
  const [rows, count] = await Promise.all([run(q.rows.text, q.rows.values) as Promise<Raw[]>, run(q.count.text, q.count.values) as Promise<Array<{ n: number }>>]);
  const total = count[0]?.n ?? 0;
  return {
    rows: rows.map((r) => ({
      asin: r.asin, title: r.title, brand: r.brand, listedSince: r.listed_since, monthlySold: r.monthly_sold, reviewCount: r.review_count, averageRatingX10: r.average_rating_x10,
      currentPriceCents: r.current_price_cents, salesRank: r.sales_rank, rankRatioX100: r.rank_ratio_x100, fbaOfferCount: r.fba_offer_count, fbmOfferCount: r.fbm_offer_count,
      amazonAvailability: r.amazon_availability, enrichmentStatus: r.enrichment_status, keywordCount: r.keyword_count ?? 0,
    })),
    total, totalIsCapped: total >= PRODUCT_COUNT_CAP, page: f.page, pageSize: PRODUCT_PAGE_SIZE,
  };
}

/** The page's runner: neon's query form (positional parameters), one statement per call. */
export function neonRunner(sql: { query: (text: string, values?: unknown[]) => Promise<unknown> }): SqlRunner {
  return async (text, values) => (await sql.query(text, values)) as unknown[];
}
```

Check `neon()`'s positional-query API in `node_modules/@neondatabase/serverless` (the client exposes `sql.query(text, params)` in v1; if this version only offers the tagged template, build the page runner with `neon(url, { fullResults: false })` + `sql.query`, or fall back to `pg` for this page — the loader stays runner-agnostic either way). Note `keyword_count` on the sort-by-keywords path: the lateral count runs per candidate row before LIMIT, so that sort is slower on broad filters; acceptable for admin v1 (the spec's per-50-rows count applies to the other sorts).

Run: `pnpm vitest run lib/products && pnpm exec eslint lib/products/searchProducts.ts lib/products/searchProducts.test.ts && pnpm typecheck` → PASS.

- [ ] **Step 3: Commit** — `git add lib/products/searchProducts.ts lib/products/searchProducts.test.ts` → "feat(products): product search statement (partial-index predicates, capped count, keyword count) + loader".

---

### Task 8: ASIN page loaders + formatters

**Files:**
- Create: `lib/products/loadProduct.ts`, `lib/products/loadProductHistory.ts`, `lib/products/loadProductKeywords.ts`, `lib/products/format.ts`
- Tests: `lib/products/loadProduct.test.ts`, `lib/products/loadProductKeywords.test.ts`, `lib/products/format.test.ts`

- [ ] **Step 1: Failing tests** (schema-pinned statements + mapping, same fake-runner pattern as Task 7):

`loadProduct.test.ts`: `productFactsSql(asin)` selects from `asin_products a` every column the facts card shows (pin the alias columns against `asinProducts`), binds `[asin]`, no `in_scope` predicate (a direct link must open out-of-scope and delisted rows); `loadProduct(run, 'B000000001')` maps to `ProductFacts` (camelCase, dates as `YYYY-MM-DD` strings, `currentPriceCents` and the price averages null unless `active`, point-in-time facts (`salesRank`, `monthlySold`, offer counts, `amazonAvailability`, `avg30/90SalesRank`, `rankRatioX100`) null for `delisted`), returns null for no row, and `fetched: false` when `last_fetched_at` is null. A second statement `productFallbackTitleSql(asin)` supplies a title for a never-fetched ASIN from the keyword side: `SELECT kcs.top_clicked_product_1_title_current AS title FROM keyword_top_asins k JOIN keyword_current_summary kcs ON kcs.search_term_id = k.search_term_id WHERE k.asin = $1 AND k.slot = 1 LIMIT 1` (titles live only on the keyword tables; kcs holds the slot-1 title as `top_clicked_product_1_title_current`); pin its aliases against `keywordTopAsins` and `keywordCurrentSummary`. When it finds nothing the page shows the bare ASIN.

`loadProductKeywords.test.ts`: `productKeywordsSql(asin, limit)` = `SELECT st.search_term_raw, kcs.search_term_id, kcs.current_rank, kcs.estimated_monthly_volume_current::text, k.slot, k.click_share::text, k.conversion_share::text, k.weeks_in_top3, k.streak_started_week::text FROM keyword_top_asins k JOIN keyword_current_summary kcs ON kcs.search_term_id = k.search_term_id JOIN search_terms st ON st.id = kcs.search_term_id WHERE k.asin = $1 ORDER BY kcs.current_rank ASC NULLS LAST LIMIT $2` (pin aliases against `keywordTopAsins`, `keywordCurrentSummary`, `searchTerms`); plus `productKeywordCountSql(asin)`; `loadProductKeywords(run, asin)` returns `{ rows: ProductKeywordRow[], total }` with `clickSharePct`/`conversionSharePct` numbers and `estimatedMonthlySearches` as a number or null, cap 500.

`loadProductHistory.ts` (no test beyond the schema pin inside `loadProduct.test.ts`): `productHistorySql(asin, cap)` = `SELECT fetched_at, current_price_cents, sales_rank, review_count, average_rating_x10, monthly_sold, new_offer_count, fba_offer_count, fbm_offer_count, enrichment_status::text FROM asin_snapshots WHERE asin = $1 ORDER BY fetched_at DESC LIMIT $2` (cap 400) → reversed into ascending `HistoryPoint[]` with ISO date strings.

`format.test.ts`: `formatBadge(1000)` → `'1,000+'`, `formatBadge(null)` → `'—'`; `formatRatio(65)` → `'−35%'`, `formatRatio(100)` → `'0%'`, `formatRatio(130)` → `'+30%'`, null → `'—'`; `availabilityLabel(-1)` → `'No Amazon offer'`, `0` → `'In stock'`, `1` → `'Pre-order'`, `2` → `'Unknown'`, `3` → `'Back-order'`, `4` → `'Delayed'`, null → `'—'`; `listingAge('2026-07-01', new Date('2026-10-09'))` → `'100 days'`, 400 days → `'1.1 years'`; `formatPriceCents(1999)` → `'$19.99'`; `formatReviewCount(1834)` → `'1.8k'`.

- [ ] **Step 2: Implement** the four modules (`ProductFacts`, `ProductKeywordRow`, `HistoryPoint` types exported; every loader takes a `SqlRunner` from Task 7 as its first argument; `format.ts` pure, no React).

Run: `pnpm vitest run lib/products && pnpm exec eslint lib/products/*.ts && pnpm typecheck` → PASS.

- [ ] **Step 3: Commit** — the seven new files → "feat(products): ASIN page loaders (facts, snapshot history, keywords with weeks in top 3) and formatters".

---

### Task 9: Admin gating — actor flag, nav entry, layout

**Files:**
- Modify: `lib/research/service.ts` (`ResearchActor.isAdmin: boolean`), `lib/mcp/tools/toolResult.ts` (`actorFromContext` sets it from `extra.account.role === 'admin'`), `app/api/ask/chat/route.ts` (the actor it builds gets `isAdmin: user.role === 'admin'`), every test fixture that builds a `ResearchActor` (grep `channel: 'mcp'` / `channel: 'chat'` in tests; add `isAdmin: false`)
- Modify: `app/(app)/TabNav.tsx` (+ `TabNav.test.tsx`), `app/(app)/layout.tsx` (pass `showProducts={user.role === 'admin'}`)

- [ ] **Step 1: Failing tests** — `TabNav.test.tsx`: with `showProducts` true a "Products" link to `/products` renders between Explorer and Watchlist and is active on `/products` and `/products/B000000001`; with it false no such link. `toolResult.test.ts` (or the file that tests `actorFromContext`): an account with role `admin` → `isAdmin: true`, `standard_user` → false.

- [ ] **Step 2: Implement** — the `isProducts` path check like the others; the link `<Link href="/products">Products</Link>` with the existing active-tab classes. `ResearchActor` gains `isAdmin: boolean` (required, so every constructor site is forced to decide). `app/(app)/layout.tsx`: `showProducts={user.role === 'admin'}`.

Run: `pnpm vitest run app/\(app\)/TabNav.test.tsx lib/mcp lib/research lib/ask app/api/ask && pnpm exec eslint <touched files> && pnpm typecheck` → PASS (typecheck is what finds every actor fixture).

- [ ] **Step 3: Commit** — the touched files → "feat(products): admin-only Products tab; ResearchActor.isAdmin from the MCP account role and the chat user".

---

### Task 10: Products page — `app/(app)/products/`

**Files:**
- Create: `app/(app)/products/page.tsx`, `loading.tsx`, `ProductFilterPanel.tsx`, `ProductResultsTable.tsx`, `ProductPagination.tsx`
- Tests: `app/(app)/products/ProductFilterPanel.test.tsx`, `ProductResultsTable.test.tsx`, `ProductPagination.test.tsx`

Read first: `node_modules/next/dist/docs/` (page conventions, `searchParams` as a Promise, `loading.js`), `app/(app)/explorer/page.tsx`, `FilterSidebar.tsx`, `ResultsTable.tsx`, `Pagination.tsx`, `LoadingOverlay.tsx`, `ExplorerSkeleton.tsx`.

- [ ] **Step 1: Failing tests**

`ProductFilterPanel.test.tsx` (RTL; mock `next/navigation` like `ResultsTable.test.tsx` does): renders every control from `PRODUCT_DEFAULTS` (age select with "Any / 60 / 90 / 180 / 365 days", monthly-sold select with the badge buckets, reviews-max input, rating range, price range, BSR range, "BSR vs 30-day avg" select with "Any / 10 % better / 30 % better / 50 % better" → ratioMax 90/70/50, category typeahead (`LeafCategoryTypeahead` with the `leafCategories` prop), FBA select, Amazon select); Apply calls `router.replace('/products?' + productFiltersToSearchParams(next))` with `page` reset to 1; Reset replaces with `/products`.

`ProductResultsTable.test.tsx`: one row renders title linked to `/products/B000000001`, brand, listed date + age, `'1,000+'`, reviews `'120 · ★ 4.4'`, `$19.99`, BSR `1,234` with `−35%`, offers `3 / 1`, Amazon `No`, keywords `7`; the empty state renders "No products match these filters"; the header's sortable columns link to `?sort=<key>&dir=<toggled>` keeping the other params.

`ProductPagination.test.tsx`: `basePath="/products"` → the pager replaces to `/products?…&page=2` (a copy of the explorer pager with `basePath` — or add an optional `basePath` prop to `app/(app)/explorer/Pagination.tsx` defaulting to `/explorer` and reuse it; choose the prop, and add one test there).

- [ ] **Step 2: Implement**

`page.tsx` (server component, `export const metadata = { title: 'Products' }`):

```tsx
import { Suspense } from 'react';
import type { Metadata } from 'next';
import { neon } from '@neondatabase/serverless';
import { env } from '@/lib/env';
import { requireAdmin } from '@/lib/auth/requireAdmin';
import { parseProductFilters, productFiltersToSearchParams, type SearchParamsLike } from '@/lib/products/filters';
import { searchProducts, neonRunner } from '@/lib/products/searchProducts';
import { listLeafCategories } from '@/lib/explorer/listLeafCategories';
import { ProductFilterPanel } from './ProductFilterPanel';
import { ProductResultsTable } from './ProductResultsTable';
import { ProductPagination } from './ProductPagination';
import { ProductsSkeleton } from './loading';

export const metadata: Metadata = { title: 'Products' };

export default async function ProductsPage({ searchParams }: { searchParams: Promise<SearchParamsLike> }) {
  try { await requireAdmin(); } catch (e) { if (e instanceof AuthError) redirect(e.code === 'UNAUTHENTICATED' ? '/sign-in' : '/explorer'); throw e; }
  const sp = await searchParams;
  const filters = parseProductFilters(sp);
  return (
    <div className="mx-auto flex max-w-7xl gap-6 px-6 py-6">
      <Suspense fallback={<ProductsSkeleton />}>
        <ProductsResults filters={filters} />
      </Suspense>
    </div>
  );
}

async function ProductsResults({ filters }: { filters: ReturnType<typeof parseProductFilters> }) {
  const sql = neon(env.DATABASE_URL);
  const [result, leafCategories] = await Promise.all([searchProducts(neonRunner(sql), filters), listLeafCategories()]);
  const qs = productFiltersToSearchParams(filters).toString();
  return (
    <>
      <ProductFilterPanel filters={filters} leafCategories={leafCategories} />
      <main className="min-w-0 flex-1">
        <div className="mb-2 text-sm text-gray-600">{result.totalIsCapped ? '10,000+' : result.total.toLocaleString()} products</div>
        <ProductResultsTable rows={result.rows} filters={filters} queryString={qs} />
        <ProductPagination page={filters.page} hasNext={result.rows.length === result.pageSize} basePath="/products" />
      </main>
    </>
  );
}
```

Admin handling, exactly as `app/admin/keepa-enrichment/page.tsx` does it: `try { await requireAdmin(); } catch (e) { if (e instanceof AuthError) redirect(e.code === 'UNAUTHENTICATED' ? '/sign-in' : '/explorer'); throw e; }` (import `AuthError` from `@/lib/auth/requireAdmin`, `redirect` from `next/navigation`). Same block in Task 11's page.

`ProductFilterPanel.tsx` ('use client'): local state seeded from `filters`; the controls above; Apply/Reset with `useTransition` + `LoadingOverlay` like `FilterSidebar`; the monthly-sold buckets `[50, 100, 200, 300, 400, 500, 1000, 2000, 5000, 10000]`; the `cat` control = department select (`listCategories`-style list is not needed: use `LeafCategoryTypeahead` with `options={leafCategories}` and `selected={filters.cat ? [filters.cat] : []}`, keeping only the first selection).

`ProductResultsTable.tsx`: a plain table (server component is fine; sort links are `<Link>`s built from `queryString` with `sort`/`dir` replaced and `page` removed); formatting via `lib/products/format.ts`; the title cell links to `/products/${asin}` and the ASIN links to Amazon like the keyword page's table.

`loading.tsx`: exports `ProductsSkeleton` (a filter-panel block + 10 grey rows) and default-exports it for the route.

Run: `pnpm vitest run app/\(app\)/products app/\(app\)/explorer/Pagination.test.tsx && pnpm exec eslint "app/(app)/products/"*.tsx && pnpm typecheck && pnpm build 2>&1 | tail -n 5` → PASS, build clean.

- [ ] **Step 3: Commit** — the new files (+ `Pagination.tsx`/test if changed) → "feat(products): admin-only Products page — filter panel, results table, pagination".

---

### Task 11: ASIN page — `app/(app)/products/[asin]/`

**Files:**
- Create: `app/(app)/products/[asin]/page.tsx`, `loading.tsx`, `FactsCard.tsx`, `HistoryCharts.tsx` (recharts, client), `LazyHistoryCharts.tsx` (`next/dynamic`, `ssr: false`, like `LazyCharts.tsx`), `ProductKeywordsTable.tsx`, `StreamedProductSections.tsx`
- Tests: `FactsCard.test.tsx`, `ProductKeywordsTable.test.tsx`, `HistoryCharts.test.tsx` (renders without throwing for 3 points and for 0 points — recharts needs `ResizeObserver`; copy the setup from `TrendChart.test.tsx`)

Read first: `app/(app)/explorer/keyword/[id]/page.tsx`, `StreamedSections.tsx`, `LazyCharts.tsx`, `TrendChart.tsx`, `ChartSkeleton.tsx`, the Next 16 docs on dynamic imports and `params` as a Promise.

- [ ] **Step 1: Failing tests**

`FactsCard.test.tsx`: given a full `ProductFacts` renders every label/value pair: Brand, Category (full path), Listed since (date + age), Tracking since, Price with "30d / 90d / 180d / 365d avg" line, BSR with "30d / 90d avg" and the ratio chip, Reviews + stars + "rating updated", Monthly sold `'1,000+'` with "as of <keepa_updated_at>", Offers "new 4 · FBA 3 · FBM 1", Amazon `'No Amazon offer'`, Status `active` + "fetched <date> (n fetches)"; a delisted row shows a "Delisted" badge and dashes for the point-in-time facts; a never-fetched row (`fetched: false`) shows "Not fetched yet".

`ProductKeywordsTable.test.tsx`: rows render keyword (link to `/explorer/keyword/<id>`), rank, est. searches (`~1.2k` style: copy the keyword page's local `formatHeadlineVolume` into `lib/products/format.ts` as `formatVolume`, with a test), slot, click/conversion %, weeks in top 3 with the streak-start tooltip; the "showing 500 of N" line when `total > rows.length`; the empty state "Not a top-3 clicked product for any keyword this week".

- [ ] **Step 2: Implement**

`page.tsx`:

```tsx
export default async function ProductPage({ params }: { params: Promise<{ asin: string }> }) {
  try { await requireAdmin(); } catch (e) { if (e instanceof AuthError) redirect(e.code === 'UNAUTHENTICATED' ? '/sign-in' : '/explorer'); throw e; }
  const { asin } = await params;
  if (!/^[A-Z0-9]{10}$/.test(asin)) notFound();
  const sql = neon(env.DATABASE_URL);
  const run = neonRunner(sql);
  const facts = await loadProduct(run, asin);          // fast: one PK read (+ the fallback title read when never fetched)
  if (!facts) notFound();
  return (
    <>
      <div className="bg-gradient-to-r from-[#0B1E3A] via-[#0D2447] to-[#123B73] px-6 py-5 text-white">…title band: title (or the ASIN), brand, status badges, Amazon link, "Back to products"…</div>
      <div className="mx-auto max-w-6xl px-6 py-6">
        <FactsCard facts={facts} />
        <Suspense fallback={<ChartSkeleton title="History" />}><HistorySection run={run} asin={asin} /></Suspense>
        <Suspense fallback={<KeywordsSkeleton />}><KeywordsSection run={run} asin={asin} /></Suspense>
      </div>
    </>
  );
}
```

`StreamedProductSections.tsx`: `HistorySection` (awaits `loadProductHistory`, renders `LazyHistoryCharts`; fail-soft try/catch with the keyword page's wording) and `KeywordsSection` (awaits `loadProductKeywords`, renders `ProductKeywordsTable`). The "Back to products" control mirrors `BackToExplorer` (same-origin `/products` `from=` only).

`HistoryCharts.tsx`: four small recharts line charts (price $, BSR (inverted axis: lower is better), reviews, monthly sold) over `HistoryPoint[]`; one point renders as a dot; zero points → "No history yet".

Run: `pnpm vitest run "app/(app)/products" && pnpm exec eslint "app/(app)/products/[asin]/"*.tsx && pnpm typecheck && pnpm build 2>&1 | tail -n 5` → PASS, build clean, and confirm in the build output that the `/products/[asin]` route's first-load JS does not include recharts (the chunk shows up only as a dynamic import, as for `/explorer/keyword/[id]`).

- [ ] **Step 3: Commit** — the new files → "feat(products): admin-only ASIN page — facts card, snapshot history charts (lazy), keywords with weeks in top 3".

---

### Task 12: Keyword page link-back

**Files:**
- Modify: `app/(app)/explorer/keyword/[id]/TopProductsSection.tsx` (+ create `TopProductsSection.test.tsx` if absent), `app/(app)/explorer/keyword/[id]/page.tsx`

- [ ] **Step 1: Failing test** — `TopProductsTable` with `linkProducts` true renders each product title as a link to `/products/<asin>?from=/explorer/keyword/<id>`; with it false the title is plain text (today's markup).

- [ ] **Step 2: Implement** — `TopProductsSection` gains `linkProducts: boolean` (passed from `page.tsx` as `user?.role === 'admin'`) and `keywordId` for the `from` param; `TopProductsTable` renders `<Link>` when set.

Run: `pnpm vitest run "app/(app)/explorer/keyword" && pnpm exec eslint "app/(app)/explorer/keyword/[id]/TopProductsSection.tsx" "app/(app)/explorer/keyword/[id]/page.tsx" && pnpm typecheck` → PASS.

- [ ] **Step 3: Commit** → "feat(products): keyword page's top products link to the ASIN page for admins".

---

### Task 13: Research contracts + service methods — `lib/research/products.ts`

**Files:**
- Modify: `lib/research/contracts.ts` (export `productSearchInputSchema`, `productDetailsInputSchema`, `ProductSearchResponse`, `ProductDetailsResponse`), `lib/research/service.ts` (`searchProducts`, `productDetails` on `ResearchService` + the default implementation wiring)
- Create: `lib/research/products.ts` (+ `products.test.ts`)

- [ ] **Step 1: Failing tests** (`products.test.ts`, deps injected like `details.test.ts`):
  - `productSearchInputSchema` is a strict object: `{ filters?: <the page's filter fields except sort/dir/page>, sort?: ProductSort, dir?: 'asc'|'desc', page?: int ≥ 1 ≤ 200 }`; unknown keys rejected; `filters.priceMin/priceMax` in **dollars** (converted to cents by the mapper); defaults = `PRODUCT_DEFAULTS`.
  - `searchProductsForTool(deps, actor, input)` → `{ schemaVersion, products: ProductSummary[] (page rows + `url: ${appUrl}/products/${asin}`), total: { kind: 'exact'|'at_least', value }, page, pageSize, dataWeek }`; a non-admin actor throws `ResearchError('FORBIDDEN', 'Products tools are admin-only for now.')` (add the code to `errors.ts` if absent); the usage reserve (`deps.reserve`) is charged like `search_keywords` (`rows = products.length`).
  - `productDetailsForTool(deps, actor, { asin })` → `{ schemaVersion, product: ProductFacts + url, history: { points, first, last }, keywords: ProductKeywordRow[] (cap 100) + keywordUrl each, keywordsTotal }`; unknown ASIN → `ResearchError('NOT_FOUND', …)` (reuse the keyword-not-found error's shape with an ASIN message); malformed ASIN rejected by the schema.

- [ ] **Step 2: Implement** `lib/research/products.ts` with `ProductsDeps { appUrl; search(filters): Promise<ProductSearchResult>; facts(asin); history(asin); keywords(asin, limit); reserve }` and `defaultProductsDeps(appUrl)` wiring the Task 7/8 loaders through `neonRunner(neon(env.DATABASE_URL))` (same pattern as `details.ts`'s `defaultDetailsDeps`). Add the two methods to `ResearchService` and the default service.

Run: `pnpm vitest run lib/research && pnpm exec eslint lib/research/products.ts lib/research/products.test.ts lib/research/contracts.ts lib/research/service.ts && pnpm typecheck` → PASS.

- [ ] **Step 3: Commit** → "feat(research): product search and product details service methods + contracts (admin-only)".

---

### Task 14: Tool definitions, registries, guide text

**Files:**
- Modify: `lib/research/tools.ts` (+ `tools.test.ts`): add `search_products` and `get_product_details` to `RESEARCH_TOOL_NAMES` and `RESEARCH_TOOLS` with `adminOnly: true` (new optional field on `ToolDefinition`, default false)
- Modify: `lib/ask/tools.ts` (+ test): `buildAskTools` skips `adminOnly` definitions when `!actor.isAdmin`
- Modify: `lib/mcp/tools/registerDefinitions.ts`: the server is built once per process, so admin-only tools stay listed; their `run` is wrapped so a non-admin actor gets the `FORBIDDEN` ResearchError (the Task 13 service already throws it — the adapter needs no change beyond the test); document this in the definition's description ("Admin accounts only for now.")
- Modify: the guide text (`service.guide` / `lib/research/catalog.ts`'s guide builder): a "Products" section — the filters, the badge semantics ("Amazon's 'bought in past month' floor: 1000 means 1,000+"), the ratio ("rank_ratio_x100 under 100 = better than its 30-day average"), weeks in top 3, and that both tools are admin-only.

- [ ] **Step 1: Failing tests** — `tools.test.ts`: the two new names exist, their schemas are strict objects (the existing unknown-key loop covers them), `adminOnly` is true for exactly these two; `lib/ask/tools.test.ts`: `buildAskTools(service, { …actor, isAdmin: false })` has no `search_products`/`get_product_details`, with `isAdmin: true` it has both; the guide test (where `catalog.test.ts` pins sections) sees the Products section.

- [ ] **Step 2: Implement**; descriptions built like `searchDescription` (constants, not numerals).

Run: `pnpm vitest run lib/research lib/ask lib/mcp && pnpm exec eslint <touched> && pnpm typecheck` → PASS.

- [ ] **Step 3: Commit** → "feat(tools): search_products + get_product_details (admin-only) on the shared definition list; guide section".

Amend the spec (§9) in the docs step: MCP lists the tools for every actor but refuses non-admins (server registered per process); Ask AI hides them.

---

### Task 15: Owner-gated integration tests

**Files:**
- Create: `tests/integration/topAsinsBuild.test.ts`, `tests/integration/productsQueries.test.ts`

- [ ] **Step 1: `topAsinsBuild.test.ts`** — `describe.skipIf(!RUN_INTEGRATION)`; one `pg` client; reads the meta row's week and the kcs current week; inside `BEGIN … ROLLBACK`: runs `buildTopAsinsStatements(currentWeek)` statement by statement BUT against scratch names (replace `keyword_top_asins_next` with `keyword_top_asins_itest` and skip the swap/meta: the point is to prove the INSERT's SQL, the partition name, the ASIN regex and the LATERAL join against the real schema) and asserts `rowCount` ≥ 1 and ≤ 3 × (keywords with a slot-1 ASIN this week), every `weeks_in_top3 ≥ 1`, `streak_started_week ≤ week_end_date`; then ROLLBACK. Also proves the two RENAME statements' object names: `CREATE TABLE keyword_top_asins_itest (LIKE keyword_top_asins INCLUDING ALL)` then `SELECT indexname FROM pg_indexes WHERE tablename = 'keyword_top_asins_itest'` and `SELECT conname FROM pg_constraint WHERE conrelid = 'keyword_top_asins_itest'::regclass` → assert the generated names follow the `<table>_<cols>_idx` / `<table>_pkey` pattern Task 3 relies on (if not, fix the literals in `buildWeek.ts`).
- [ ] **Step 2: `productsQueries.test.ts`** — read-only: `EXPLAIN (FORMAT JSON)` of `productSearchSql(PRODUCT_DEFAULTS with age 180 + soldMin 1000 + reviewsMax 300).rows` uses at least one of the 0051 partial indexes (search the plan JSON for `asin_products_` index names); `loadProduct(run, <an ASIN from the first search row>)` returns facts; `loadProductKeywords` returns rows with `weeksInTop3 ≥ 1` when the reverse table is built (skip that assertion with a console note when `keyword_top_asins_meta.week_end_date` is null); `loadProductHistory` returns ≥ 1 point for a fetched ASIN.

Run (owner's go only): `RUN_INTEGRATION=1 pnpm vitest run tests/integration/topAsinsBuild.test.ts tests/integration/productsQueries.test.ts`. Without the variable both files skip: `pnpm vitest run tests/integration/topAsinsBuild.test.ts` → skipped.

- [ ] **Step 3: Commit** → "test(products): owner-gated integration tests for the reverse-table build and the product queries".

---

### Task 16: Ship and smoke (owner-gated, in order)

**Before the push, all local:** final whole-diff review; `pnpm vitest run` (full suite) green; `pnpm typecheck` clean; `pnpm build` clean.

1. **Apply 0051 + ratio backfill:** `node --env-file=.env.local --import tsx scripts/checkActiveJobs.ts` (quiet), then `APPLY_0051=yes node --env-file=.env.local --import tsx scripts/applyMigration0051.ts`. Expect: 12 statements ok, "6 indexes, 2 tables", then ratio batches (≈ every fetched row with both ranks; the service has been writing `avg30_sales_rank` since 2026-10-06). Minutes.
2. **Backfill the reverse table:** `BACKFILL_TOP_ASINS=yes node --env-file=.env.local --import tsx scripts/backfillTopAsins.ts` — 77 weeks, about a minute each; progress line per week; the final line "replaced keyword_top_asins: N rows (week 2026-10-03)". Quiet hour; no import running.
3. **Integration tests** (Task 15 command).
4. **Push:** `checkActiveJobs` → bare `git push origin main` → watch the three deploys (`gh api repos/raw5045/AmazonAnalytics/commits/<sha>/status --jq …`). The Keepa service redeploys (pgStore change) — expect a clean `sigterm` handover and `tokensLeft ≥ 0` batches after the reboot; the worker restarts (no new Inngest function → no sync). Vercel: the Products tab appears for the admin.
5. **Smoke (owner, admin):** `/products?age=180&soldMin=1000&reviewsMax=300` returns rows; sort by keywords; open an ASIN page: facts, four charts, keywords with weeks in top 3; keyword page → ASIN page → keyword page; a never-fetched ASIN by direct link; a delisted ASIN by direct link (find one with `enrichment_status = 'delisted'`); `/products` as a non-admin (a second account) → not found / forbidden; the Products tab hidden for non-admins.
6. **Tools (after the page smoke):** from Claude: "search products listed in the last 180 days with 1,000+ monthly sold and under 300 reviews" → `search_products`; "details for B0…" → `get_product_details`; a non-admin MCP account gets the admin-only error; Ask AI (admin) lists both.
7. **Next import (2026-10-10/11):** the worker log shows `[top-asins] week 2026-10-10: rows=… previous=2026-10-03`; the ASIN page's weeks-in-top-3 values grow by one for persisting pairs.

| Step | Date | Outcome | Notes |
|---|---|---|---|
| 0051 applied + ratio backfill | 2026-10-10 | OK (85 s) | 13 statements; ALTER 1 s; ratio backfill 508,867 rows updated of 2,603,628 scanned in 70 s; six concurrent indexes 1–2 s each; reverse table + meta; assertions passed; Keepa service kept fetching throughout |
| Reverse-table backfill (77 weeks) | 2026-10-10 | OK: 77 weeks, 0 skipped, 104 min (19:51–21:35 UTC) | 50–137 s per week (7–10M rows each); finalized week 2026-10-03 = 8,310,634 rows, _prev = 2026-09-26; scratch tables dropped; streaks: 4.38M pairs at 1 week, 2.63M at 2–7, 822k at 8–25, 235k at 26–51, 246k at 52+; meta week == explorer week (pre-push gate OK) |
| Integration tests | 2026-10-10 | keepaService 5/5 (4 s); topAsinsBuild 5/5 (10 min 24 s, 19:39–19:50 UTC) | build test run BEFORE the backfill (names + carry proven); productsQueries after the backfill |
| Push + deploys | | | |
| Page smoke | | | |
| Tools smoke | | | |
| First weekly build (next import) | | | |

## Landed shape (2026-10-09/10) — what changed between the tasks above and the commits

Spec §14 lists every design-level amendment; this is the task-by-task map.

- **Task 1 (9de3635 + 69fe729 + 5e2519a).** Composite `(key, asin)` indexes; `--> statement-breakpoint` markers; the ratio comment says "point-in-time, hidden for delisted"; a SQL-text test pins the predicate × 6, the index columns, the reverse-table column set, the PK and the comment. The untracked apply script: ALTER under `lock_timeout` 5 s (retried), ratio backfill in 20k-row cursor batches under the enqueue advisory lock (`IS DISTINCT FROM`; re-runnable), plain VACUUM, the six indexes `CONCURRENTLY` on the direct endpoint with a validity rebuild, the reverse table in one transaction, coded assertions, ANALYZE. It logs "13 statements".
- **Task 2 (3be32ee + fa698aa + ecb8fd0).** SUCCESS_UPDATE only (delisted keeps the ratio; readers hide it); int4 overflow guard; integration assertions (42/50 → 84; a seeded 77 survives a delisted write).
- **Task 3 (3f5da33 + 1c7376a + 021c11c + 1b110e1).** Retained `_prev`, three plan variants (advance / same-week / rewind), DISTINCT ON carry, advisory lock `TOP_ASINS_LOCK_KEY` inside `BEGIN ISOLATION LEVEL READ COMMITTED`, `work_mem`, `lock_timeout` before the swap, `meta(rows)`, ANALYZE isolated, Pool guard, comments carried; 28 tests with exact call orders.
- **Task 4 (8161f87 + 3bcfd79 + 8a66f95).** Phase as planned (`stage` connect|build; only `top_asins_older_than_meta` skips); chip labels "Keepa queue" / "Top ASINs"; the script refuses any `TOP_ASINS_FORCE` value but `1` and prints the rewind warning on an older-week refusal; pool options pinned.
- **Task 5 (0d06956 + 674e26b).** As spec §14, §4.2.
- **Task 6 (585403d + a1f1af0).** Per-field fallback; `Readonly<ProductFilters>`; `z.literal(PRODUCT_AGES)`; no negative zero; 8-digit prices; page clamp; trimmed category. Task 10 later split the zod-free parts into `filterParams.ts` (filters.ts re-exports them).
- **Task 7 (2096325 + 6250bb5 + 640df33).** Page-first + lateral count; sorts hide null keys (`sortHidesNullKey`, `SORT_KEY_LABEL` — now in `filterParams.ts`); direction-following tie-break with `sort_key`; 32 tests incl. the 14-pair WHERE equality. The neon driver's `sql.query(text, params)` is the runner.
- **Task 8 (0a80f1c + 62682d7).** `inCatalog` stub for reverse-table-only ASINs; fallback title bound to the ASIN; en-US `formatVolume` ('1,234 / mo', no tilde — the plan's "~1.2k" was wrong, exact numbers are the house rule); safe timestamps; keyword tie-break on `search_term_id`; shared `testHelpers.ts`; `loadProductKeywords(run, asin, limit = 500)`.
- **Task 9 (92b6ca6).** As planned (nine actor fixtures touched; `app/api/mcp` tests needed the derived `isAdmin: true`).
- **Task 10 (3f2186b + d33a090).** Client results table with `useLinkStatus`; pager from the total; `(list)` route group; `(list)/page.test.tsx`; `SORT_FIRST_DIR`; `replace` on header links; new-tab title links with `from`; sold buckets to 100,000; `filterParams.ts` split (chunk evidence: /products 146 → 83 KB gzip).
- **Task 11 (000a017 + 453c2ef + 64ae466).** `lib/products/asin.ts` (`ASIN_RE`, `isAsin`); back control with both `from` shapes and `canGoBack`; not-in-catalog page; status chips for non-active states; dedicated history skeleton; `chartMeta.ts`; `page.test.tsx` with an async-section resolver; https-only image pinned.
- **Task 12 (9da46a5 + 88993fc).** Links only for ASIN-shaped ids; `from` built from `id`; plain markup pinned; `focus-visible:underline`.
- **Task 13 (3142f6e + cb00b3b).** Dollar/star schema with refines; `toProductFilters`; FORBIDDEN before any read; reserve 50 before reading like `search_keywords`; `record` on the deps; `ProductLoaders`/`ProductsDeps` split; `productUrlFor` in `links.ts`.
- **Task 14 (8ad8bcd + its review-round commit).** Per-request admin-only listing on MCP (AsyncLocalStorage), Ask AI hides, guide section generated from the schema, `GUIDE_VERSION` 3, `productCaps.ts` leaf (tools.ts must never import `@/lib/env`), history cap 60 + `pointsTotal`, ToolActivity labels, the prompt's link rule.
- **Task 15 (0736203 + e37e789).** TEMP scratch tables inside BEGIN…ROLLBACK with the build lock taken first; a second build proves the carry (gap rows deleted, a sample aged); auto-generated names asserted; `client_connection_check_interval`; the not-in-catalog path; EXPLAIN outlines for the default view and the owner's search.

### Task 16, amended runbook (final, after the whole-diff review)

**Timing.** Do not let a weekly CSV upload land between the backfill and the push: the old worker builds no reverse-table week. Either run every step below before the next upload, or run them all after that import's summary refresh has finished. Pre-push gate: `keyword_top_asins_meta.week_end_date` must equal the newest `keyword_weekly_metrics` week; if it does not, run `TOP_ASINS_WEEK=<week> node --env-file=.env.local --import tsx scripts/buildTopAsinsWeek.ts` right after the push.

1. **Apply 0051 + ratio backfill** (`checkActiveJobs` first; quiet hour): `APPLY_0051=yes node --env-file=.env.local --import tsx scripts/applyMigration0051.ts`. Expect "13 statements", "alter: committed", `ratio backfill: scanned … updated …` lines, "vacuumed asin_products", six `ok (Ns)` index lines, "6 valid indexes", "tables: committed", "assertions passed", "analyzed". Keepa batches keep landing meanwhile. Re-run the same command after the Keepa redeploy (step 5b) — idempotent.
2. **Prove the service's new write + the build's SQL:** `RUN_INTEGRATION=1 pnpm vitest run tests/integration/keepaService.test.ts` (writes TESTKS rows only, asserts the ratio 84 and a kept 77; it briefly claims and releases up to 100 real rows, so one duplicate batch is possible — accept it) and `RUN_INTEGRATION=1 pnpm vitest run tests/integration/topAsinsBuild.test.ts` (no import due; minutes; prints the INSERT's seconds — every import will add roughly that; expect 2–3 GB of temp space). The build test proves the swap's generated names BEFORE the backfill depends on them.
3. **Backfill:** `BACKFILL_TOP_ASINS=yes node --env-file=.env.local --import tsx scripts/backfillTopAsins.ts` — "listing weeks…", one `week … (i/77): rows=… in …s` line per week, skipped weeks logged, then `finalized: week … rows=… prev=…` and `backfilled N weeks (S skipped) in M min`. 2–3 hours; the scratch tables are UNLOGGED (a crash empties them; a failed run restarts from scratch); readers can queue up to 120 s behind the final swap; the explorer and keyword pages will be cold afterwards (the walk reads every kwm week three times). On an abandoned run drop `keyword_top_asins_bf*` if not re-running.
4. **Queries integration test:** `RUN_INTEGRATION=1 pnpm vitest run tests/integration/productsQueries.test.ts`. Never run `tests/integration/ingestion-flow.test.ts` / `replace-week.test.ts` before step 3 (they import a real week and would build the live table from 2026-04-11).
5. **Push:** the pre-push gate above, `checkActiveJobs`, then a bare `git push origin main` → the three deploys; the Keepa service redeploys (clean `sigterm` handover expected). Watch its first batches: `last_batch_at` advancing, `last_error_code` null, `tokens_left ≥ 0`; if batches fail, redeploy the previous Railway deployment (the schema change is additive, rolling the code back is safe). No Inngest sync needed. **5b:** re-run the apply script for the ratio catch-up.
6. **Smoke** (owner, admin): `/products?age=180&soldMin=1000&reviewsMax=300`; an ASIN page (facts, four charts, keywords with weeks in top 3); keyword → ASIN → keyword; a never-fetched and a not-in-catalog ASIN by direct link; a non-admin account is redirected to `/explorer` and sees no Products tab; `sort=keywords` only with narrow filters (it counts keywords for every candidate row). Then the tools from Claude (admin) and "tool not found" for a non-admin connector. Known: the list's keyword count (reverse table) and the ASIN page's total (joined to the summary) differ for ~4.5 hours after each import while the summary refreshes.
7. **Next import:** `[top-asins] week …: rows=… previous=<prior week> carried=current`; `keepa_enqueue` and `top_asins_build` rows in `import_phase_timings`; weeks in top 3 grow by one for persisting pairs; the chip shows "Top ASINs" during the phase.

