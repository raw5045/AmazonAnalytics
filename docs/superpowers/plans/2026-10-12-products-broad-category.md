# Products: Brand Analytics broad category — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Carry each clicked product's Brand Analytics code onto the weekly keyword-to-ASIN table and expose it as a broad-category filter on `/products` and `search_products`, with the codes listed on the ASIN page and in `get_product_details` — per `docs/superpowers/specs/2026-10-12-products-broad-category-design.md` (8f8e2f1).

**Architecture:** Migration 0052 adds a nullable `broad_category` column and a partial `(broad_category, asin)` index to `keyword_top_asins`. The weekly build (`lib/topAsins/buildWeek.ts`) copies `top_clicked_category_<slot>` from the kwm row it already reads and renames the third index in its swap; the backfill shares the slot select. The product search gains one `EXISTS` predicate over the pair table; a loose-index-scan loader lists the codes (cached an hour); the page gets a select under Department, the ASIN page a "Broad categories" fact, the tools a validated `filters.broadCategory` and a `broadCategories` field on the details. No change to the import phase, the Keepa service or the Explorer.

**Tech Stack:** Next.js 16 App Router (server components, `unstable_cache`), React 19, zod, drizzle schema mirrors + hand-numbered SQL migrations, `pg` for the build, `@neondatabase/serverless` for page reads, vitest + Testing Library, MCP SDK + Vercel AI SDK via `lib/research/tools.ts`.

---

## Conventions (every task)

- Local commits on `main` only. Commit trailer EXACTLY `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Never push (owner-gated, Task 10). `git add` named files only, never `-A` or `.`. The working tree holds many untracked throwaway scripts and `scripts/applyMigration0052.ts` is one of them: never add it.
- No DDL from any task: migration 0052 is applied by the owner (Task 10). Never run `pnpm db:generate` / `db:migrate` (the drizzle journal is frozen).
- `.env.local` points at PRODUCTION. Tasks 1–9 never run anything against it: no scripts, no dev server, no `RUN_INTEGRATION`.
- TDD per task: write the failing test, run it (`pnpm vitest run <file>`), implement, run again, then `pnpm typecheck` (tsc --noEmit, tests included) and `pnpm exec eslint <touched files>` (whole-project lint fails on untracked scripts). vitest never type-checks: keep the type-only pins.
- Edit with the Edit tool only, matching the file's existing line endings (the tree mixes CRLF and LF; never convert). Keep each file's comment voice.
- Log-safe: never log a DB error's `.message` (coded fields only); never print member emails.
- Page code (Tasks 6, 7): read `node_modules/next/dist/docs/01-app/` (genuine vendored Next 16 docs; the APIs differ from training data) before editing a server component or `unstable_cache` use.
- Full-literal sites: `ProductFilters` (Task 3) and `ProductFacts` (Task 7) are object types built as full literals in several files; each task lists them and runs `pnpm typecheck` to catch the rest. A task that changes a shared type leaves the tree type-clean at its commit.

## File structure

| File | Responsibility in this arc |
|---|---|
| `db/migrations/0052_top_asins_broad_category.sql` (new) | the column, the `_prev` column, the partial index |
| `db/schema/keywordTopAsins.ts` (+test) | drizzle mirror of the column and index; the 0051/0052 text pins |
| `scripts/applyMigration0052.ts` (new, UNTRACKED) | owner-gated apply: ALTERs, CONCURRENTLY index, assertions |
| `lib/topAsins/buildWeek.ts` (+test) | slot select carries the code; nine-column INSERT; swap renames the third index |
| `lib/topAsins/backfill.ts` (+test) | the shared slot select's column in its INSERT; the finalize swap's rename |
| `lib/products/filterParams.ts`, `lib/products/filters.ts` (+test) | `broadCategory` field, `broad` URL key, bound 255 |
| `lib/products/searchProducts.ts` (+test) | the `EXISTS` predicate |
| `lib/products/listCategories.ts` (+test) | `listProductBroadCategories` (loose index scan, cached an hour) |
| `app/(app)/products/(list)/page.tsx` (+test), `app/(app)/products/ProductFilterPanel.tsx` (+test) | fourth list; Broad category select |
| `lib/products/loadProduct.ts` (+test), `app/(app)/products/[asin]/FactsCard.tsx` (+test) | `ProductFacts.broadCategories`; the "Broad categories" fact |
| `lib/research/contracts.ts`, `products.ts`, `tools.ts`, `catalog.ts` (+tests), `lib/research/service.test.ts` | tool field, validation, loader, rule, description, `GUIDE_VERSION` 5 |
| `tests/integration/topAsinsBuild.test.ts`, `tests/integration/productsQueries.test.ts` | owner-gated proofs (Task 9 writes, Task 10 runs) |
| the spec (§8, §9 wording), this plan's Results table | amendments as landed |

Task order: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10. (2 touches only `lib/topAsins`; 3–8 are sequential because each changes a shared type or test file the next one edits.)

---

### Task 1: Migration 0052, the drizzle mirror, the apply script

**Files:**
- Create: `db/migrations/0052_top_asins_broad_category.sql`
- Modify: `db/schema/keywordTopAsins.ts`
- Modify: `db/schema/keywordTopAsins.test.ts`
- Create (UNTRACKED, never committed): `scripts/applyMigration0052.ts`

- [ ] **Step 1: Failing tests** — in `db/schema/keywordTopAsins.test.ts`:

(a) In `'mirrors the migration columns'`, the expected column list gains `'broad_category'`:

```ts
    expect(cols).toEqual(
      ['asin', 'broad_category', 'click_share', 'conversion_share', 'search_term_id', 'slot', 'streak_started_week', 'week_end_date', 'weeks_in_top3'].sort(),
    );
```

(b) In `'creates the reverse table and its meta row exactly as the drizzle mirrors declare them'`, the first assertion becomes the 0051 columns plus 0052's:

```ts
    // 0051 created eight columns; 0052 (below) added broad_category, so the mirror is the union.
    expect([...declared(createTable('keyword_top_asins')), 'broad_category'].sort()).toEqual(mirror(getTableColumns(keywordTopAsins)));
```

(c) A new describe at the end of the file:

```ts
describe('migration 0052 SQL text', () => {
  const MARKER = '--> statement-breakpoint';
  const raw = readFileSync('db/migrations/0052_top_asins_broad_category.sql', 'utf8');
  const chunks = raw.split(MARKER);
  const statements = chunks.map((s) => s.replace(/^\s*--.*$/gm, '').trim()).filter((s) => s.length > 0);
  const flat = statements.join(' ').replace(/\s+/g, ' ');

  it('has 4 statements, one per chunk, split by 3 breakpoints', () => {
    expect(chunks).toHaveLength(4);
    expect(statements).toHaveLength(4);
    for (const s of statements) expect(s.match(/^(ALTER|COMMENT|CREATE)\b/gm) ?? []).toHaveLength(1);
  });
  it('adds the nullable code column to the live table and, when it exists, to _prev (the backfill rebuilds _prev with SELECT *)', () => {
    expect(statements[0]).toBe('ALTER TABLE keyword_top_asins ADD COLUMN IF NOT EXISTS broad_category varchar(255);');
    expect(statements[2]).toBe('ALTER TABLE IF EXISTS keyword_top_asins_prev ADD COLUMN IF NOT EXISTS broad_category varchar(255);');
    expect(getTableColumns(keywordTopAsins).broadCategory.name).toBe('broad_category');
    expect(getTableColumns(keywordTopAsins).broadCategory.notNull).toBe(false);
  });
  it('describes the column as the per-slot report code, any-of per product', () => {
    expect(statements[1]).toContain('top_clicked_category_<slot>');
    expect(statements[1]).toContain('any-of');
  });
  it('indexes (broad_category, asin) over the coded rows only, under the canonical name the swap renames', () => {
    expect(flat).toContain('CREATE INDEX IF NOT EXISTS keyword_top_asins_broad_category_idx ON keyword_top_asins (broad_category, asin) WHERE broad_category IS NOT NULL');
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run db/schema/keywordTopAsins.test.ts` → fails: file missing, `broadCategory` undefined.

- [ ] **Step 3: The migration** — create `db/migrations/0052_top_asins_broad_category.sql` (LF line endings, like 0051):

```sql
-- db/migrations/0052_top_asins_broad_category.sql
-- 0052 (hand-numbered, applied by the untracked scripts/applyMigration0052.ts on the owner's go;
-- never through drizzle-kit — the journal is frozen). Spec 2026-10-12 (products broad category) §3.
-- ADDITIVE: one nullable column on the keyword→ASIN pair table (and on its retained previous build,
-- when present, so the two stay shaped alike), and one partial index over the coded rows.
-- Safe to apply before the code that writes the column deploys: the old build's INSERT lists its
-- eight columns and leaves the ninth null.

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

- [ ] **Step 4: The mirror** — `db/schema/keywordTopAsins.ts`: import `varchar` from `drizzle-orm/pg-core` and `sql` from `drizzle-orm`; add the column after `weekEndDate` and the index after `asinIdx`; extend the header comment:

```ts
import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, varchar, smallint, numeric, integer, date, boolean, bigint, timestamp, primaryKey, index } from 'drizzle-orm/pg-core';

/**
 * Current week's top-3 clicked ASINs per keyword with consecutive-week streaks (spec 2026-10-09
 * §3.2). Rebuilt per import by lib/topAsins/buildWeek.ts; read by the ASIN page and the tools.
 * broad_category (migration 0052): the Brand Analytics code the report filed the clicked product
 * under for this keyword (top_clicked_category_<slot>), null when it gave none; a product belongs to
 * every code it carries (any-of). Indexed over the coded rows for the Products page's broad filter.
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
    /** The report's code for this clicked product (migration 0052); null when it gave none. */
    broadCategory: varchar('broad_category', { length: 255 }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.searchTermId, t.slot] }),
    asinIdx: index('keyword_top_asins_asin_idx').on(t.asin, t.searchTermId),
    broadCategoryIdx: index('keyword_top_asins_broad_category_idx').on(t.broadCategory, t.asin).where(sql`${t.broadCategory} IS NOT NULL`),
  }),
);
```

- [ ] **Step 5: Run to verify pass** — `pnpm vitest run db/schema/keywordTopAsins.test.ts lib/topAsins lib/products` → green (the column list tests in `lib/topAsins` still count eight INSERT columns: the mirror has nine, the INSERT lists eight, and those tests check membership, not equality — they change in Task 2).

- [ ] **Step 6: The apply script (UNTRACKED)** — create `scripts/applyMigration0052.ts`. The 0051 script's shape, reduced: the two ALTERs + the COMMENT in one short transaction under a 5 s lock timeout (retried up to ten times on 55P03), the index as `CREATE INDEX CONCURRENTLY` outside any transaction on the direct endpoint, validity checked (dropped and rebuilt once if invalid), then assertions.

```ts
// scripts/applyMigration0052.ts (UNTRACKED — run only on the owner's go)
/**
 * Applies db/migrations/0052_top_asins_broad_category.sql:
 *   1. the two ALTER TABLEs + the COMMENT in one short transaction under a 5-second lock_timeout
 *      (retried up to ten times: a build or a page read holding keyword_top_asins makes it wait);
 *   2. the partial index as CREATE INDEX CONCURRENTLY, outside any transaction, on the DIRECT
 *      (non-pooled) endpoint, validity checked (an invalid index is dropped and rebuilt once). Every
 *      row is still null in the new column, so the index is empty: one pass over the heap, seconds.
 * Run: APPLY_0052=yes node --env-file=.env.local --import tsx scripts/applyMigration0052.ts
 * Idempotent (IF NOT EXISTS everywhere). Expect: "4 statements", "alter: committed", "ok (Ns): CREATE INDEX
 * CONCURRENTLY…", "index valid", "assertions passed".
 */
import { readFileSync } from 'node:fs';
import { Client } from 'pg';

if (process.env.APPLY_0052 !== 'yes') { console.error('Refusing to run: set APPLY_0052=yes'); process.exit(1); }
const POOLED = process.env.DATABASE_URL;
if (!POOLED) { console.error('Refusing to run: DATABASE_URL is not set'); process.exit(1); }
/** Neon's direct endpoint: the pooled host minus "-pooler" (CONCURRENTLY wants a plain session). */
const DIRECT = POOLED.replace('-pooler.', '.');
const INDEX = 'keyword_top_asins_broad_category_idx';

class ApplyError extends Error { constructor(public readonly code: string, message: string) { super(message); this.name = 'ApplyError'; } }
const t0 = Date.now();
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`);
const code = (e: unknown) => (e as { code?: string })?.code ?? (e instanceof Error ? e.name : 'unknown');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const head = (s: string) => `${s.slice(0, 72).replace(/\s+/g, ' ')}…`;

async function connect(url: string): Promise<Client> {
  const c = new Client({ connectionString: url, statement_timeout: 1_800_000, keepAlive: true, keepAliveInitialDelayMillis: 10_000 });
  c.on('error', () => undefined);
  await c.connect();
  return c;
}

async function inTransaction(c: Client, label: string, statements: string[], lockTimeout?: string): Promise<void> {
  await c.query('BEGIN');
  try {
    if (lockTimeout) await c.query(`SET LOCAL lock_timeout = '${lockTimeout}'`);
    for (const s of statements) { await c.query(s); log(`ok: ${head(s)}`); }
    await c.query('COMMIT');
    log(`${label}: committed`);
  } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; }
}

(async () => {
  const sqlText = readFileSync('db/migrations/0052_top_asins_broad_category.sql', 'utf8');
  const statements = sqlText.split(/-->\s*statement-breakpoint/).map((s) => s.replace(/^\s*--.*$/gm, '').trim().replace(/;\s*$/, '')).filter((s) => s.length > 0);
  const alters = statements.filter((s) => /^(ALTER TABLE|COMMENT ON COLUMN)/.test(s));
  const indexes = statements.filter((s) => /^CREATE INDEX IF NOT EXISTS/.test(s)).map((s) => s.replace(/^CREATE INDEX IF NOT EXISTS/, 'CREATE INDEX CONCURRENTLY IF NOT EXISTS'));
  if (statements.length !== 4 || alters.length !== 3 || indexes.length !== 1) {
    throw new ApplyError('split_mismatch', `statements: ${statements.length} (alter ${alters.length}, index ${indexes.length})`);
  }
  log(`Applying 0052_top_asins_broad_category.sql (${statements.length} statements: ${alters.length} alter, ${indexes.length} index)`);

  const pooled = await connect(POOLED);
  let direct: Client | null = null;
  try {
    for (let attempt = 1; ; attempt++) {
      try { await inTransaction(pooled, 'alter', alters, '5s'); break; }
      catch (e) { if (code(e) !== '55P03' || attempt >= 10) throw e; log(`lock busy (attempt ${attempt}), retrying in 10 s`); await sleep(10_000); }
    }
    try { direct = await connect(DIRECT); log('direct connection ok'); }
    catch (e) { log(`direct connection failed (${code(e)}); using the pooled one`); direct = pooled; }
    for (let round = 1; round <= 2; round++) {
      const started = Date.now();
      await direct.query(indexes[0]);
      log(`ok (${((Date.now() - started) / 1000).toFixed(0)}s): ${head(indexes[0])}`);
      const valid = await pooled.query<{ n: string }>(`SELECT count(*)::text AS n FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = $1 AND i.indisvalid`, [INDEX]);
      if (valid.rows[0].n === '1') break;
      if (round === 2) throw new ApplyError('index_invalid', `${INDEX} invalid after a rebuild`);
      log(`index ${INDEX} invalid — dropping and rebuilding`);
      await direct.query(`DROP INDEX CONCURRENTLY IF EXISTS ${INDEX}`);
    }
    log('index valid');
    const col = await pooled.query<{ table_name: string }>(`SELECT table_name FROM information_schema.columns WHERE table_name IN ('keyword_top_asins', 'keyword_top_asins_prev') AND column_name = 'broad_category' ORDER BY 1`);
    if (!col.rows.some((r) => r.table_name === 'keyword_top_asins')) throw new ApplyError('column_missing', 'keyword_top_asins.broad_category missing');
    const prev = await pooled.query<{ present: boolean }>("SELECT to_regclass('keyword_top_asins_prev') IS NOT NULL AS present");
    if (prev.rows[0].present && !col.rows.some((r) => r.table_name === 'keyword_top_asins_prev')) throw new ApplyError('prev_column_missing', 'keyword_top_asins_prev exists without broad_category');
    const pred = await pooled.query<{ def: string }>(`SELECT pg_get_indexdef(indexrelid) AS def FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = $1`, [INDEX]);
    if (!/\(broad_category, asin\) WHERE \(broad_category IS NOT NULL\)/.test(pred.rows[0]?.def ?? '')) throw new ApplyError('index_shape', pred.rows[0]?.def ?? 'index missing');
    log(`assertions passed: column on keyword_top_asins${prev.rows[0].present ? ' and keyword_top_asins_prev' : ' (no _prev table)'}, partial index (broad_category, asin)`);
    log('Done.');
  } catch (e) {
    console.error('apply 0052 failed:', e instanceof ApplyError ? `${e.code}: ${e.message}` : code(e));
    process.exitCode = 1;
  } finally {
    await pooled.end().catch(() => undefined);
    if (direct && direct !== pooled) await direct.end().catch(() => undefined);
  }
})();
```

Do not run it. `pnpm exec eslint scripts/applyMigration0052.ts` and `pnpm typecheck` must pass (the script is type-checked by tsc even though untracked).

- [ ] **Step 7: Commit** (the script stays untracked):

```bash
git add db/migrations/0052_top_asins_broad_category.sql db/schema/keywordTopAsins.ts db/schema/keywordTopAsins.test.ts
git commit -m "feat(top-asins): migration 0052 — broad_category column + partial index on keyword_top_asins; drizzle mirror"
```

---

### Task 2: The build and the backfill carry the code

**Files:**
- Modify: `lib/topAsins/buildWeek.ts`
- Modify: `lib/topAsins/buildWeek.test.ts`
- Modify: `lib/topAsins/backfill.ts`
- Modify: `lib/topAsins/backfill.test.ts`

- [ ] **Step 1: Failing tests** — `lib/topAsins/buildWeek.test.ts`, inside `describe('buildTopAsinsStatements')`:

(a) New test, after `'reads the week from its year partition, three slots, well-formed ASINs only'`:

```ts
  it("carries the slot's Brand Analytics code: top_clicked_category_<slot> AS broad_category in each slot select, selected last (spec 2026-10-12 broad category §4)", () => {
    for (const st of everyMode) {
      for (const slot of [1, 2, 3]) expect(st.insert.text).toContain(`top_clicked_product_${slot}_conversion_share AS conversion_share, top_clicked_category_${slot} AS broad_category`);
      expect(st.insert.text).toMatch(/\$1::date,\s+p\.broad_category\s+FROM \(/);
      expect(st.insert.text).toContain('week_end_date, broad_category)');
    }
  });
```

(b) In the carry-from-nothing test (`'reads the carry from the right table, or from nothing'`), the regex `/p\.conversion_share,\s+1,\s+\$1::date,\s+\$1::date\s+FROM \(/` becomes `/p\.conversion_share,\s+1,\s+\$1::date,\s+\$1::date,\s+p\.broad_category\s+FROM \(/`.

(c) In `'names only real columns'`: the kwm regex gains the category columns and the counts grow:

```ts
      const kwmCols = new Set([...st.insert.text.matchAll(/\b(top_clicked_product_[123]_(?:asin|click_share|conversion_share)|top_clicked_category_[123]|search_term_id|week_end_date)\b/g)].map((m) => m[1]));
      expect(kwmCols.size).toBe(14);
      ...
      expect(insertCols).toHaveLength(9);
```

(d) The three swap tests gain the third index's renames. Both renames are `IF EXISTS`, and the same-week swap first moves a canonical name off `_prev`: an OLD-code build between the apply of 0052 and the deploy carries the index along unrenamed (LIKE names it `keyword_top_asins_next_broad_category_asin_idx` on the new live table while the canonical name moves to `_prev`), and index names are schema-wide, so a fixed-name rename would fail with 42704 (source gone) or 42P07 (target taken by `_prev`) on every later build. Advance (`'advance: retires the old _prev …'`): the expected list becomes

```ts
      'DROP TABLE IF EXISTS keyword_top_asins_prev',
      'ALTER TABLE keyword_top_asins RENAME TO keyword_top_asins_prev',
      'ALTER INDEX keyword_top_asins_asin_idx RENAME TO keyword_top_asins_prev_asin_idx',
      'ALTER INDEX IF EXISTS keyword_top_asins_broad_category_idx RENAME TO keyword_top_asins_prev_broad_category_idx',
      'ALTER TABLE keyword_top_asins_prev RENAME CONSTRAINT keyword_top_asins_pkey TO keyword_top_asins_prev_pkey',
      PREV_COMMENT,
      'ALTER TABLE keyword_top_asins_next RENAME TO keyword_top_asins',
      CURRENT_COMMENT,
      'ALTER INDEX keyword_top_asins_next_asin_search_term_id_idx RENAME TO keyword_top_asins_asin_idx',
      'ALTER INDEX IF EXISTS keyword_top_asins_next_broad_category_asin_idx RENAME TO keyword_top_asins_broad_category_idx',
      'ALTER TABLE keyword_top_asins RENAME CONSTRAINT keyword_top_asins_next_pkey TO keyword_top_asins_pkey',
```

Same-week (`'same-week rebuild: …'`): the expected list becomes `'DROP TABLE keyword_top_asins'`, then the guard `'ALTER INDEX IF EXISTS keyword_top_asins_broad_category_idx RENAME TO keyword_top_asins_prev_broad_category_idx'`, then the promote lines (with the `IF EXISTS` promote rename right after the `_next_asin_search_term_id_idx` rename); its `not.toContain('keyword_top_asins_prev')` assertion becomes "names `_prev` only in the guard": `expect(swapOf(st).filter((t) => t.includes('keyword_top_asins_prev'))).toEqual(['ALTER INDEX IF EXISTS keyword_top_asins_broad_category_idx RENAME TO keyword_top_asins_prev_broad_category_idx'])`. Rewind: only the `IF EXISTS` promote rename is inserted after the `_next_asin_search_term_id_idx` rename (it drops `_prev`, so no guard). Add one more test:

```ts
  it('tolerates the drifted names an old-code build leaves between the apply of 0052 and the deploy: both broad-index renames are IF EXISTS, and the same-week swap first moves a canonical name off _prev', () => {
    for (const st of everyMode) {
      for (const t of swapOf(st).filter((t) => t.includes('broad_category'))) expect(t).toMatch(/^ALTER INDEX IF EXISTS /);
    }
    const sameWeek = swapOf(sameWeekPrev);
    expect(sameWeek.indexOf('ALTER INDEX IF EXISTS keyword_top_asins_broad_category_idx RENAME TO keyword_top_asins_prev_broad_category_idx')).toBe(sameWeek.indexOf('DROP TABLE keyword_top_asins') + 1);
    expect(swapOf(rewind).some((t) => t.endsWith('RENAME TO keyword_top_asins_prev_broad_category_idx'))).toBe(false);
  });
```

`lib/topAsins/backfill.test.ts`:

(e) `'names only real columns'` (in `describe('backfillWeekStatements')`): the same regex, `14` and `9` as (c).

(f) In `describe('finalizeStatements')`: `"swaps like a build's same-week rebuild …"` compares against the build's same-week swap as before (`buildSwapOf({ carryFrom: 'none', sameWeek: true })`), so it now expects the guard and the `IF EXISTS` promote rename too and `toHaveLength(7)`; the test name `'keeps the previous week walked as keyword_top_asins_prev: … (all eight columns, …)'` says `all nine columns`. Add after the swap test:

```ts
  it("renames the third index (broad_category, asin) by the name LIKE gives it on _next, IF EXISTS, after the asin index", () => {
    const texts = f.swap.map((s) => norm(s.text));
    const asin = texts.indexOf('ALTER INDEX keyword_top_asins_next_asin_search_term_id_idx RENAME TO keyword_top_asins_asin_idx');
    expect(asin).toBeGreaterThanOrEqual(0);
    expect(texts[asin + 1]).toBe('ALTER INDEX IF EXISTS keyword_top_asins_next_broad_category_asin_idx RENAME TO keyword_top_asins_broad_category_idx');
  });
```

(The backfill recreates `_prev` with `CREATE TABLE … AS SELECT *`, which carries no index, so its swap's guard is a no-op there; it stays because the swap is the build's own.)

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run lib/topAsins` → the new and changed assertions fail.

- [ ] **Step 3: buildWeek.ts** — four edits:

(a) `slotSelect`:

```ts
export function slotSelect(partition: string, slot: 1 | 2 | 3): string {
  return `SELECT search_term_id, top_clicked_product_${slot}_asin AS asin, ${slot}::smallint AS slot,
                 top_clicked_product_${slot}_click_share AS click_share, top_clicked_product_${slot}_conversion_share AS conversion_share, top_clicked_category_${slot} AS broad_category
          FROM ${partition}
          WHERE week_end_date = $1::date AND top_clicked_product_${slot}_asin ~ ${ASIN_RE}`;
}
```

(b) `insertText`: the column list and both select forms end with the code:

```ts
  const head = `INSERT INTO keyword_top_asins_next (search_term_id, asin, slot, click_share, conversion_share, weeks_in_top3, streak_started_week, week_end_date, broad_category)
             SELECT p.search_term_id, p.asin, p.slot, p.click_share, p.conversion_share,`;
  ...
  if (carryFrom === 'none') {
    return `${head}
                    1,
                    $1::date,
                    $1::date,
                    p.broad_category
             FROM ${slots}`;
  }
  return `${head}
                    COALESCE(prev.weeks_in_top3, 0) + 1,
                    COALESCE(prev.streak_started_week, $1::date),
                    $1::date,
                    p.broad_category
             FROM ${slots}
             LEFT JOIN (
```

(c) `swapStatements`:

```ts
/** The broad-category index's names: canonical on the live table, _prev's after an advance, LIKE's on _next (spec 2026-10-12 broad category §4). */
const BROAD_INDEX = { current: 'keyword_top_asins_broad_category_idx', prev: 'keyword_top_asins_prev_broad_category_idx', next: 'keyword_top_asins_next_broad_category_asin_idx' } as const;
/**
 * Moves a canonical broad-index name off _prev, where an old-code build leaves it (its swap carried the index
 * along unrenamed; index names are schema-wide), so the promote below can take the name. A no-op after a new-code
 * advance, which renamed it already.
 */
const PREV_BROAD_GUARD = sql(`ALTER INDEX IF EXISTS ${BROAD_INDEX.current} RENAME TO ${BROAD_INDEX.prev}`);
```

`promoteNext` gains, after the asin rename, `sql(\`ALTER INDEX IF EXISTS ${BROAD_INDEX.next} RENAME TO ${BROAD_INDEX.current}\`)`; the rewind list is `[DROP _prev, DROP current, ...promoteNext]` as before; the same-week list becomes `[sql('DROP TABLE keyword_top_asins'), PREV_BROAD_GUARD, ...promoteNext]`; the advance list gains, after `'ALTER INDEX keyword_top_asins_asin_idx RENAME TO keyword_top_asins_prev_asin_idx'`, `PREV_BROAD_GUARD` (the same statement: on an advance the current table has just become `_prev`, so this is its proper rename). Both broad renames are `IF EXISTS` because between the apply of 0052 and the deploy an old-code build can leave the live table's index under LIKE's generated name (and `_next`'s copy then as `…_asin_idx1`): a missing source is skipped and the names converge within two builds; a build never fails over a name. Update the function's doc comment: "its primary key `<table>_pkey` and its other indexes `<table>_<columns>_idx`, so _next's are the three literals below; the broad-index renames tolerate the drift an old-code build leaves (see PREV_BROAD_GUARD)".

(d) Header comment: after the first paragraph add: "Each row also carries `broad_category`, the report's code for that clicked product (`top_clicked_category_<slot>` of the same kwm row; migration 0052), so the Products page can filter by the Explorer's broad categories; the swap renames its partial index like the asin index." In the swap paragraph, "the two names" → "the three names" where it describes what LIKE generates.

- [ ] **Step 4: backfill.ts** — `backfillWeekStatements`'s INSERT: the column list ends `week_end_date, broad_category)` and the select adds `p.broad_category` after the `$1::date` line (same shape as the build's carry form). `finalizeStatements.swap` is the build's same-week swap: after `'DROP TABLE keyword_top_asins'` add `sql('ALTER INDEX IF EXISTS keyword_top_asins_broad_category_idx RENAME TO keyword_top_asins_prev_broad_category_idx')` and after the `_next_asin_search_term_id_idx` rename add `sql('ALTER INDEX IF EXISTS keyword_top_asins_next_broad_category_asin_idx RENAME TO keyword_top_asins_broad_category_idx')` (export `PREV_BROAD_GUARD` and `BROAD_INDEX` from buildWeek.ts and reuse them if that reads better; the statement texts must be identical to the build's). The `prev` doc comment: "all nine columns as a build-made _prev has". The header's line about `_bf_prev` (`SELECT *, all eight columns`) → nine.

- [ ] **Step 4b: spec §4** — in `docs/superpowers/specs/2026-10-12-products-broad-category-design.md` §4, after the swap bullet, add: "Both broad-index renames are `ALTER INDEX IF EXISTS`, and the same-week swap first renames a canonical name found on `_prev` to `_prev`'s name: an old-code build between the apply of 0052 and the deploy carries the index along unrenamed (index names are schema-wide), and a fixed-name rename would otherwise fail on every later build. The names converge within two builds; nothing else depends on them."

- [ ] **Step 5: Run to verify pass** — `pnpm vitest run lib/topAsins db/schema` → green. `pnpm typecheck`; `pnpm exec eslint lib/topAsins/buildWeek.ts lib/topAsins/buildWeek.test.ts lib/topAsins/backfill.ts lib/topAsins/backfill.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add lib/topAsins/buildWeek.ts lib/topAsins/buildWeek.test.ts lib/topAsins/backfill.ts lib/topAsins/backfill.test.ts docs/superpowers/specs/2026-10-12-products-broad-category-design.md
git commit -m "feat(top-asins): the build and the backfill carry each slot's Brand Analytics code and rename the broad_category index in the swap (IF EXISTS, drift-tolerant)"
```

---

### Task 3: `ProductFilters.broadCategory` and the `broad` URL key

**Files:**
- Modify: `lib/products/filterParams.ts`
- Modify: `lib/products/filters.ts`
- Modify: `lib/products/filters.test.ts`
- Modify (interim lines, full-literal sites): `lib/research/contracts.ts` (`toProductFilters`), `app/(app)/products/ProductFilterPanel.tsx` (`pendingToFilters`), `app/(app)/products/ProductFilterPanel.test.tsx` (`SEEDED`)

- [ ] **Step 1: Failing tests** — `lib/products/filters.test.ts`:

(a) The full-literal fixture near line 38 (the object with `dept: 'Home & Kitchen', leafPaths: […], customCategoryIds: [ID1, ID2]`) gains `broadCategory: 'Home'` right after `dept`; the test that round-trips it through the URL string expects `&broad=Home` between `dept=Home+%26+Kitchen` and the first `leaf=` (the serialiser writes dept, broad, leaf). The `toEqual({ … dept: null, leafPaths … })` literal in `'parses every filter and ignores junk'` gains `broadCategory: null` after `dept: null`.

(b) New tests, after `'dept is trimmed; blank or over-long values fall back to null'`:

```ts
  it('reads broad (one Brand Analytics code) trimmed; blank, over-long or control-character values fall back to null (spec 2026-10-12 broad category §5)', () => {
    expect(parseProductFilters({ broad: ' Pet Supplies ' }).broadCategory).toBe('Pet Supplies');
    expect(parseProductFilters({ broad: 'Home' })).toEqual({ ...PRODUCT_DEFAULTS, broadCategory: 'Home' });
    expect(parseProductFilters({ broad: '   ' }).broadCategory).toBeNull();
    expect(parseProductFilters({ broad: 'x'.repeat(255) }).broadCategory).toBe('x'.repeat(255));
    expect(parseProductFilters({ broad: 'x'.repeat(256) }).broadCategory).toBeNull();
    expect(parseProductFilters({ broad: 'x\u001fy' }).broadCategory).toBeNull();
    expect(parseProductFilters({ broad: ['Home', 'Toys'] }).broadCategory).toBe('Home'); // a repeated key: the first value
    expect(PRODUCT_DEFAULTS.broadCategory).toBeNull();
    expect(PRODUCT_MAX_BROAD_CATEGORY_LENGTH).toBe(255);
  });
  it('writes broad after dept and before leaf, and omits it when null', () => {
    expect(productFiltersToSearchParams({ ...PRODUCT_DEFAULTS, dept: 'Pet Supplies', broadCategory: 'Home', leafPaths: ['Pet Supplies › Dogs'] }).toString()).toBe(
      'dept=Pet+Supplies&broad=Home&leaf=Pet+Supplies+%E2%80%BA+Dogs',
    );
    expect(productFiltersToSearchParams(PRODUCT_DEFAULTS).toString()).toBe('');
    expect(parseProductFilters(Object.fromEntries(productFiltersToSearchParams({ ...PRODUCT_DEFAULTS, broadCategory: 'Misc SDP' })))).toEqual({ ...PRODUCT_DEFAULTS, broadCategory: 'Misc SDP' });
  });
```

Add `PRODUCT_MAX_BROAD_CATEGORY_LENGTH` to the file's import from `./filters`.

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run lib/products/filters.test.ts`.

- [ ] **Step 3: filterParams.ts** — after `PRODUCT_MAX_CUSTOM_IDS`:

```ts
/** The widest `broad` value a URL may carry: keyword_top_asins.broad_category is varchar(255). */
export const PRODUCT_MAX_BROAD_CATEGORY_LENGTH = 255;
```

In `ProductFilters`, after `dept`:

```ts
  /** One Brand Analytics code ('Home', 'Pet Supplies'): the product was a top-3 clicked product this week under a keyword filed with it, any of its codes (spec 2026-10-12 broad category §5). */
  broadCategory: string | null;
```

`PRODUCT_DEFAULTS`: `dept: null, broadCategory: null, leafPaths: [], …`. In `productFiltersToSearchParams`, after `set('dept', f.dept, null);` on the same line: `set('broad', f.broadCategory, null);`.

- [ ] **Step 4: filters.ts** — import `PRODUCT_MAX_BROAD_CATEGORY_LENGTH` from `./filterParams`; in the schema after `dept`: `broadCategory: z.string().trim().min(1).max(PRODUCT_MAX_BROAD_CATEGORY_LENGTH).nullable(),`. After `department`:

```ts
/** A trimmed `broad` value worth keeping: non-empty, at most PRODUCT_MAX_BROAD_CATEGORY_LENGTH, no control characters. */
const usableCode = (s: string): boolean => s.length > 0 && s.length <= PRODUCT_MAX_BROAD_CATEGORY_LENGTH && !CONTROL_CHARS.test(s);
/** One `broad` value (a Brand Analytics code), kept only when its trimmed form is a usableCode; else null. */
const broadCategory = (v: string | undefined): string | null => (v !== undefined && usableCode(v.trim()) ? v : null);
```

In `parseProductFilters`'s `raw`: `dept: department(one(sp.dept)), broadCategory: broadCategory(one(sp.broad)), leafPaths: …`. Update the header comment's spec reference line: "categories, spec 2026-10-12 §3; the broad category, spec 2026-10-12 (broad category) §5".

- [ ] **Step 5: The interim full-literal lines** (so `pnpm typecheck` stays clean; Tasks 6 and 8 replace them):
  - `lib/research/contracts.ts`, `toProductFilters`: after `dept: f.department ?? PRODUCT_DEFAULTS.dept,` add `broadCategory: PRODUCT_DEFAULTS.broadCategory, // mapped from filters.broadCategory in Task 8`.
  - `app/(app)/products/ProductFilterPanel.tsx`, `pendingToFilters`: after `dept: p.dept === '' ? null : p.dept,` add `broadCategory: null, // the select lands in Task 6`.
  - `app/(app)/products/ProductFilterPanel.test.tsx`, `SEEDED`: after `dept: 'Home & Kitchen',` add `broadCategory: null,`.
  - Run `pnpm typecheck` and fix any other full-literal site it names the same way (a `ProductFilters` object literal missing `broadCategory`).

- [ ] **Step 6: Run to verify pass** — `pnpm vitest run lib/products app/\(app\)/products lib/research` → green; `pnpm typecheck`; `pnpm exec eslint lib/products/filterParams.ts lib/products/filters.ts lib/products/filters.test.ts lib/research/contracts.ts "app/(app)/products/ProductFilterPanel.tsx" "app/(app)/products/ProductFilterPanel.test.tsx"`.

- [ ] **Step 7: Commit**

```bash
git add lib/products/filterParams.ts lib/products/filters.ts lib/products/filters.test.ts lib/research/contracts.ts "app/(app)/products/ProductFilterPanel.tsx" "app/(app)/products/ProductFilterPanel.test.tsx"
git commit -m "feat(products): ProductFilters.broadCategory — one Brand Analytics code, URL key broad, bounded to the column's 255"
```

---

### Task 4: The search predicate

**Files:**
- Modify: `lib/products/searchProducts.ts`
- Modify: `lib/products/searchProducts.test.ts`

- [ ] **Step 1: Failing tests** — in `describe('productSearchSql')`, after `'the category fields of the filters object are not read: the scope alone decides'`:

```ts
  it('broadCategory is a semi-join on the pair table: EXISTS over keyword_top_asins by ASIN and code, through keyword_top_asins_broad_category_idx (spec 2026-10-12 broad category §5)', () => {
    const q = productSearchSql({ ...PRODUCT_DEFAULTS, broadCategory: 'Home' }, EMPTY_CATEGORY_SCOPE);
    expect(q.rows.text).toContain('EXISTS (SELECT 1 FROM keyword_top_asins k WHERE k.asin = a.asin AND k.broad_category = $1::text) AND a.monthly_sold IS NOT NULL');
    expect(q.rows.values).toEqual(['Home', 50, 0]);
    expect(q.count.text).toContain('k.broad_category = $1::text');
    expect(q.count.values).toEqual(['Home']);
    expect(dbCols(keywordTopAsins).has('broad_category')).toBe(true);
  });
  it('the broad category predicate follows the category scope and precedes the offer filters', () => {
    const scope: ProductCategoryScope = { dept: 'Tools', subtreePaths: [], exactPaths: [], scoped: false };
    const q = productSearchSql({ ...PRODUCT_DEFAULTS, dept: 'Tools', broadCategory: 'Home', fba: 'no' }, scope);
    expect(q.rows.text).toContain(
      '(a.category_path = $1::text OR starts_with(a.category_path, $2::text)) AND EXISTS (SELECT 1 FROM keyword_top_asins k WHERE k.asin = a.asin AND k.broad_category = $3::text) AND a.fba_offer_count = 0',
    );
    expect(q.rows.values).toEqual(['Tools', 'Tools › ', 'Home', 50, 0]);
  });
  it('no predicate and no bind for a null broad category', () => {
    expect(productSearchSql(PRODUCT_DEFAULTS, EMPTY_CATEGORY_SCOPE).rows.text).not.toContain('broad_category');
  });
```

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run lib/products/searchProducts.test.ts`.

- [ ] **Step 3: Implement** — in `productSearchSql`, after `if (category !== null) where.push(category);`:

```ts
  // Any-of over the product's pair rows this week (spec 2026-10-12 broad category §5): a semi-join the planner
  // serves through keyword_top_asins_broad_category_idx (= $n implies IS NOT NULL, the index's predicate).
  if (f.broadCategory !== null) where.push(`EXISTS (SELECT 1 FROM keyword_top_asins k WHERE k.asin = a.asin AND k.broad_category = ${bind(f.broadCategory)}::text)`);
```

Header comment: extend the index sentence — "… 0050's asin_products_category_path_idx for the category predicate (see ./categoryPredicate), and 0052's keyword_top_asins_broad_category_idx for the broad-category semi-join."

- [ ] **Step 4: Run to verify pass** — `pnpm vitest run lib/products/searchProducts.test.ts`; `pnpm typecheck`; `pnpm exec eslint lib/products/searchProducts.ts lib/products/searchProducts.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add lib/products/searchProducts.ts lib/products/searchProducts.test.ts
git commit -m "feat(products): broad-category predicate — EXISTS over keyword_top_asins by ASIN and code"
```

---

### Task 5: `listProductBroadCategories`

**Files:**
- Modify: `lib/products/listCategories.ts`
- Modify: `lib/products/listCategories.test.ts`

- [ ] **Step 1: Failing tests** — `lib/products/listCategories.test.ts`:

(a) The `neon` mock gains a `query(text)` method (the new loader runs a fixed statement with no holes): replace the `neon` factory with

```ts
vi.mock('@neondatabase/serverless', () => ({
  // neon()'s tagged template: the statement with a ? per hole, and the hole values. query(text): a fixed statement.
  neon: () => {
    const tagged = async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?').replace(/\s+/g, ' ').trim();
      neonMock.queries.push({ text, values });
      return neonMock.answer(text, values);
    };
    return Object.assign(tagged, {
      query: async (text: string) => {
        const t = text.replace(/\s+/g, ' ').trim();
        neonMock.queries.push({ text: t, values: [] });
        return neonMock.answer(t, []);
      },
    });
  },
}));
```

(b) Import `BROAD_CATEGORY_LIST_SQL, listProductBroadCategories` from `./listCategories`. In `beforeEach`, the answer gains `if (text.includes('WITH RECURSIVE codes')) return BROAD_ROWS;` with `const BROAD_ROWS = [{ code: 'Toys' }, { code: 'Home' }, { code: 'Misc SDP' }];` declared beside `DEPARTMENT_ROWS`.

(c) New tests in `describe('the loaders')`:

```ts
  it('lists the codes present on the pair table by a loose index scan (one probe per code), in code-unit order', async () => {
    await expect(listProductBroadCategories()).resolves.toEqual(['Home', 'Misc SDP', 'Toys']);
    expect(neonMock.queries).toHaveLength(1);
    expect(neonMock.queries[0].text).toBe(BROAD_CATEGORY_LIST_SQL.replace(/\s+/g, ' ').trim());
    expect(neonMock.queries[0].text).toBe(
      'WITH RECURSIVE codes AS ( (SELECT broad_category AS code FROM keyword_top_asins WHERE broad_category IS NOT NULL ORDER BY broad_category LIMIT 1) UNION ALL SELECT (SELECT k.broad_category FROM keyword_top_asins k WHERE k.broad_category > c.code ORDER BY k.broad_category LIMIT 1) FROM codes c WHERE c.code IS NOT NULL ) SELECT code FROM codes WHERE code IS NOT NULL',
    );
  });
  it('an empty pair table gives an empty code list; a failed read rejects (never an empty list cached for an hour)', async () => {
    neonMock.answer = () => [];
    await expect(listProductBroadCategories()).resolves.toEqual([]);
    neonMock.answer = () => { throw Object.assign(new Error('cold'), { code: '57014' }); };
    await expect(listProductBroadCategories()).rejects.toMatchObject({ code: '57014' });
  });
```

(d) `'registers the two caches under their own key parts, …'` becomes three: its name says "three caches", and it asserts the third registration `{ keyParts: ['product-broad-categories', BROAD_CATEGORY_LIST_SQL], options: { revalidate: 3600, tags: [PRODUCT_CATEGORIES_TAG] } }` (read the test's existing shape for the first two and extend it). The source-text test asserts `cacheMock.sources[2]` contains `BROAD_CATEGORY_LIST_SQL` by name (`'sql.query(BROAD_CATEGORY_LIST_SQL)'`) — the statement text itself is in the key parts, which is what makes an edit to it a new cache entry.

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run lib/products/listCategories.test.ts`.

- [ ] **Step 3: Implement** — in `lib/products/listCategories.ts`, after `listProductCategoryPaths`:

```ts
/**
 * The Brand Analytics codes present on the keyword→ASIN pair table (spec 2026-10-12 broad category §6): what the
 * Products page's broad filter can match (120 today; the Explorer's slot-1 list has 102). A loose index scan:
 * one probe of keyword_top_asins_broad_category_idx per code, whatever the table size. The text is also a
 * key part of the cache below, so an edit to it starts a new entry (the callback does not inline it).
 */
export const BROAD_CATEGORY_LIST_SQL = `WITH RECURSIVE codes AS (
  (SELECT broad_category AS code FROM keyword_top_asins WHERE broad_category IS NOT NULL ORDER BY broad_category LIMIT 1)
  UNION ALL
  SELECT (SELECT k.broad_category FROM keyword_top_asins k WHERE k.broad_category > c.code ORDER BY k.broad_category LIMIT 1)
  FROM codes c WHERE c.code IS NOT NULL
)
SELECT code FROM codes WHERE code IS NOT NULL`;

/** The codes in code-unit order (the recursion walks the index in the database's collation; re-sorted here). */
async function fetchBroadCategoriesSorted(): Promise<string[]> {
  const sql = neon(env.DATABASE_URL);
  const rows = (await sql.query(BROAD_CATEGORY_LIST_SQL)) as Array<{ code: string }>;
  return rows.map((r) => r.code).sort(compareCodeUnits);
}

/** fetchBroadCategoriesSorted, cached an hour under its statement text (see BROAD_CATEGORY_LIST_SQL) and deduped per render. */
export const listProductBroadCategories = cache(
  unstable_cache(fetchBroadCategoriesSorted, ['product-broad-categories', BROAD_CATEGORY_LIST_SQL], { revalidate: REVALIDATE_SECONDS, tags: [PRODUCT_CATEGORIES_TAG] }),
);
```

Header comment: add a third bullet for the list ("listProductBroadCategories: the codes on keyword_top_asins, one index probe each") and note that this cache keys on the statement text explicitly. `PRODUCT_CATEGORIES_TAG`'s comment: "One tag for the three lists".

- [ ] **Step 4: Run to verify pass** — `pnpm vitest run lib/products/listCategories.test.ts`; `pnpm typecheck`; `pnpm exec eslint lib/products/listCategories.ts lib/products/listCategories.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add lib/products/listCategories.ts lib/products/listCategories.test.ts
git commit -m "feat(products): listProductBroadCategories — the codes on keyword_top_asins by loose index scan, cached an hour"
```

---

### Task 6: The page's fourth list and the Broad category select

Read `node_modules/next/dist/docs/01-app/` (server components, `unstable_cache`) before editing.

**Files:**
- Modify: `app/(app)/products/(list)/page.tsx`
- Modify: `app/(app)/products/(list)/page.test.tsx`
- Modify: `app/(app)/products/ProductFilterPanel.tsx`
- Modify: `app/(app)/products/ProductFilterPanel.test.tsx`

- [ ] **Step 1: Failing tests** — `app/(app)/products/ProductFilterPanel.test.tsx`:

(a) `const BROAD = ['Apparel', 'Home', 'Pet Supplies'];` beside `DEPARTMENTS`; `renderPanel` passes `broadCategories={BROAD}`.

(b) In `'renders every control at PRODUCT_DEFAULTS'`, after the Department assertions:

```ts
    expect(control('Broad category')).toHaveDisplayValue('All broad categories');
    expect(optionTexts('Broad category')).toEqual(['All broad categories', ...BROAD]);
```

(c) New tests after `'a department the list lacks (from the URL) still shows as the selected option'`:

```ts
  it('seeds the Broad category select from the applied filters (spec 2026-10-12 broad category §7)', () => {
    renderPanel({ ...PRODUCT_DEFAULTS, broadCategory: 'Home' });
    expect(control('Broad category')).toHaveDisplayValue('Home');
  });
  it('a broad category the list lacks (from the URL) still shows as the selected option', () => {
    renderPanel({ ...PRODUCT_DEFAULTS, broadCategory: 'Ebook' });
    expect(control('Broad category')).toHaveDisplayValue('Ebook');
    expect(optionTexts('Broad category')).toEqual(['All broad categories', ...BROAD, 'Ebook']);
  });
  it('picking a broad category dirties the form and Apply writes broad= beside dept=', () => {
    renderPanel({ ...PRODUCT_DEFAULTS, dept: 'Pet Supplies' });
    expect(applyButton()).toBeDisabled();
    change('Broad category', 'Home');
    expect(applyButton()).toBeEnabled();
    fireEvent.click(applyButton());
    expect(replace).toHaveBeenLastCalledWith('/products?dept=Pet+Supplies&broad=Home', { scroll: false });
  });
  it('Reset clears the broad category with everything else', () => {
    renderPanel({ ...PRODUCT_DEFAULTS, broadCategory: 'Home' });
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(control('Broad category')).toHaveDisplayValue('All broad categories');
    expect(replace).toHaveBeenLastCalledWith('/products', { scroll: false });
  });
```

(d) In the `pendingToFilters` tests (near `const tools = filtersToPending({ ...PRODUCT_DEFAULTS, dept: 'Tools' })`):

```ts
    const home = filtersToPending({ ...PRODUCT_DEFAULTS, broadCategory: 'Home' });
    expect(home.broad).toBe('Home');
    expect(pendingToFilters(home).broadCategory).toBe('Home');
    expect(pendingToFilters({ ...home, broad: '' }).broadCategory).toBeNull();
```

`app/(app)/products/(list)/page.test.tsx`:

(e) `data` gains `broad: vi.fn()`; the `listCategories` mock gains `listProductBroadCategories: data.broad`; `beforeEach`: `data.broad.mockResolvedValue(['Home', 'Pet Supplies']);`; both redirect tests' `for (const fn of […])` lists gain `data.broad`; the admin test asserts `expect(data.broad).toHaveBeenCalledTimes(1);` and `expect(screen.getByLabelText('Broad category')).toHaveDisplayValue('All broad categories');` plus `expect(within(screen.getByLabelText('Broad category')).getByRole('option', { name: 'Home' })).toBeInTheDocument();`; the failed-read test also does `data.broad.mockRejectedValue(new Error('cold'));` and asserts the Broad category options are `['All broad categories']`.

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run "app/(app)/products"`.

- [ ] **Step 3: ProductFilterPanel.tsx** —
  - `PendingProductFilters` gains `broad: string;` after `dept` (doc: `/** The Broad category select's value ('' = all). */`).
  - `filtersToPending`: `broad: f.broadCategory ?? '',` after `dept`.
  - `pendingToFilters`: replace the Task 3 interim line with `broadCategory: p.broad === '' ? null : p.broad,`.
  - Props: `broadCategories: string[];` with doc `/** The Brand Analytics codes on the pair table (lib/products/listCategories), the Broad category select's options. */`; destructure it.
  - Beside `departmentOptions`: `const broadOptions = pending.broad === '' || broadCategories.includes(pending.broad) ? broadCategories : [...broadCategories, pending.broad];`
  - The select, directly after the Department `</Field>`:

```tsx
            <Field label="Broad category" htmlFor="pf-broad">
              <select id="pf-broad" value={pending.broad} onChange={(e) => set('broad', e.target.value)} className={INPUT}>
                <option value="">All broad categories</option>
                {broadOptions.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <p className={HINT}>The Brand Analytics code the product was clicked under this week (the Explorer&apos;s broad categories). A product can carry several.</p>
            </Field>
```

  - The component's doc comment: "The page hands it four lists: the departments, the Brand Analytics codes, the category paths and the user's custom categories."

- [ ] **Step 4: page.tsx** — import `listProductBroadCategories` with the other two; in `loadProductsPage`:

```ts
  const [result, departments, broadCategories, leafCategories, customCategories] = await Promise.all([
    searched,
    listProductDepartments().catch(() => [] as string[]),
    listProductBroadCategories().catch(() => [] as string[]),
    listProductCategoryPaths().catch(() => [] as string[]),
    listCustomCategoriesForUser(userId),
  ]);
  return { result, departments, broadCategories, leafCategories, customCategories, now: new Date() };
```

`ProductsResults` destructures and passes `broadCategories={broadCategories}`; the comment above the `Promise.all` says "A failed department, broad-category or path read shows an empty list"; the doc comments mention four option lists.

- [ ] **Step 5: Run to verify pass** — `pnpm vitest run "app/(app)/products"`; `pnpm typecheck`; `pnpm exec eslint "app/(app)/products/(list)/page.tsx" "app/(app)/products/(list)/page.test.tsx" "app/(app)/products/ProductFilterPanel.tsx" "app/(app)/products/ProductFilterPanel.test.tsx"`.

- [ ] **Step 6: Commit**

```bash
git add "app/(app)/products/(list)/page.tsx" "app/(app)/products/(list)/page.test.tsx" "app/(app)/products/ProductFilterPanel.tsx" "app/(app)/products/ProductFilterPanel.test.tsx"
git commit -m "feat(products): Broad category select under Department, fed by the cached code list"
```

---

### Task 7: The ASIN page's codes

**Files:**
- Modify: `lib/products/loadProduct.ts`
- Modify: `lib/products/loadProduct.test.ts`
- Modify: `app/(app)/products/[asin]/FactsCard.tsx`
- Modify: `app/(app)/products/[asin]/FactsCard.test.tsx`
- Modify (full-literal `ProductFacts` sites, `broadCategories: []`): `app/(app)/products/[asin]/page.test.tsx` (`CATALOG_ROW`, `STUB`), `lib/research/products.test.ts` (`catalogFacts`, `stubFacts`), `lib/research/service.test.ts` (the literal near line 424)
- Modify: `docs/superpowers/specs/2026-10-12-products-broad-category-design.md` (§8, one clause)

- [ ] **Step 1: Failing tests** — `lib/products/loadProduct.test.ts`:

(a) Import `productBroadCategoriesSql`; `fakeRun` answers it: `if (text === productBroadCategoriesSql('x').text) return results.codes ?? [];` with `codes?: unknown[]` in its parameter type; `const CODES_TEXT = productBroadCategoriesSql('x').text;`.

(b) `ACTIVE`, `NEVER_FETCHED`, `UNTRACKED` gain `broadCategories: []` (after `tier`).

(c) New describe after `describe('productTrackedSql')`:

```ts
describe('productBroadCategoriesSql', () => {
  const q = productBroadCategoriesSql('B000000004');
  it("lists the ASIN's codes, most keywords first, ties by code (spec 2026-10-12 broad category §8)", () => {
    expect(q.text.replace(/\s+/g, ' ')).toBe(
      'SELECT k.broad_category FROM keyword_top_asins k WHERE k.asin = $1 AND k.broad_category IS NOT NULL GROUP BY k.broad_category ORDER BY count(*) DESC, k.broad_category',
    );
    expect(q.values).toEqual(['B000000004']);
  });
  it('names only real columns', () => {
    expect(notIn(aliasCols(q.text, 'k'), dbCols(keywordTopAsins))).toEqual([]);
  });
});
```

(d) `loadProduct` tests: `'maps an active row …'` now sees two calls (`expect(calls).toHaveLength(2); // facts and codes; the catalog has the title: no keyword-side read` and `expect(calls.map((c) => c.text)).toEqual([FACTS_TEXT, CODES_TEXT]);`); the stub test's call list becomes `[FACTS_TEXT, CODES_TEXT, TRACKED_TEXT, FALLBACK_TEXT]` with four `['B000000003']` value arrays; the null test's `[FACTS_TEXT, CODES_TEXT, TRACKED_TEXT]`. New tests:

```ts
  it('carries the codes, most keywords first, on a catalog row and on a stub', async () => {
    const codes = [{ broad_category: 'Home' }, { broad_category: 'Pet Supplies' }];
    await expect(loadProduct(fakeRun({ facts: [rawRow()], codes }).run, 'B000000001')).resolves.toEqual({ ...ACTIVE, broadCategories: ['Home', 'Pet Supplies'] });
    await expect(loadProduct(fakeRun({ facts: [], codes, tracked: [{ '?column?': 1 }], fallback: [] }).run, 'B000000003')).resolves.toEqual({ ...UNTRACKED, broadCategories: ['Home', 'Pet Supplies'] });
  });
```

In `'reads exactly the columns the facts statement selects'`, the runner must answer the codes statement with no rows: `await loadProduct(async (text) => (text === CODES_TEXT ? [] : [row]), 'B000000001');`.

`app/(app)/products/[asin]/FactsCard.test.tsx`: `FULL` gains `broadCategories: ['Home', 'Pet Supplies'],`; in `'renders every label with its value …'` add `expect(fact('Broad categories')).toHaveTextContent('Home, Pet Supplies');`; new test in the same describe:

```ts
  it('a product with no coded keyword rows reads a dash for its broad categories', () => {
    render(<FactsCard facts={{ ...FULL, broadCategories: [] }} now={NOW} />);
    expect(fact('Broad categories')).toHaveTextContent('—');
  });
```

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run lib/products/loadProduct.test.ts "app/(app)/products/[asin]/FactsCard.test.tsx"`.

- [ ] **Step 3: loadProduct.ts** —
  - `ProductFacts` gains, after `tier`: `/** The Brand Analytics codes of the ASIN's pair rows this week, most keywords first; [] when it has none or none coded (spec 2026-10-12 broad category §8). */ broadCategories: string[];`
  - After `productTrackedSql`:

```ts
/** The ASIN's codes on the pair table, most keywords first (ties by code), through keyword_top_asins_asin_idx. */
export function productBroadCategoriesSql(asin: string): SqlStatement {
  return {
    text: `SELECT k.broad_category FROM keyword_top_asins k
WHERE k.asin = $1 AND k.broad_category IS NOT NULL
GROUP BY k.broad_category ORDER BY count(*) DESC, k.broad_category`,
    values: [asin],
  };
}
```

  - `toFacts(r, title, broadCategories: string[])` and `untrackedStub(asin, title, broadCategories: string[])` set `broadCategories` last.
  - `loadProduct`: the facts and codes reads start together; the rest is unchanged:

```ts
export async function loadProduct(run: SqlRunner, asin: string): Promise<ProductFacts | null> {
  const facts = productFactsSql(asin);
  const codes = productBroadCategoriesSql(asin);
  const [rows, codeRows] = await Promise.all([
    run(facts.text, facts.values) as Promise<FactsRow[]>,
    run(codes.text, codes.values) as Promise<Array<{ broad_category: string }>>,
  ]);
  const broadCategories = codeRows.map((r) => r.broad_category);
  const row = rows[0];
  if (row) return toFacts(row, nonBlank(row.title) ?? (await keywordSideTitle(run, asin)), broadCategories);
  const tracked = productTrackedSql(asin);
  if (((await run(tracked.text, tracked.values)) as unknown[]).length === 0) return null;
  return untrackedStub(asin, await keywordSideTitle(run, asin), broadCategories);
}
```

  Update the function's doc comment ("The facts for one ASIN: the primary-key read and the codes read, together …") and the header's list of what the loader returns.

- [ ] **Step 4: FactsCard.tsx** — after the Category fact:

```tsx
          <Fact label="Broad categories" wide>
            {facts.broadCategories.length > 0 ? facts.broadCategories.join(', ') : DASH}
          </Fact>
```

Header comment: add "The Brand Analytics codes of its keyword rows this week read as one line, most keywords first (a dash when none)." The "Not fetched yet" and "Not in the catalog" shapes are unchanged.

- [ ] **Step 5: The other full-literal sites** — add `broadCategories: []` to `CATALOG_ROW` and `STUB` in `app/(app)/products/[asin]/page.test.tsx`, to `catalogFacts` and `stubFacts` in `lib/research/products.test.ts`, and to the `ProductFacts` literal in `lib/research/service.test.ts` (near its `tier: 0`). `pnpm typecheck` names any other.

- [ ] **Step 6: Spec amendment** — in the spec's §8, after "`FactsCard.tsx` renders a "Broad categories" line …", append: "The line sits in the full fact list, under Category; the "Not fetched yet" and "Not in the catalog" shapes are unchanged (the keywords section below them still lists the rows)."

- [ ] **Step 7: Run to verify pass** — `pnpm vitest run lib/products "app/(app)/products" lib/research`; `pnpm typecheck`; `pnpm exec eslint lib/products/loadProduct.ts lib/products/loadProduct.test.ts "app/(app)/products/[asin]/FactsCard.tsx" "app/(app)/products/[asin]/FactsCard.test.tsx" "app/(app)/products/[asin]/page.test.tsx" lib/research/products.test.ts lib/research/service.test.ts`.

- [ ] **Step 8: Commit**

```bash
git add lib/products/loadProduct.ts lib/products/loadProduct.test.ts "app/(app)/products/[asin]/FactsCard.tsx" "app/(app)/products/[asin]/FactsCard.test.tsx" "app/(app)/products/[asin]/page.test.tsx" lib/research/products.test.ts lib/research/service.test.ts docs/superpowers/specs/2026-10-12-products-broad-category-design.md
git commit -m "feat(products): ProductFacts.broadCategories (most keywords first) and the ASIN page's Broad categories fact"
```

---

### Task 8: The tools — field, validation, details, guide

**Files:**
- Modify: `lib/research/contracts.ts`
- Modify: `lib/research/products.ts`
- Modify: `lib/research/products.test.ts`
- Modify: `lib/research/service.test.ts`
- Modify: `lib/research/tools.ts`, `lib/research/tools.test.ts`
- Modify: `lib/research/catalog.ts`, `lib/research/catalog.test.ts`
- Modify: `docs/superpowers/specs/2026-10-12-products-broad-category-design.md` (§9, one clause)

- [ ] **Step 1: Failing tests** —

`lib/research/products.test.ts`:
(a) `scopeMock` gains `broad: vi.fn(async () => ['Home'])`; the `listCategories` mock gains `listProductBroadCategories: scopeMock.broad`. `const BROAD_CODES = ['Apparel', 'Home', 'Pet Supplies'];` beside `DEPARTMENTS`; `makeDeps` gains `broadCategories: vi.fn(async () => BROAD_CODES),` after `categoryPaths`.
(b) In `describe('searchProductsForTool: department and categories …')`, after the department tests:

```ts
  it('a broad category is checked against the pair table\'s code list and becomes broadCategory; the scope is untouched (spec 2026-10-12 broad category §9)', async () => {
    const deps = makeDeps();
    await searchProductsForTool(deps, admin, { filters: { broadCategory: 'Home', department: 'Pet Supplies' } });
    expect(deps.search).toHaveBeenCalledWith({ ...PRODUCT_DEFAULTS, dept: 'Pet Supplies', broadCategory: 'Home' }, { dept: 'Pet Supplies', subtreePaths: [], exactPaths: [], scoped: false });
    expect(deps.broadCategories).toHaveBeenCalledTimes(1);
  });
  it('an unknown broad category fails with the valid codes in the message and the field in details; the list is not read for a search without one', async () => {
    const err = await notAvailable(makeDeps(), { filters: { broadCategory: 'Pets' } });
    expect(err.message).toBe('"Pets" is not a broad category of this week\'s clicked products. Pass one of: Apparel; Home; Pet Supplies.');
    expect(err.details).toEqual([{ path: 'filters.broadCategory', message: 'unknown broad category' }]);
    const deps = makeDeps();
    await searchProductsForTool(deps, admin, {});
    expect(deps.broadCategories).not.toHaveBeenCalled();
  });
  it('with no codes on the pair table yet, says so instead of listing none', async () => {
    const err = await notAvailable(makeDeps({ broadCategories: vi.fn(async () => []) }), { filters: { broadCategory: 'Home' } });
    expect(err.message).toBe('No broad categories are available yet (the weekly keyword-to-product table is empty).');
    expect(err.details).toEqual([{ path: 'filters.broadCategory', message: 'unknown broad category' }]);
  });
  it('a blank broad category is INVALID_FILTERS, before reserving', async () => {
    const deps = makeDeps();
    const err = await searchProductsForTool(deps, admin, { filters: { broadCategory: '  ' } }).catch((e: unknown) => e);
    expect((err as ResearchError).code).toBe('INVALID_FILTERS');
    expect(deps.reserve).not.toHaveBeenCalled();
  });
```

(c) The failed-read table in `'lets a failed department, path or custom-row read through unchanged …'` gains `[{ broadCategories: fail }, { filters: { broadCategory: 'Home' } }]` and its name says "department, broad-category, path or custom-row". The `defaultProductsDeps` wiring test (find it by `scopeMock.departments`) also asserts `await expect(defaultProductsDeps().broadCategories()).resolves.toEqual(['Home'])`.
(d) In `describe('productDetailsForTool')`, the first test's `product` expectation already spreads `catalogFacts`; add to it `expect(res.product.broadCategories).toEqual([])` and a new test:

```ts
  it('returns the facts\' broadCategories as the loader gives them (most keywords first)', async () => {
    const deps = makeDeps({ facts: vi.fn(async () => ({ ...catalogFacts, broadCategories: ['Home', 'Pet Supplies'] })) });
    const res = await productDetailsForTool(deps, admin, { asin: ASIN });
    expect(res.product.broadCategories).toEqual(['Home', 'Pet Supplies']);
  });
```

`lib/research/service.test.ts`: the `products` loaders stub gains `broadCategories: vi.fn(async () => []),`; the provenance pin `guideVersion: 4` → `5`.

`lib/research/catalog.test.ts`: `expect(GUIDE_VERSION).toBe(4)` and `expect(off.guideVersion).toBe(4)` → `5`; in the products section (near the `storefront department` assertions) add:

```ts
    expect(rules).toContain("filters.broadCategory is a Brand Analytics code as search_keywords' broadCategory and a keyword row's broadCategory carry it");
    expect(rules).toContain('get_product_details returns the product\'s codes as broadCategories');
    expect(unitsOf('broadCategory')).toContain('Brand Analytics code');
    expect(unitsOf('broadCategory')).toContain('CATEGORY_NOT_AVAILABLE');
```

`lib/research/tools.test.ts`, in `'search_products describes the department and categories filters'`: `expect(text).toContain("broad category (the Brand Analytics code a keyword row's broadCategory carries; any of a product's codes)");`.

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run lib/research`.

- [ ] **Step 3: contracts.ts** — in `productSearchFiltersSchema`, after `department`:

```ts
    broadCategory: z.string().trim().min(1).max(255).optional().describe(
      "One Brand Analytics code, spelled exactly as a keyword row's broadCategory carries it ('Home', 'Apparel', 'Biss', 'Pet Supplies'): the product is a top-3 clicked product this week under at least one keyword filed with that code (a product can carry several; any one matches). Independent of filters.department (the product's own Keepa storefront department); both may be set. An unknown code fails with CATEGORY_NOT_AVAILABLE and the valid codes.",
    ),
```

In `toProductFilters`, replace the Task 3 interim line with `broadCategory: f.broadCategory ?? PRODUCT_DEFAULTS.broadCategory,`. The section comment above the schema: "The three category fields (spec 2026-10-12 §6; broad category spec §9): `department` becomes the page's dept, `broadCategory` the page's broadCategory (checked against the pair table's code list), `categories` …".

- [ ] **Step 4: products.ts** — import `listProductBroadCategories`; `ProductLoaders` gains after `categoryPaths`:

```ts
  /** The Brand Analytics codes on the pair table (lib/products/listCategories, cached an hour): a search's broadCategory must be one of them. */
  broadCategories: () => Promise<string[]>;
```

`defaultProductsDeps`: `broadCategories: () => listProductBroadCategories(),`. `ScopeDeps` picks `'broadCategories'` too. In `resolveProductCategoryScope`, right after the department block:

```ts
  const broad = filters.broadCategory ?? null;
  if (broad !== null) {
    const codes = await deps.broadCategories();
    if (!codes.includes(broad)) {
      const message = codes.length === 0
        ? 'No broad categories are available yet (the weekly keyword-to-product table is empty).'
        : `"${broad}" is not a broad category of this week's clicked products. Pass one of: ${codes.join('; ')}.`;
      throw new ResearchError('CATEGORY_NOT_AVAILABLE', message, { details: [{ path: 'filters.broadCategory', message: 'unknown broad category' }] });
    }
  }
```

The function's doc comment: "the department and the broad category checked against the catalog's lists (the code travels on the page filters, not the scope)". The module header's order line is unchanged (the check runs where the department's does, after the reserve).

- [ ] **Step 5: tools.ts, catalog.ts** — `tools.ts` `search_products` description: after `department (the product's Keepa storefront department, not a keyword row's broadCategory)` insert `, broad category (the Brand Analytics code a keyword row's broadCategory carries; any of a product's codes)`. `catalog.ts`: `GUIDE_VERSION = 5`; in `PRODUCT_RULES`, after the department rule:

```ts
  "filters.broadCategory is a Brand Analytics code as search_keywords' broadCategory and a keyword row's broadCategory carry it ('Home', 'Apparel', 'Biss' …): the product was a top-3 clicked product this week under a keyword filed with that code, any of the product's codes. filters.department is the product's own Keepa storefront department — a different list; both may be set. An unknown code fails with CATEGORY_NOT_AVAILABLE and the message lists the valid codes. get_product_details returns the product's codes as broadCategories, most keywords first.",
```

Add to the `GUIDE_VERSION` comment history: "5 (2026-10-12): the products broad-category filter and field."

- [ ] **Step 6: Spec amendment** — §9, the `products.ts` bullet: replace "the validate step (before reserve) checks the code against the list" with "the code is checked against the list where the department is, inside `resolveProductCategoryScope` after the reserve (the keyword tools' order)".

- [ ] **Step 7: Run to verify pass** — `pnpm vitest run lib/research lib/ask lib/mcp`; `pnpm typecheck`; `pnpm exec eslint lib/research/contracts.ts lib/research/products.ts lib/research/products.test.ts lib/research/service.test.ts lib/research/tools.ts lib/research/tools.test.ts lib/research/catalog.ts lib/research/catalog.test.ts`.

- [ ] **Step 8: Commit**

```bash
git add lib/research/contracts.ts lib/research/products.ts lib/research/products.test.ts lib/research/service.test.ts lib/research/tools.ts lib/research/tools.test.ts lib/research/catalog.ts lib/research/catalog.test.ts docs/superpowers/specs/2026-10-12-products-broad-category-design.md
git commit -m "feat(research): search_products.filters.broadCategory (validated against the pair table's codes), broadCategories on get_product_details, GUIDE_VERSION 5"
```

---

### Task 9: Integration test extensions (owner-gated; written here, run in Task 10)

Never run these here: they need `RUN_INTEGRATION=1` and production. Only `pnpm typecheck` and eslint on the files.

**Files:**
- Modify: `tests/integration/topAsinsBuild.test.ts`
- Modify: `tests/integration/productsQueries.test.ts`

- [ ] **Step 1: topAsinsBuild.test.ts** —
  (a) `generatedNames` gains `broadIndex: \`${table}_broad_category_asin_idx\`` (doc: "its primary key, its (asin, search_term_id) index and its (broad_category, asin) index").
  (b) In the naming case: `expect(copy.indexes, …).toEqual([generated.asinIndex, generated.broadIndex, generated.pkey].sort());` and the live table's indexes `arrayContaining(['keyword_top_asins_pkey', 'keyword_top_asins_asin_idx', 'keyword_top_asins_broad_category_idx'])`.
  (c) In the swap-text case: `expect(swap).toContain('ALTER INDEX IF EXISTS keyword_top_asins_broad_category_idx RENAME TO keyword_top_asins_prev_broad_category_idx');` and `expect(swap).toContain(\`ALTER INDEX IF EXISTS ${next.broadIndex} RENAME TO keyword_top_asins_broad_category_idx\`);`.
  (d) In the scratch-build case, after the `stats` assertions and before the carry section, the carried code is checked against the partition for a sample:

```ts
        // The code travels from the same kwm row (spec 2026-10-12 broad category §4): per slot, equal to that slot's category.
        const codeCheck = await client.query<{ sampled: number; coded: number; mismatched: number }>(
          `WITH s AS (SELECT search_term_id, slot, broad_category FROM ${SCRATCH} LIMIT 20000)
           SELECT count(*)::int AS sampled, count(*) FILTER (WHERE s.broad_category IS NOT NULL)::int AS coded,
                  count(*) FILTER (WHERE s.broad_category IS DISTINCT FROM CASE s.slot WHEN 1 THEN m.top_clicked_category_1 WHEN 2 THEN m.top_clicked_category_2 ELSE m.top_clicked_category_3 END)::int AS mismatched
           FROM s JOIN ${partition} m ON m.search_term_id = s.search_term_id AND m.week_end_date = $1::date`,
          [currentWeek],
        );
        const codes = codeCheck.rows[0];
        console.log(`[topAsinsBuild] codes: ${codes.coded} of ${codes.sampled} sampled rows carry a broad_category, ${codes.mismatched} differ from the partition`);
        expect(codes.sampled, 'sampled rows').toBeGreaterThan(0);
        expect(codes.mismatched, 'rows whose broad_category differs from the kwm slot category').toBe(0);
        expect(codes.coded, 'coded rows in the sample (every slot-1 row has a code)').toBeGreaterThan(0);
```

  Header bullets: add "the carried broad_category equals the partition's slot category".

- [ ] **Step 2: productsQueries.test.ts** —
  (a) `const BROAD_INDEX = 'keyword_top_asins_broad_category_idx';` beside `CATEGORY_PATH_INDEX`; import `BROAD_CATEGORY_LIST_SQL` from `@/lib/products/listCategories` — this module imports `next/cache` and `@/lib/env`; if importing it in the integration run fails outside Next, copy the statement into the test as `BROAD_LIST_SQL` with a comment naming the source and assert equality with a `readFileSync` of `lib/products/listCategories.ts` containing it (prefer the import; fall back only if it breaks).
  (b) A helper that skips when the column is not filled:

```ts
  /** The column is filled by the one-off same-week rebuild (spec 2026-10-12 broad category §4); before it, the broad cases skip. */
  async function codesPresent(): Promise<boolean> {
    const r = await client.query('SELECT 1 FROM keyword_top_asins WHERE broad_category IS NOT NULL LIMIT 1');
    return (r.rowCount ?? 0) > 0;
  }
```

  (c) Four cases after the custom-category cases (each `TEST_TIMEOUT_MS`, each inside `inReadOnlyTransaction`, each starting with `if (!(await codesPresent())) { console.log('[productsQueries] broad_category not filled yet: skipped'); return ctx.skip('broad_category not filled'); }`):
  - "the largest broad category under the default sort plans on the broad index and every row carries the code": pick `SELECT broad_category FROM keyword_top_asins WHERE broad_category IS NOT NULL GROUP BY 1 ORDER BY count(*) DESC LIMIT 1`; `const filters = { ...PRODUCT_DEFAULTS, broadCategory: code }`; `explain(productSearchSql(filters, EMPTY_CATEGORY_SCOPE).rows)` → log the outline and seconds, `expect(lines.join('\n')).toContain(BROAD_INDEX)`; then `searchProducts(run, filters, EMPTY_CATEGORY_SCOPE)` timed → `rows.length` between 1 and `PRODUCT_PAGE_SIZE`; verify with `SELECT count(*)::int AS n FROM unnest($1::text[]) a(asin) WHERE NOT EXISTS (SELECT 1 FROM keyword_top_asins k WHERE k.asin = a.asin AND k.broad_category = $2)` = 0.
  - "a single-product broad category plans on the broad index": pick `… ORDER BY count(*) ASC LIMIT 1`; same plan assertion; run; `rows.length` ≤ 1 and the same verification; log the timing.
  - "the code list statement runs in well under a second and lists every distinct code": `client.query(BROAD_CATEGORY_LIST_SQL)` timed; compare with `SELECT count(DISTINCT broad_category)::int AS n FROM keyword_top_asins WHERE broad_category IS NOT NULL` (the slow way, once) → equal counts; log `n codes in Xs`; `expect(seconds).toBeLessThan(5)` (the cold bound; print the number).
  - "loadProduct lists a multi-code ASIN's codes, most keywords first": pick `SELECT asin FROM keyword_top_asins WHERE broad_category IS NOT NULL GROUP BY asin HAVING count(DISTINCT broad_category) > 1 LIMIT 1` (skip with a note if none); `loadProduct(run, asin)` → `broadCategories.length ≥ 2`; cross-check the first entry: `SELECT broad_category FROM keyword_top_asins WHERE asin = $1 AND broad_category IS NOT NULL GROUP BY 1 ORDER BY count(*) DESC, 1 LIMIT 1` equals `broadCategories[0]`.
  Header: add the four cases to the list and the precondition "the broad_category column filled (the one-off rebuild); until then the broad cases skip".

- [ ] **Step 3: Check without running** — `pnpm typecheck`; `pnpm exec eslint tests/integration/topAsinsBuild.test.ts tests/integration/productsQueries.test.ts`; `pnpm vitest run tests/integration` exits green with the files excluded (no `RUN_INTEGRATION`).

- [ ] **Step 4: Commit**

```bash
git add tests/integration/topAsinsBuild.test.ts tests/integration/productsQueries.test.ts
git commit -m "test(integration): broad_category carry, index names and renames, broad-filter plans, the code list and a multi-code ASIN (owner-gated)"
```

---

### Task 10: Ship (owner-gated, every step on the owner's go)

Before this task: the final whole-diff review (all tasks), `pnpm vitest run` (whole suite), `pnpm typecheck`, `pnpm build` green; the plan's "Landed shape" notes added if anything drifted from the spec.

1. **Active jobs + apply 0052:** `node --env-file=.env.local --import tsx scripts/checkActiveJobs.ts` (quiet), then `APPLY_0052=yes node --env-file=.env.local --import tsx scripts/applyMigration0052.ts`. Expect "4 statements", "alter: committed", one `ok (Ns): CREATE INDEX CONCURRENTLY…`, "index valid", "assertions passed", "Done." Seconds.
2. **One-off fill (local new code, production):** read the meta week (`SELECT week_end_date FROM keyword_top_asins_meta`; the build script prints it too), then `TOP_ASINS_WEEK=<meta week> node --env-file=.env.local --import tsx scripts/buildTopAsinsWeek.ts`. Expect `built week …: rows=8.3M previous=<meta week> carried=prev`, 1–2 min; readers may queue ≤ 120 s at the swap. Quiet hour, no import running.
3. **Integration:** `RUN_INTEGRATION=1 pnpm vitest run tests/integration/topAsinsBuild.test.ts tests/integration/productsQueries.test.ts --disableConsoleIntercept`. Expect the build test's "codes: … 0 differ", the three generated names, the two broad plans naming `keyword_top_asins_broad_category_idx` with their cold timings, the code list count (≈120) and time, the multi-code ASIN.
4. **Push:** `checkActiveJobs` again, then a bare `git push origin main` as its own call. Watch: `gh api repos/raw5045/AmazonAnalytics/commits/<sha>/status --jq '"overall: \(.state)", (.statuses[] | "\(.context): \(.state) @ \(.updated_at)")'` (contexts `Vercel`, `amazon-analytics-worker - AmazonAnalytics`, `amazon-analytics-worker - keepa-importer`); if Vercel creates no deployment, an empty commit on the owner's go.
5. **Re-fill if needed:** no upload between steps 1 and 4 (the owner controls uploads; the window is under an hour). If an import did land in between (meta week newer than the one filled) and `SELECT count(*) FROM keyword_top_asins WHERE broad_category IS NOT NULL` is 0, run step 2 for the new meta week. Then check the names: `SELECT tablename, indexname FROM pg_indexes WHERE indexname LIKE '%broad_category%' ORDER BY 1` must show `keyword_top_asins | keyword_top_asins_broad_category_idx` (and `keyword_top_asins_prev | keyword_top_asins_prev_broad_category_idx` when `_prev` exists); if the live one still carries a generated name, run step 2 once more (the drift-tolerant swap converges in two builds) — never hand-run DDL.
6. **Smoke:** page — `Home`; `Home` + a department; a code + a leaf pick; an old link with `?broad=Nope` shows "Nope" selected and zero rows; an ASIN page shows its codes. Tools (owner, from Claude) — a `broadCategory` search; a typo returns the codes; `get_product_details` shows `broadCategories`; Ask AI one question with a broad category.
7. **Results + memory:** fill the table below; update `arc8-category-filters.md` (or a new memory file) with the landed state.

| Step | Date | Outcome | Notes |
|---|---|---|---|
| 0052 applied | | | |
| One-off fill | | | |
| Integration | | | |
| Push + deploys | | | |
| Re-fill (if needed) | | | |
| Page smoke | | | |
| Tools smoke | | | |
| First weekly build with codes | | | |

---

## Self-review (done while writing)

- **Spec coverage:** §3 → Task 1; §4 → Tasks 2, 10 (fill); §5 → Tasks 3, 4; §6 → Task 5; §7 → Task 6; §8 → Task 7; §9 → Task 8; §10 → the error paths in Tasks 4–8; §11 → every task's tests + Task 9; §12 → Task 10; §13 → nothing built.
- **Placeholders:** none; every code step shows the code; the two spec wording amendments are given verbatim.
- **Type consistency:** `broadCategory: string | null` on `ProductFilters` (Task 3) is what Tasks 4, 6, 8 read; `broadCategories: string[]` on `ProductFacts` (Task 7) is what Task 8's details rely on; `ProductLoaders.broadCategories: () => Promise<string[]>` (Task 8) matches `listProductBroadCategories` (Task 5); the index names `keyword_top_asins_broad_category_idx` / `keyword_top_asins_next_broad_category_asin_idx` / `keyword_top_asins_prev_broad_category_idx` are the same in Tasks 1, 2, 9.
