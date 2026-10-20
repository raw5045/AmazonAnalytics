# Products list polish — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Products list page loads fast on every visit and measures itself, and reads the way the owner asked: a precomputed category-facets table replaces the per-department catalog scans behind the leaf typeahead, the admin perf panel lands on the page, the results table takes the new column order (BSR / vs-30d split, Rating / Reviews split, an Amazon magnifier, FBA / Amazon as check / X), the category filters take the Explorer's order with the department narrowing the typeahead, and the Products tab remembers its last list URL.

**Architecture:** A small table `product_category_facets` (one row per distinct `asin_products.category_path` among the rows the page can show, with its department and product count) is rebuilt in one transaction by a new import phase right after `ba_crosswalk_build`, and by hand once after migration 0055; `lib/products/listCategories.ts` reads it through its department index instead of scanning the 1.4 GB catalog, so a data-cache miss costs milliseconds. The page times its five parallel reads with a small `timed()` helper and renders the existing admin `PerfPanel`. The results table, the filter panel's category block and the tab navigation change in place; URL parameters and filter semantics do not change.

**Tech Stack:** Next 16 (App Router; read `node_modules/next/dist/docs/01-app/01-getting-started/05-server-and-client-components.md` before touching page code, and `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/unstable_cache.md` before Task 5), React 19, TypeScript, Postgres on Neon (`pg` for the worker and scripts, `@neondatabase/serverless` for the web readers), drizzle-orm (type mirrors only; the journal is frozen), Inngest (the import), vitest + Testing Library, lucide-react icons, Tailwind.

**Spec:** `docs/superpowers/specs/2026-10-19-products-list-polish-design.md` (1fe214d). Section numbers below are the spec's.

---

## Conventions (every task)

- Commit trailer, exactly: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Local commits on `main` only; never push (the push is Task 11, owner-gated). `git add` named files only, never `-A` or `.`.
- Edit with the Edit tool only, exact-match, never converting line endings (the tree mixes CRLF and LF). A new file is LF.
- Lint touched files only: `pnpm exec eslint <files>` (whole-project `pnpm lint` fails on untracked scripts). Type-check the whole tree: `pnpm typecheck`. Run tests per file: `pnpm vitest run <file>`. Vitest never type-checks: keep type-only pins where the plan puts them.
- Never log a DB error's `.message`: the worker uses `errFields` (`@/lib/ask/logSafe`); scripts print `e.name` and `e.code`. Never print member emails.
- No DDL from code or tests, ever. Migration 0055 is applied by the owner (Task 11 step 1) through the untracked gated script written there. The first facets build (Task 11 step 2) is the owner's too. `.env.local`'s `DATABASE_URL` is PRODUCTION: nothing in Tasks 1–10 connects to it.
- `main` hard-depends on migration 0055 from Task 5 on (the readers query `product_category_facets`): no push, and no hotfix push of `main`, before the owner applies it and runs the first build. A hotfix needed earlier goes on a branch cut from `origin/main`.
- One implementer at a time; read-only reviewers may run alongside.

## File structure

| File | Responsibility |
|---|---|
| `db/migrations/0055_product_category_facets.sql` (create) | the facets table + its (department, path) index + comment |
| `db/schema/productCategoryFacets.ts` (create) + `.test.ts`, `db/schema/index.ts` | drizzle mirror, pinned to the migration text |
| `lib/products/buildCategoryFacets.ts` (create) + `.test.ts` | the SELECT / INSERT / stats statements, `buildProductCategoryFacets` (one transaction), `computeProductCategoryFacets` (the dry run) |
| `inngest/functions/importFile.ts` + `.test.ts` | phase `category_facets_build` after `ba_crosswalk_build` |
| `app/admin/ImportStatusChip.tsx` + `.test.tsx` | the phase's label "Category list" |
| `scripts/buildProductCategoryFacets.ts` (create, tracked) | the one-off / re-run build by hand, with a dry run |
| `lib/products/listCategories.ts` + `.test.ts` | the department and path readers on the facets |
| `tests/integration/productsQueries.test.ts` (Task 5b, added during execution) | the option-lists case on the facets: counts vs the live scope, entry sizes, the per-department plan (index, no sort) |
| `lib/perf/handlerTimer.ts` + `.test.ts` (create) | `timed()` for parallel reads |
| `app/(app)/products/(list)/page.tsx` + `.test.tsx` | the timer, the `loads` step with its note, the `PerfPanel` |
| `app/(app)/products/ProductResultsTable.tsx` + `.test.tsx` | the thirteen columns |
| `app/(app)/products/ProductFilterPanel.tsx` + `.test.tsx` | the category block's order, labels, hints; the department-narrowed typeahead |
| `app/(app)/TabNav.tsx` + `.test.tsx` | `useRememberedListUrl` for the Explorer and Products tabs |
| `docs/superpowers/plans/2026-10-19-products-list-polish.md` | this plan; Task 11's Results table |

---

### Task 1: Migration 0055 and the drizzle mirror

**Files:**
- Create: `db/migrations/0055_product_category_facets.sql`
- Create: `db/schema/productCategoryFacets.ts`
- Create: `db/schema/productCategoryFacets.test.ts`
- Modify: `db/schema/index.ts` (append one export after `export * from './baCategoryCrosswalk';`)

- [ ] **Step 1: Write the failing schema test**

Create `db/schema/productCategoryFacets.test.ts`:

```ts
// db/schema/productCategoryFacets.test.ts
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { productCategoryFacets } from '@/db/schema';

describe('product_category_facets schema (migration 0055, spec 2026-10-19 §4)', () => {
  const MARKER = '--> statement-breakpoint';
  const raw = readFileSync('db/migrations/0055_product_category_facets.sql', 'utf8');
  // The apply script splits on the marker; comment-only lines are not SQL.
  const chunks = raw.split(MARKER);
  const statements = chunks.map((s) => s.replace(/^\s*--.*$/gm, '').trim()).filter((s) => s.length > 0);
  // Column definitions are the two-space-indented lowercase lines of a CREATE TABLE body.
  const declared = (body: string) => [...body.matchAll(/^ {2}([a-z][a-z0-9_]*) /gm)].map((m) => m[1]).sort();

  it('has 3 statements, one per chunk, split by 2 breakpoints', () => {
    expect(chunks).toHaveLength(3);
    expect(statements).toHaveLength(3);
    for (const s of statements) expect(s.match(/^(COMMENT|CREATE)\b/gm) ?? []).toHaveLength(1);
  });

  it('creates the table exactly as the mirror declares it, keyed by the path', () => {
    const create = statements[0];
    expect(create.startsWith('CREATE TABLE IF NOT EXISTS product_category_facets (')).toBe(true);
    expect(declared(create)).toEqual(Object.values(getTableColumns(productCategoryFacets)).map((c) => c.name).sort());
    // Whitespace collapsed: a fresh worktree checks this file out with CRLF (core.autocrlf, no .gitattributes).
    expect(create.replace(/\s+/g, ' ')).toBe(
      'CREATE TABLE IF NOT EXISTS product_category_facets ( category_path text PRIMARY KEY, department text NOT NULL, ' +
        'product_count integer NOT NULL, built_at timestamptz NOT NULL DEFAULT now() );',
    );
  });

  it('indexes (department, category_path): the per-department path reads and the department list', () => {
    expect(statements[1]).toBe('CREATE INDEX IF NOT EXISTS product_category_facets_department_idx ON product_category_facets (department, category_path);');
    const cfg = getTableConfig(productCategoryFacets);
    const idx = cfg.indexes.find((i) => i.config.name === 'product_category_facets_department_idx');
    expect(idx?.config.columns.map((c) => (c as { name: string }).name)).toEqual(['department', 'category_path']);
    expect(cfg.columns.find((c) => c.name === 'category_path')?.primary).toBe(true);
    const shape = Object.fromEntries(cfg.columns.map((c) => [c.name, [c.getSQLType(), c.notNull, c.hasDefault]]));
    expect(shape).toEqual({
      category_path: ['text', true, false],
      department: ['text', true, false],
      product_count: ['integer', true, false],
      built_at: ['timestamp with time zone', true, true],
    });
  });

  it('says what the table is, who rebuilds it and who reads it', () => {
    expect(statements[2].startsWith('COMMENT ON TABLE product_category_facets IS')).toBe(true);
    expect(statements[2]).toContain('Rebuilt in one transaction by every weekly import (lib/products/buildCategoryFacets.ts)');
    expect(statements[2]).toContain("the Products page''s and tools'' department and leaf-category lists read it");
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm vitest run db/schema/productCategoryFacets.test.ts`
Expected: FAIL — `ENOENT … 0055_product_category_facets.sql` (and the mirror is not exported).

- [ ] **Step 3: Write the migration, the mirror and the export**

Create `db/migrations/0055_product_category_facets.sql` (LF; the exact text matters, the test pins it):

```sql
-- db/migrations/0055_product_category_facets.sql
-- 0055 (hand-numbered, applied by the untracked scripts/applyMigration0055.ts on the owner's go;
-- never through drizzle-kit — the journal is frozen). Spec 2026-10-19 (products list polish) §4.
-- ADDITIVE: one small table (one row per distinct asin_products.category_path among the rows the
-- Products page can show, with its department and product count; ~23k rows) and its
-- (department, path) index. Empty until the first build (lib/products/buildCategoryFacets.ts: once by
-- hand through scripts/buildProductCategoryFacets.ts, then by every weekly import's
-- category_facets_build phase).
-- Must be applied BEFORE the code that reads it deploys: the list readers fail loudly (42P01) without
-- it, and show empty category lists while it is empty.

CREATE TABLE IF NOT EXISTS product_category_facets (
  category_path text PRIMARY KEY,
  department text NOT NULL,
  product_count integer NOT NULL,
  built_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS product_category_facets_department_idx ON product_category_facets (department, category_path);
--> statement-breakpoint
COMMENT ON TABLE product_category_facets IS
  'One row per distinct asin_products.category_path among the in-scope active/no_price rows, with its department (category_root) and product count. Rebuilt in one transaction by every weekly import (lib/products/buildCategoryFacets.ts) and by hand (scripts/buildProductCategoryFacets.ts); the Products page''s and tools'' department and leaf-category lists read it instead of scanning the catalog.';
```

Create `db/schema/productCategoryFacets.ts`:

```ts
// db/schema/productCategoryFacets.ts
import { pgTable, text, integer, timestamp, index } from 'drizzle-orm/pg-core';

/**
 * The Products page's category option lists, precomputed (migration 0055; spec 2026-10-19 §4): one row per
 * distinct asin_products.category_path among the rows the page can show (in_scope, active or no_price), with
 * its department (category_root) and product count. Rebuilt in one transaction by every weekly import
 * (lib/products/buildCategoryFacets.ts, phase category_facets_build) and by hand
 * (scripts/buildProductCategoryFacets.ts); read by lib/products/listCategories.ts one department at a time
 * through the index, instead of scanning the catalog. Type mirror only: the journal is frozen.
 */
export const productCategoryFacets = pgTable(
  'product_category_facets',
  {
    categoryPath: text('category_path').primaryKey(),
    department: text('department').notNull(),
    /** Catalog rows at exactly this path. Stored because it is free; nothing reads it yet (spec §14). */
    productCount: integer('product_count').notNull(),
    builtAt: timestamp('built_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    departmentIdx: index('product_category_facets_department_idx').on(t.department, t.categoryPath),
  }),
);

export type ProductCategoryFacetRow = typeof productCategoryFacets.$inferSelect;
```

In `db/schema/index.ts`, directly after the line `export * from './baCategoryCrosswalk';` add:

```ts
export * from './productCategoryFacets';
```

- [ ] **Step 4: Run the test to see it pass**

Run: `pnpm vitest run db/schema/productCategoryFacets.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Type-check, lint, commit**

Run: `pnpm typecheck && pnpm exec eslint db/schema/productCategoryFacets.ts db/schema/productCategoryFacets.test.ts db/schema/index.ts`
Expected: clean.

```bash
git add db/migrations/0055_product_category_facets.sql db/schema/productCategoryFacets.ts db/schema/productCategoryFacets.test.ts db/schema/index.ts
git commit -m "feat(products): migration 0055 — product_category_facets table + drizzle mirror

One row per distinct catalog path among the rows the Products page can show,
with its department and product count (spec 2026-10-19 §4). Hand-numbered,
applied by the owner through the untracked gated apply script; never through
drizzle-kit.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: The facets builder

**Files:**
- Create: `lib/products/buildCategoryFacets.ts`
- Create: `lib/products/buildCategoryFacets.test.ts`

Context: `Queryable` (`{ query(text, values?) → Promise<{ rowCount, rows }> }`) is exported by `lib/topAsins/buildWeek.ts`; `dbCols` / `notIn` by `lib/products/testHelpers.ts`. The write mirrors `writeCrosswalk` in `lib/baCategory/buildCrosswalk.ts` (read it first): one transaction, `SET LOCAL` limits (the only ones that bind through Neon's pooler), a self-exclusive table lock, DELETE not TRUNCATE, a best-effort VACUUM after the COMMIT. `category_root` equals the path's first segment for every row today (spec §2), and the INSERT groups by both so a path with two roots fails loudly (23505) instead of storing a wrong department.

- [ ] **Step 1: Write the failing tests**

Create `lib/products/buildCategoryFacets.test.ts`:

```ts
// lib/products/buildCategoryFacets.test.ts
import { describe, it, expect } from 'vitest';
import { asinProducts, productCategoryFacets } from '@/db/schema';
import { dbCols, notIn } from '@/lib/products/testHelpers';
import {
  FACETS_INSERT_SQL,
  FACETS_SCOPE_SQL,
  FACETS_SELECT_SQL,
  FacetsBuildError,
  buildProductCategoryFacets,
  computeProductCategoryFacets,
  facetStatsSql,
} from './buildCategoryFacets';

/** Answers by statement head (the first match wins, so an override goes before ANSWERS) and records every call in order. */
function fakeClient(answers: Array<[head: string, answer: { rows?: unknown[]; rowCount?: number; throws?: Error }]> = []) {
  const calls: Array<{ text: string; values?: unknown[] }> = [];
  const client = {
    async query(text: string, values?: unknown[]) {
      calls.push({ text, values });
      const found = answers.find(([head]) => text.startsWith(head));
      const a = found?.[1];
      if (a?.throws) throw a.throws;
      return { rowCount: a?.rowCount ?? a?.rows?.length ?? 0, rows: a?.rows ?? [] };
    },
  };
  return { client, calls, heads: () => calls.map((c) => c.text.trim().split(/\s+/).slice(0, 2).join(' ')) };
}
const STATS = { paths: 23429, departments: 36, products: 1176481 };
const ANSWERS: Array<[string, { rows?: unknown[]; rowCount?: number }]> = [
  ['INSERT INTO product_category_facets', { rowCount: 23429 }],
  ['SELECT count(*)::int AS paths', { rows: [STATS] }],
];
const pool = { totalCount: 0, async query(): Promise<never> { throw new Error('must not run'); } };

describe('the statements (spec 2026-10-19 §5)', () => {
  it('selects one row per distinct path of the rows the Products page can show, with its department and product count', () => {
    expect(FACETS_SCOPE_SQL).toBe("in_scope AND enrichment_status IN ('active', 'no_price') AND category_path IS NOT NULL AND category_root IS NOT NULL");
    expect(FACETS_SELECT_SQL.replace(/\s+/g, ' ')).toBe(
      `SELECT category_path, category_root AS department, count(*)::int AS product_count FROM asin_products WHERE ${FACETS_SCOPE_SQL} GROUP BY category_path, category_root`,
    );
    // Names only real catalog columns.
    const named = new Set([...FACETS_SELECT_SQL.matchAll(/\b(category_path|category_root|in_scope|enrichment_status)\b/g)].map((m) => m[1]));
    expect(named.size).toBe(4);
    expect(notIn(named, dbCols(asinProducts))).toEqual([]);
  });

  it("inserts exactly the mirror's columns but built_at (its default), from that SELECT", () => {
    expect(FACETS_INSERT_SQL.startsWith('INSERT INTO product_category_facets (category_path, department, product_count)\n')).toBe(true);
    expect(FACETS_INSERT_SQL.endsWith(FACETS_SELECT_SQL)).toBe(true);
    const cols = FACETS_INSERT_SQL.slice(FACETS_INSERT_SQL.indexOf('(') + 1, FACETS_INSERT_SQL.indexOf(')')).split(',').map((c) => c.trim());
    const mirror = dbCols(productCategoryFacets);
    expect(notIn(cols, mirror)).toEqual([]);
    expect(notIn(mirror, new Set([...cols, 'built_at']))).toEqual([]);
  });

  it('counts the paths, departments and products of the table, or of the SELECT for a dry run', () => {
    expect(facetStatsSql('table')).toBe(
      'SELECT count(*)::int AS paths, count(DISTINCT department)::int AS departments, coalesce(sum(product_count), 0)::int AS products FROM product_category_facets',
    );
    expect(facetStatsSql('select')).toBe(
      `SELECT count(*)::int AS paths, count(DISTINCT department)::int AS departments, coalesce(sum(product_count), 0)::int AS products FROM (${FACETS_SELECT_SQL}) f`,
    );
  });
});

describe('buildProductCategoryFacets', () => {
  it('replaces the rows in one transaction under the self-exclusive lock, reads the stats inside it, commits, then vacuums best-effort', async () => {
    const { client, calls, heads } = fakeClient(ANSWERS);
    await expect(buildProductCategoryFacets(client)).resolves.toEqual(STATS);
    expect(heads()).toEqual(['BEGIN', 'SET LOCAL', 'SET LOCAL', 'LOCK TABLE', 'DELETE FROM', 'INSERT INTO', 'SELECT count(*)::int', 'COMMIT', 'VACUUM (ANALYZE,']);
    expect(calls.slice(1, 5).map((c) => c.text)).toEqual([
      "SET LOCAL statement_timeout = '600s'",
      "SET LOCAL lock_timeout = '120s'",
      'LOCK TABLE product_category_facets IN SHARE ROW EXCLUSIVE MODE',
      'DELETE FROM product_category_facets',
    ]);
    expect(calls[5].text).toBe(FACETS_INSERT_SQL);
    expect(calls[6].text).toBe(facetStatsSql('table'));
    expect(calls[8].text).toBe('VACUUM (ANALYZE, TRUNCATE false) product_category_facets');
  });

  it('a failing INSERT (a path with two roots: 23505) rolls back, rethrows the error unchanged and skips the VACUUM', async () => {
    const failure = Object.assign(new Error('duplicate key'), { code: '23505' });
    const { client, heads } = fakeClient([['INSERT INTO product_category_facets', { throws: failure }], ...ANSWERS]);
    await expect(buildProductCategoryFacets(client)).rejects.toBe(failure);
    expect(heads()).toEqual(['BEGIN', 'SET LOCAL', 'SET LOCAL', 'LOCK TABLE', 'DELETE FROM', 'INSERT INTO', 'ROLLBACK']);
  });

  it('a lock wait past lock_timeout (55P03) rolls back before anything is deleted', async () => {
    const { client, heads } = fakeClient([['LOCK TABLE', { throws: Object.assign(new Error('lock timeout'), { code: '55P03' }) }], ...ANSWERS]);
    await expect(buildProductCategoryFacets(client)).rejects.toMatchObject({ code: '55P03' });
    expect(heads()).toEqual(['BEGIN', 'SET LOCAL', 'SET LOCAL', 'LOCK TABLE', 'ROLLBACK']);
  });

  it('a failing ROLLBACK does not mask the original error', async () => {
    const failure = new Error('insert failed');
    const { client } = fakeClient([
      ['INSERT INTO product_category_facets', { throws: failure }],
      ['ROLLBACK', { throws: new Error('rollback failed') }],
      ...ANSWERS,
    ]);
    await expect(buildProductCategoryFacets(client)).rejects.toBe(failure);
  });

  it('a failing VACUUM is swallowed: the build is committed and the stats are returned', async () => {
    const { client, heads } = fakeClient([['VACUUM', { throws: new Error('no vacuum for you') }], ...ANSWERS]);
    await expect(buildProductCategoryFacets(client)).resolves.toEqual(STATS);
    expect(heads().slice(-2)).toEqual(['COMMIT', 'VACUUM (ANALYZE,']);
  });

  it('an empty stats row (never expected) reads as zeros', async () => {
    const { client } = fakeClient([['SELECT count(*)::int AS paths', { rows: [] }], ...ANSWERS]);
    await expect(buildProductCategoryFacets(client)).resolves.toEqual({ paths: 0, departments: 0, products: 0 });
  });

  it('refuses a Pool before any query', async () => {
    await expect(buildProductCategoryFacets(pool)).rejects.toMatchObject({ name: 'FacetsBuildError', code: 'facets_bad_client' });
    expect(new FacetsBuildError('facets_bad_client', 'x')).toBeInstanceOf(Error);
  });
});

describe('computeProductCategoryFacets (the dry run)', () => {
  it('counts what a build would write in one bounded read-only transaction and never writes', async () => {
    const { client, calls, heads } = fakeClient(ANSWERS);
    await expect(computeProductCategoryFacets(client)).resolves.toEqual(STATS);
    expect(heads()).toEqual(['BEGIN ISOLATION', 'SET LOCAL', 'SELECT count(*)::int', 'COMMIT']);
    expect(calls[0].text).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(calls[1].text).toBe("SET LOCAL statement_timeout = '600s'");
    expect(calls[2].text).toBe(facetStatsSql('select'));
  });

  it('a failing read rolls back and rethrows', async () => {
    const failure = Object.assign(new Error('canceled'), { code: '57014' });
    const { client, heads } = fakeClient([['SELECT count(*)::int AS paths', { throws: failure }]]);
    await expect(computeProductCategoryFacets(client)).rejects.toBe(failure);
    expect(heads()).toEqual(['BEGIN ISOLATION', 'SET LOCAL', 'SELECT count(*)::int', 'ROLLBACK']);
  });

  it('refuses a Pool before any query', async () => {
    await expect(computeProductCategoryFacets(pool)).rejects.toMatchObject({ code: 'facets_bad_client' });
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run lib/products/buildCategoryFacets.test.ts`
Expected: FAIL — cannot resolve `./buildCategoryFacets`.

- [ ] **Step 3: Write the builder**

Create `lib/products/buildCategoryFacets.ts`:

```ts
// lib/products/buildCategoryFacets.ts
/**
 * Rebuild product_category_facets (spec 2026-10-19 §5): one row per distinct catalog path among the rows the
 * Products page can show, with its department and product count, replaced in ONE transaction so readers keep
 * the previous rows until COMMIT and never see a half-written list. Callers: the import phase
 * category_facets_build (inngest/functions/importFile.ts) and scripts/buildProductCategoryFacets.ts.
 *
 * The write: BEGIN → SET LOCAL limits → LOCK TABLE in SHARE ROW EXCLUSIVE MODE (builders queue on it; readers'
 * ACCESS SHARE never waits) → DELETE (not TRUNCATE: its ACCESS EXCLUSIVE lock would queue every reader, and it
 * is not MVCC-safe) → INSERT … SELECT … GROUP BY → the stats → COMMIT, then a best-effort
 * VACUUM (ANALYZE, TRUNCATE false). Grouping by (category_path, category_root) under a primary key on
 * category_path alone: a path that ever carried two roots fails the INSERT (23505) instead of storing a wrong
 * department; today none does (measured 2026-10-19: 0 of 1,176,481 rows).
 *
 * `client` must be ONE dedicated connection (never a Pool): each function is a transaction, and SET LOCAL is
 * the only limit that binds through Neon's pooler.
 */
import type { Queryable } from '@/lib/topAsins/buildWeek';

export type FacetsBuildErrorCode = 'facets_bad_client';
export class FacetsBuildError extends Error {
  constructor(public readonly code: FacetsBuildErrorCode, message: string) {
    super(message);
    this.name = 'FacetsBuildError';
  }
}

export interface FacetsBuildStats {
  /** Rows written: distinct paths. */
  paths: number;
  /** Distinct departments among them. */
  departments: number;
  /** Catalog rows behind them (the sum of product_count). */
  products: number;
}

/** The membership rule of the lists (the rows the Products page can show), as a WHERE body. */
export const FACETS_SCOPE_SQL = "in_scope AND enrichment_status IN ('active', 'no_price') AND category_path IS NOT NULL AND category_root IS NOT NULL";

/** The facets as a SELECT: the INSERT and the dry run both read exactly these three columns. */
export const FACETS_SELECT_SQL = `SELECT category_path, category_root AS department, count(*)::int AS product_count
FROM asin_products
WHERE ${FACETS_SCOPE_SQL}
GROUP BY category_path, category_root`;

export const FACETS_INSERT_SQL = `INSERT INTO product_category_facets (category_path, department, product_count)
${FACETS_SELECT_SQL}`;

/** The stats over `source`: the table after the INSERT, or the SELECT itself for a dry run. */
export function facetStatsSql(source: 'table' | 'select'): string {
  const from = source === 'table' ? 'product_category_facets' : `(${FACETS_SELECT_SQL}) f`;
  return `SELECT count(*)::int AS paths, count(DISTINCT department)::int AS departments, coalesce(sum(product_count), 0)::int AS products FROM ${from}`;
}

function assertDedicated(client: Queryable, fn: string): void {
  if ('totalCount' in client) throw new FacetsBuildError('facets_bad_client', `${fn} needs one dedicated connection, not a Pool`);
}

function readStats(rows: unknown[]): FacetsBuildStats {
  const r = rows[0] as Partial<FacetsBuildStats> | undefined;
  return { paths: r?.paths ?? 0, departments: r?.departments ?? 0, products: r?.products ?? 0 };
}

/** What a build would write, without writing: the stats of the SELECT in one bounded read-only transaction. */
export async function computeProductCategoryFacets(client: Queryable): Promise<FacetsBuildStats> {
  assertDedicated(client, 'computeProductCategoryFacets');
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client.query("SET LOCAL statement_timeout = '600s'");
    const stats = readStats((await client.query(facetStatsSql('select'))).rows);
    await client.query('COMMIT');
    return stats;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  }
}

/** Replace the rows in one transaction and return the stats of what was written; then a best-effort VACUUM. */
export async function buildProductCategoryFacets(client: Queryable): Promise<FacetsBuildStats> {
  assertDedicated(client, 'buildProductCategoryFacets');
  await client.query('BEGIN');
  let stats: FacetsBuildStats;
  try {
    await client.query("SET LOCAL statement_timeout = '600s'");
    // Builds queue on the self-exclusive lock below; a wait past 120 s (another build, a migration) is a 55P03: it rolls back.
    await client.query("SET LOCAL lock_timeout = '120s'");
    await client.query('LOCK TABLE product_category_facets IN SHARE ROW EXCLUSIVE MODE');
    await client.query('DELETE FROM product_category_facets');
    await client.query(FACETS_INSERT_SQL);
    stats = readStats((await client.query(facetStatsSql('table'))).rows);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  }
  // Best-effort, after the COMMIT, as the crosswalk build does: reclaims the replaced rows and refreshes the
  // planner statistics; autovacuum covers a miss. TRUNCATE false: no page-trim lock, so readers never wait.
  await client.query('VACUUM (ANALYZE, TRUNCATE false) product_category_facets').catch(() => undefined);
  return stats;
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm vitest run lib/products/buildCategoryFacets.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Type-check, lint, commit**

Run: `pnpm typecheck && pnpm exec eslint lib/products/buildCategoryFacets.ts lib/products/buildCategoryFacets.test.ts`
Expected: clean.

```bash
git add lib/products/buildCategoryFacets.ts lib/products/buildCategoryFacets.test.ts
git commit -m "feat(products): buildProductCategoryFacets — rebuild the facets in one transaction (+ dry run)

DELETE + INSERT … SELECT … GROUP BY under a self-exclusive table lock, the
stats read inside the transaction, a best-effort VACUUM after the COMMIT;
computeProductCategoryFacets counts the same SELECT read-only (spec
2026-10-19 §5).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
### Task 3: The import phase `category_facets_build` and its chip label

**Files:**
- Modify: `inngest/functions/importFile.ts` (one import; one phase block after the `ba_crosswalk_build` phase, inside the same `if (!isReplay) { … }`)
- Modify: `inngest/functions/importFile.test.ts`
- Modify: `app/admin/ImportStatusChip.tsx` (one `case`)
- Modify: `app/admin/ImportStatusChip.test.tsx` (one row)

Context: read the `ba_crosswalk_build` phase in `importFile.ts` (the block that starts with the comment "Brand Analytics crosswalk (spec 2026-10-14 §5.4)" and ends with `(r) => (r ? r.paths : null),` / `);`) — the new phase has exactly its shape. In the test file, pools are counted (`POOLS`) and the hook clients are handed out by `mockPoolConnect` in order: COPY, Keepa hook, top-ASINs, crosswalk; the facets client becomes the fifth. `spyConsole()` returns `{ log, err, warn }`.

- [ ] **Step 1: Write the failing tests**

In `inngest/functions/importFile.test.ts`:

1. In the `vi.hoisted` block, add `mockBuildFacets` next to `mockBuildCrosswalk` (both in the destructuring list and in the returned object: `mockBuildFacets: vi.fn(),`).
2. After the `vi.mock('@/lib/baCategory/buildCrosswalk', …)` block add:

```ts
vi.mock('@/lib/products/buildCategoryFacets', () => ({ buildProductCategoryFacets: mockBuildFacets }));
```

3. In `describe('processFileImport — keepa_enqueue hook', …)`:
   - after `const crosswalkClient = …` add `const facetsClient = { on: vi.fn(), release: vi.fn(), query: vi.fn() };`
   - change the comment above `copyClient` to end "…the fourth the crosswalk phase's, the fifth the facets phase's."
   - change `const POOLS = 4;` to `const POOLS = 5; // the COPY pool + one per hook phase`
   - in `beforeEach`, append `.mockResolvedValueOnce(facetsClient)` to the `mockPoolConnect` chain (after `.mockResolvedValueOnce(crosswalkClient)`), and after the `mockBuildCrosswalk.mockReset().mockResolvedValue({ … })` block add:

```ts
    // A successful facets build by default, so the phase after the crosswalk adds no stray failure line.
    mockBuildFacets.mockReset().mockResolvedValue({ paths: 23429, departments: 36, products: 1176481 });
```

   - in the test that pins the phase order, change `const order = ['keepa_enqueue', 'top_asins_build', 'ba_crosswalk_build', 'summary_refresh'];` to `const order = ['keepa_enqueue', 'top_asins_build', 'ba_crosswalk_build', 'category_facets_build', 'summary_refresh'];`
   - every comment that says "the three hook pools" now says "the four hook pools" (the assertions themselves use `POOLS`).
4. After the `describe('ba_crosswalk_build phase', …)` block (still inside the outer describe) add:

```ts
  // The phase after ba_crosswalk_build (spec 2026-10-19 §5): the same pool shape and fail-soft rule. It reads
  // the live catalog, so no week is passed; the week only names the import in the failure line.
  describe('category_facets_build phase', () => {
    beforeEach(() => {
      // The Keepa hook succeeds, so the only console.error lines are this phase's.
      mockEnqueueWeek.mockResolvedValue({ inserted: 0, updated: 0, retired: 0, vacuumed: false });
    });

    const facetsLines = (spy: { mock: { calls: unknown[][] } }) =>
      spy.mock.calls
        .map((args) => args.join(' '))
        .filter((line) => line.includes('[category-facets]'));
    const facetsTimings = () =>
      insertValues.mock.calls
        .map(([row]) => row as { phase?: string; rowsAffected?: number | null })
        .filter((row) => row.phase === 'category_facets_build');

    it('rebuilds the facets once, after the crosswalk and before the summary refresh, logs the stats and cleans up', async () => {
      const { log } = spyConsole();

      await processFileImport({ uploadedFileId: 'f1' });

      expect(mockBuildFacets).toHaveBeenCalledTimes(1);
      expect(mockBuildFacets).toHaveBeenCalledWith(facetsClient);
      expect(mockBuildCrosswalk.mock.invocationCallOrder[0]).toBeLessThan(mockBuildFacets.mock.invocationCallOrder[0]);
      expect(mockBuildFacets.mock.invocationCallOrder[0]).toBeLessThan(mockRefreshSummary.mock.invocationCallOrder[0]);
      expect(facetsClient.on).toHaveBeenCalledWith('error', expect.any(Function));
      expect(facetsClient.on.mock.invocationCallOrder[0]).toBeLessThan(mockBuildFacets.mock.invocationCallOrder[0]);
      expect(mockPoolOn).toHaveBeenNthCalledWith(5, 'error', expect.any(Function)); // this phase's
      expect(facetsClient.release).toHaveBeenCalledTimes(1);
      expect(mockPoolEnd).toHaveBeenCalledTimes(POOLS);
      expect(facetsLines(log)).toEqual(['[category-facets] paths=23429 departments=36 products=1176481']);
      expect(facetsTimings()).toEqual([expect.objectContaining({ rowsAffected: 23429 })]);
    });

    it('opens its own pool: one connection, 10-minute statement timeout, keepalive, 20 s connect timeout', async () => {
      await processFileImport({ uploadedFileId: 'f1' });

      // Pools are built in order: the COPY pool, the Keepa hook's, the top-ASINs phase's, the crosswalk's, this one.
      expect(mockPoolCtor).toHaveBeenCalledTimes(POOLS);
      expect(mockPoolCtor.mock.calls[4][0]).toMatchObject({
        connectionString: 'postgres://test:test@localhost:5432/test',
        max: 1,
        statement_timeout: 600_000,
        keepAlive: true,
        keepAliveInitialDelayMillis: 10_000,
        connectionTimeoutMillis: 20_000,
      });
    });

    it('replay runs (skipRefresh) never rebuild the facets', async () => {
      await processFileImport({ uploadedFileId: 'f1', skipRefresh: true });

      expect(mockBuildFacets).not.toHaveBeenCalled();
      expect(facetsTimings()).toEqual([]);
    });

    it('a failure logs only the week, stage, error name and code; the import completes, the refresh still runs, the timing row is null', async () => {
      const { log, err, warn } = spyConsole();
      mockBuildFacets.mockRejectedValue(Object.assign(new Error('SECRET duplicate key'), { name: 'error', code: '23505' }));

      await expect(processFileImport({ uploadedFileId: 'f1' })).resolves.toEqual({ rowsImported: expect.any(Number) });

      expect(facetsLines(err)).toEqual([
        '[category-facets] failed (import continues) {"week":"2026-04-11","stage":"build","error":"error","code":"23505"}',
      ]);
      expect([...log.mock.calls, ...err.mock.calls, ...warn.mock.calls].flat().join(' ')).not.toContain('SECRET');
      expect(facetsClient.release).toHaveBeenCalledTimes(1);
      expect(mockPoolEnd).toHaveBeenCalledTimes(POOLS);
      expect(mockRefreshSummary).toHaveBeenCalledTimes(1);
      expect(facetsTimings()).toEqual([expect.objectContaining({ rowsAffected: null })]);
    });

    it('a connect failure is logged at the connect stage', async () => {
      const { err } = spyConsole();
      mockPoolConnect
        .mockReset()
        .mockResolvedValueOnce(copyClient())
        .mockResolvedValueOnce(hookClient)
        .mockResolvedValueOnce(topAsinsClient)
        .mockResolvedValueOnce(crosswalkClient)
        .mockRejectedValueOnce(Object.assign(new Error('SECRET'), { code: 'ECONNRESET' }));

      await processFileImport({ uploadedFileId: 'f1' });

      expect(facetsLines(err)).toEqual([
        '[category-facets] failed (import continues) {"week":"2026-04-11","stage":"connect","error":"Error","code":"ECONNRESET"}',
      ]);
      expect(err.mock.calls.flat().join(' ')).not.toContain('SECRET');
      expect(mockBuildFacets).not.toHaveBeenCalled();
      expect(mockPoolEnd).toHaveBeenCalledTimes(POOLS);
      expect(mockRefreshSummary).toHaveBeenCalledTimes(1);
      expect(facetsTimings()).toEqual([expect.objectContaining({ rowsAffected: null })]);
    });
  });
```

In `app/admin/ImportStatusChip.test.tsx`, in the `it.each([...])` of phase labels, add the row `['category_facets_build', 'Category list'],` after `['ba_crosswalk_build', 'Broad categories'],`.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run inngest/functions/importFile.test.ts app/admin/ImportStatusChip.test.tsx`
Expected: FAIL — the order test misses `category_facets_build`; the new describe fails (no pool, no log line, `POOLS` mismatches); the chip shows `category_facets_build` raw.

- [ ] **Step 3: Add the phase and the label**

In `inngest/functions/importFile.ts`, next to `import { buildCrosswalk, BaCrosswalkError } from '@/lib/baCategory/buildCrosswalk';` add:

```ts
import { buildProductCategoryFacets } from '@/lib/products/buildCategoryFacets';
```

Directly after the `ba_crosswalk_build` phase's closing (the lines `// rows_affected = paths written; null marks a failed or skipped build.` / `(r) => (r ? r.paths : null),` / `);`) and BEFORE the `}` that closes `if (!isReplay) {`, insert:

```ts

      // ----------------------------------------------------------------
      // Products category facets (spec 2026-10-19 §5): rebuild the
      // Products page's category option lists from the live catalog, right
      // after the crosswalk and BEFORE the long summary refresh. Fail-soft,
      // like the phases above: a failure never fails the import — the
      // previous rows stay in place (the replace is one transaction) and
      // scripts/buildProductCategoryFacets.ts re-runs it by hand. Same
      // replay rule: a historical week must not rebuild the live lists.
      // ----------------------------------------------------------------
      await timePhase(
        file.id,
        'category_facets_build',
        async () => {
          const facetsPool = new Pool({
            connectionString: env.DATABASE_URL,
            max: 1,
            statement_timeout: 600_000,
            keepAlive: true,
            keepAliveInitialDelayMillis: 10_000,
            connectionTimeoutMillis: 20_000,
          });
          // Dropped-socket guards, as in the phases above.
          facetsPool.on('error', () => undefined);
          let stage: 'connect' | 'build' = 'connect';
          try {
            const client = await facetsPool.connect();
            stage = 'build';
            try {
              client.on('error', () => undefined);
              const r = await buildProductCategoryFacets(client);
              console.log(`[category-facets] paths=${r.paths} departments=${r.departments} products=${r.products}`);
              return r;
            } finally {
              client.release();
            }
          } catch (e) {
            const { error, code } = errFields(e);
            console.error(
              '[category-facets] failed (import continues)',
              JSON.stringify({ week: weekEndDate, stage, error, code }),
            );
            return null;
          } finally {
            await facetsPool.end();
          }
        },
        // rows_affected = facet rows written; null marks a failed build.
        (r) => (r ? r.paths : null),
      );
```

In `app/admin/ImportStatusChip.tsx`, in the phase-label `switch`, after `case 'ba_crosswalk_build': return 'Broad categories';` add:

```ts
    case 'category_facets_build':
      return 'Category list';
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm vitest run inngest/functions/importFile.test.ts app/admin/ImportStatusChip.test.tsx`
Expected: PASS (every existing case too: the counts follow `POOLS`).

- [ ] **Step 5: Type-check, lint, commit**

Run: `pnpm typecheck && pnpm exec eslint inngest/functions/importFile.ts inngest/functions/importFile.test.ts app/admin/ImportStatusChip.tsx app/admin/ImportStatusChip.test.tsx`
Expected: clean.

```bash
git add inngest/functions/importFile.ts inngest/functions/importFile.test.ts app/admin/ImportStatusChip.tsx app/admin/ImportStatusChip.test.tsx
git commit -m "feat(import): category_facets_build phase after the crosswalk — rebuild the Products category lists weekly

Its own one-connection pool, fail-soft (the previous rows stay; the import
continues), skipped on replays; the admin chip shows it as 'Category list'
(spec 2026-10-19 §5).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: The one-off / repair build script

**Files:**
- Create: `scripts/buildProductCategoryFacets.ts` (tracked)

Context: the pattern is `scripts/buildBaCrosswalk.ts` (read it). Scripts are not unit-tested; `pnpm typecheck` covers them. The script connects to whatever `DATABASE_URL` is passed; it is run only by the owner (Task 11 step 2).

- [ ] **Step 1: Write the script**

Create `scripts/buildProductCategoryFacets.ts`:

```ts
// scripts/buildProductCategoryFacets.ts
/**
 * Rebuild product_category_facets by hand (spec 2026-10-19 §5): the one-off first build after migration 0055, or
 * a re-run after the import's own category_facets_build phase logged a failure. Replaces the table's rows in one
 * transaction from the live catalog (lib/products/buildCategoryFacets.ts); re-running is idempotent.
 *
 * Run: node --env-file=.env.local --import tsx scripts/buildProductCategoryFacets.ts
 * PRODUCT_FACETS_DRY_RUN=1 counts what a build would write (read-only) and prints the stats without writing.
 * Careful: .env.local's DATABASE_URL points at PRODUCTION — the write replaces the live table's rows (readers keep
 * the previous rows until the commit). The GROUP BY scans the catalog: 1.5 s warm on 2026-10-19, longer cold.
 * Expect about 23.4k paths, 36 departments and 1.18M products; compare with the facets GROUP BY probe of 2026-10-19.
 */
import { Pool } from 'pg';
import { buildProductCategoryFacets, computeProductCategoryFacets } from '@/lib/products/buildCategoryFacets';

if (!process.env.DATABASE_URL) {
  console.error('Refusing to run: DATABASE_URL is not set (pass --env-file=.env.local).');
  process.exit(1);
}
// Only the exact value 1 is a dry run; anything else ("0", "true", empty) is refused, not ignored.
if (process.env.PRODUCT_FACETS_DRY_RUN !== undefined && process.env.PRODUCT_FACETS_DRY_RUN !== '1') {
  console.error('Refusing to run: PRODUCT_FACETS_DRY_RUN must be 1 (set PRODUCT_FACETS_DRY_RUN=1 or unset it).');
  process.exit(1);
}
const dryRun = process.env.PRODUCT_FACETS_DRY_RUN === '1';

(async () => {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    // As in the import phase. It may not bind through Neon's pooler: the library's transactions set their own limits.
    statement_timeout: 600_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    connectionTimeoutMillis: 20_000,
  });
  // Dropped-socket guard, as in scripts/buildBaCrosswalk.ts: an unhandled 'error' would crash the script.
  pool.on('error', () => undefined);
  const client = await pool.connect();
  try {
    client.on('error', () => undefined);
    console.log(`${dryRun ? 'counting' : 'building'} the product category facets from the live catalog`);
    const t0 = Date.now();
    const stats = dryRun ? await computeProductCategoryFacets(client) : await buildProductCategoryFacets(client);
    console.log(
      `${dryRun ? 'counted' : 'built'} in ${((Date.now() - t0) / 1000).toFixed(1)}s: paths=${stats.paths} departments=${stats.departments} products=${stats.products}`,
    );
  } finally {
    client.release();
    await pool.end();
  }
})().catch((e) => {
  console.error('failed:', e instanceof Error ? e.name : 'unknown', (e as { code?: string })?.code ?? '');
  process.exit(1);
});
```

- [ ] **Step 2: Type-check and lint**

Run: `pnpm typecheck && pnpm exec eslint scripts/buildProductCategoryFacets.ts`
Expected: clean. Do NOT run the script.

- [ ] **Step 3: Commit**

```bash
git add scripts/buildProductCategoryFacets.ts
git commit -m "feat(products): scripts/buildProductCategoryFacets.ts — the one-off / repair facets build by hand

Replaces the live table's rows in one transaction; PRODUCT_FACETS_DRY_RUN=1
counts without writing (spec 2026-10-19 §5).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: The list readers on the facets

**Files:**
- Modify: `lib/products/listCategories.ts` (the departments and paths readers; the broad-category reader is untouched)
- Modify: `lib/products/listCategories.test.ts`

Context: read `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/unstable_cache.md`. Next keys a data-cache entry on the callback's source text plus the key parts, so the new statements start fresh entries on deploy by themselves. Per-department caching stays (Next's data cache refuses entries over 2 MB; the whole list is about that size). Nothing here may scan `asin_products` any more. Callers (`app/(app)/products/(list)/page.tsx`, `lib/research/products.ts`) keep their imports.

- [ ] **Step 1: Rewrite the tests**

Replace the whole of `lib/products/listCategories.test.ts` with:

```ts
// lib/products/listCategories.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/env', () => ({ env: { DATABASE_URL: 'postgres://test' } }));
// unstable_cache records what is registered (key parts, options, the callback's source text) and what is called (key parts,
// arguments), then passes through: the caching itself is Next's; these tests check the settings, the statements and the assembly.
const cacheMock = vi.hoisted(() => ({
  registered: [] as Array<{ keyParts: string[]; options: unknown }>,
  /** Each registered callback's source text, in registration order: Next keys an entry on it plus the key parts. */
  sources: [] as string[],
  calls: [] as Array<{ keyParts: string[]; args: unknown[] }>,
}));
vi.mock('next/cache', () => ({
  unstable_cache: (fn: (...a: unknown[]) => unknown, keyParts: string[], options: unknown) => {
    cacheMock.registered.push({ keyParts, options });
    cacheMock.sources.push(String(fn));
    return (...args: unknown[]) => {
      cacheMock.calls.push({ keyParts, args });
      return fn(...args);
    };
  },
}));
const neonMock = vi.hoisted(() => ({
  queries: [] as Array<{ text: string; values: unknown[] }>,
  answer: (() => []) as (text: string, values: unknown[]) => unknown[],
}));
vi.mock('@neondatabase/serverless', () => ({
  // neon()'s tagged template: the statement with a ? per hole, and the hole values. query(text, values) only builds a lazy
  // statement, as neon's does; transaction([...]) runs a batch the way neonRunner uses it: each statement is recorded in
  // order and answered, one result set per statement (neonRunner returns the last).
  neon: () => {
    const tagged = async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?').replace(/\s+/g, ' ').trim();
      neonMock.queries.push({ text, values });
      return neonMock.answer(text, values);
    };
    return Object.assign(tagged, {
      query: (text: string, values: unknown[] = []) => ({ text: text.replace(/\s+/g, ' ').trim(), values }),
      transaction: async (statements: Array<{ text: string; values: unknown[] }>) =>
        statements.map(({ text, values }) => {
          neonMock.queries.push({ text, values });
          return neonMock.answer(text, values);
        }),
    });
  },
}));

import {
  assemblePathLists,
  BROAD_CATEGORY_LIST_SQL,
  compareCodeUnits,
  listProductBroadCategories,
  listProductCategoryPaths,
  listProductDepartments,
  PRODUCT_CATEGORIES_TAG,
} from './listCategories';
import { PRODUCT_READ_TIMEOUT_MS } from './searchProducts';

/** The two facets statements as the tagged-template mock records them (spec 2026-10-19 §6). */
const DEPARTMENTS_SQL = 'SELECT DISTINCT department FROM product_category_facets ORDER BY department';
const PATHS_SQL = 'SELECT category_path FROM product_category_facets WHERE department = ? ORDER BY category_path';

describe('assemblePathLists', () => {
  it('flattens, deduplicates and sorts by code unit (not locale)', () => {
    expect(assemblePathLists([['b › y', 'a'], ['B', 'a']])).toEqual(['B', 'a', 'b › y']);
    expect(['b', 'a', 'B'].sort(compareCodeUnits)).toEqual(['B', 'a', 'b']);
    expect(assemblePathLists([])).toEqual([]);
  });
});

describe('the loaders', () => {
  /** Two departments, answered out of code-unit order so the re-sort shows. */
  const DEPARTMENT_ROWS = [{ department: 'Pet Supplies' }, { department: 'Appliances' }];
  /** Four codes, answered out of code-unit order so the re-sort shows (by code unit the lowercase one comes last; by locale it would come first). */
  const BROAD_ROWS = [{ code: 'Toys' }, { code: 'Home' }, { code: 'Misc SDP' }, { code: 'apparel' }];
  const PATH_ROWS: Record<string, Array<{ category_path: string }>> = {
    Appliances: [{ category_path: 'Appliances › Dishwashers' }],
    'Pet Supplies': [{ category_path: 'Pet Supplies › Dogs › Toys' }, { category_path: 'Pet Supplies' }],
  };

  beforeEach(() => {
    neonMock.queries.length = 0;
    cacheMock.calls.length = 0; // registered is filled once, at import; only the calls belong to a single test
    neonMock.answer = (text, values) => {
      if (text === DEPARTMENTS_SQL) return DEPARTMENT_ROWS;
      if (text === PATHS_SQL) return PATH_ROWS[values[0] as string] ?? [];
      if (text.includes('SELECT DISTINCT code FROM ba_category_crosswalk')) return BROAD_ROWS;
      return [];
    };
  });

  it('lists the departments of the facets, in code-unit order; the catalog is never scanned', async () => {
    await expect(listProductDepartments()).resolves.toEqual(['Appliances', 'Pet Supplies']);
    expect(neonMock.queries).toEqual([{ text: DEPARTMENTS_SQL, values: [] }]);
  });

  it('reads the paths one department at a time through the department index, binding only the department, and assembles one sorted list', async () => {
    await expect(listProductCategoryPaths()).resolves.toEqual(['Appliances › Dishwashers', 'Pet Supplies', 'Pet Supplies › Dogs › Toys']);
    const pathQueries = neonMock.queries.filter((q) => q.text === PATHS_SQL);
    expect(pathQueries).toHaveLength(2);
    expect(pathQueries.map((q) => q.values)).toEqual([['Appliances'], ['Pet Supplies']]);
    expect(neonMock.queries.some((q) => q.text.includes('asin_products'))).toBe(false);
  });

  it('an empty facets table (before the first build) gives empty lists, never an error', async () => {
    neonMock.answer = () => [];
    await expect(listProductDepartments()).resolves.toEqual([]);
    await expect(listProductCategoryPaths()).resolves.toEqual([]);
  });

  it('a failed department read rejects the whole list: nothing is swallowed and no partial list is returned', async () => {
    const failure = new Error('connection reset');
    const answer = neonMock.answer;
    neonMock.answer = (text, values) => {
      if (text === PATHS_SQL && values[0] === 'Pet Supplies') throw failure;
      return answer(text, values);
    };
    await expect(listProductCategoryPaths()).rejects.toBe(failure);
  });

  it('lists the distinct codes of the crosswalk, in code-unit order (spec 2026-10-14 §7)', async () => {
    await expect(listProductBroadCategories()).resolves.toEqual(['Home', 'Misc SDP', 'Toys', 'apparel']);
    // One neonRunner batch: the page's statement timeout first (its 30 s value is pinned in searchProducts.test.ts), then the list statement.
    expect(neonMock.queries).toHaveLength(2);
    expect(neonMock.queries[0]).toEqual({ text: `SET LOCAL statement_timeout = ${PRODUCT_READ_TIMEOUT_MS}`, values: [] });
    expect(neonMock.queries[1]).toEqual({ text: BROAD_CATEGORY_LIST_SQL, values: [] });
    expect(BROAD_CATEGORY_LIST_SQL).toBe('SELECT DISTINCT code FROM ba_category_crosswalk ORDER BY code');
  });

  it('an empty crosswalk gives an empty code list; a failed read rejects (never an empty list cached for an hour)', async () => {
    neonMock.answer = () => [];
    await expect(listProductBroadCategories()).resolves.toEqual([]);
    neonMock.answer = () => { throw Object.assign(new Error('cold'), { code: '57014' }); };
    await expect(listProductBroadCategories()).rejects.toMatchObject({ code: '57014' });
  });

  it('registers the three caches under their own key parts, with the one-hour revalidation and the shared tag', () => {
    expect(PRODUCT_CATEGORIES_TAG).toBe('product-categories');
    const options = { revalidate: 3600, tags: [PRODUCT_CATEGORIES_TAG] };
    expect(cacheMock.registered).toEqual([
      { keyParts: ['product-departments'], options },
      { keyParts: ['product-category-paths'], options },
      // The broad-category callback names its statement instead of inlining it, so the statement's text is a key part.
      { keyParts: ['product-broad-categories', BROAD_CATEGORY_LIST_SQL], options },
    ]);
  });

  it("each cached callback holds its own statement (or names the constant whose text is a key part), so an edit to the SQL changes the cache key (Next keys an entry on the callback's source and the key parts)", () => {
    const [departments, paths, broad] = cacheMock.sources.map((s) => s.replace(/\s+/g, ' '));
    expect(cacheMock.sources).toHaveLength(3);
    expect(departments).toContain(DEPARTMENTS_SQL);
    // The path statement's head only: its hole is code, which the test transform may rewrite.
    expect(paths).toContain('SELECT category_path FROM product_category_facets WHERE department = ');
    // The broad-category callback runs the exported constant by name, through neonRunner; the statement text itself is its second key part (pinned above).
    expect(broad).toContain('run(BROAD_CATEGORY_LIST_SQL, [])');
  });

  it('calls the departments cache with no arguments, then the paths cache once per department with only that department (not the map index or array)', async () => {
    await listProductCategoryPaths();
    expect(cacheMock.calls).toEqual([
      { keyParts: ['product-departments'], args: [] },
      { keyParts: ['product-category-paths'], args: ['Appliances'] },
      { keyParts: ['product-category-paths'], args: ['Pet Supplies'] },
    ]);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run lib/products/listCategories.test.ts`
Expected: FAIL — the departments, paths, failure and sources cases (the statements still read `asin_products`).

- [ ] **Step 3: Rewrite the readers**

Replace the whole of `lib/products/listCategories.ts` with:

```ts
// lib/products/listCategories.ts
/**
 * The Products page's category option lists (spec 2026-10-12 (category filters) §4.4; spec 2026-10-19 §6),
 * read from product_category_facets — one row per distinct catalog path with its department, rebuilt in one
 * transaction by every weekly import (lib/products/buildCategoryFacets.ts) — and cached an hour with
 * unstable_cache like lib/explorer/listLeafCategories.ts. Nothing here scans the catalog: a cache miss is an
 * index read in milliseconds (the scans this replaced read hundreds of MB per department).
 *  - listProductDepartments: the distinct departments of the facets (36 today);
 *  - listProductCategoryPaths: every facet path (23,429 today), read one department at a time through
 *    product_category_facets_department_idx and cached per department (unstable_cache keys on the function's
 *    arguments). Per department because Next's data cache refuses entries over 2 MB (it warns and skips in
 *    production, throws in dev) and the full list is about 2 MB today; the per-department entries stay well
 *    under it (the largest, Books, is roughly 0.35 MB);
 *  - listProductBroadCategories: the distinct codes of ba_category_crosswalk (spec 2026-10-14 §7; ~24k rows,
 *    milliseconds whatever the plan), read through neonRunner so PRODUCT_READ_TIMEOUT_MS caps it like the
 *    page's reads.
 * All three lists are sorted by plain code-unit comparison so the order never depends on the host's ICU data
 * (lib/research/categories.ts sorts the same way). An empty facets table (before the first build) or crosswalk
 * gives empty lists: the page shows no category options and the tools reject category scopes, which is why the
 * first build precedes the deploy (spec 2026-10-19 §13). A path first seen mid-week joins the lists at the next
 * build; the search predicate runs on the live catalog, so any listed path matches correctly.
 * A failed read rejects the whole list (the tools validate category scopes against it, so a partial list would
 * turn a transient error into a false CATEGORY_NOT_AVAILABLE); never catch inside a cached function, or an
 * empty list is cached for an hour.
 * Each cached callback holds its own statement: Next keys a data-cache entry on the callback's source text plus
 * the key parts, so an edit to the SQL starts a new entry instead of serving the old statement's results
 * (Vercel's data cache outlives a deploy) until the hour is up. The broad-category cache keys on its statement
 * text explicitly: its callback names the exported BROAD_CATEGORY_LIST_SQL (the integration test runs the same
 * text), so the text is a key part.
 */
import { cache } from 'react';
import { unstable_cache } from 'next/cache';
import { neon } from '@neondatabase/serverless';
import { env } from '@/lib/env';
import { neonRunner } from './searchProducts';

const REVALIDATE_SECONDS = 60 * 60;
/** One tag for the three lists, so a future revalidateTag can refresh them together. */
export const PRODUCT_CATEGORIES_TAG = 'product-categories';

/** `a < b ? -1 : a > b ? 1 : 0`: a pure function of the strings, unlike localeCompare (host ICU data). */
export const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Pure: the per-department lists as one deduplicated list in code-unit order. */
export function assemblePathLists(lists: ReadonlyArray<ReadonlyArray<string>>): string[] {
  return [...new Set(lists.flat())].sort(compareCodeUnits);
}

/** The facets' departments, in code-unit order (the statement's ORDER BY is the database's collation; re-sorted here). */
async function fetchDepartmentsSorted(): Promise<string[]> {
  const sql = neon(env.DATABASE_URL);
  const rows = (await sql`SELECT DISTINCT department FROM product_category_facets ORDER BY department`) as Array<{ department: string }>;
  return rows.map((r) => r.department).sort(compareCodeUnits);
}

/**
 * fetchDepartmentsSorted, cached an hour (it is the callback itself, so the key covers its statement; see the header).
 * React's cache dedupes it per render: the page calls it twice at once (directly and via listProductCategoryPaths).
 */
export const listProductDepartments = cache(
  unstable_cache(fetchDepartmentsSorted, ['product-departments'], { revalidate: REVALIDATE_SECONDS, tags: [PRODUCT_CATEGORIES_TAG] }),
);

/** One department's facet paths (the department itself and everything under it), through the department index. */
async function fetchPathsForDepartment(dept: string): Promise<string[]> {
  const sql = neon(env.DATABASE_URL);
  const rows = (await sql`SELECT category_path FROM product_category_facets WHERE department = ${dept} ORDER BY category_path`) as Array<{ category_path: string }>;
  return rows.map((r) => r.category_path);
}

const cachedPathsForDepartment = unstable_cache(fetchPathsForDepartment, ['product-category-paths'], { revalidate: REVALIDATE_SECONDS, tags: [PRODUCT_CATEGORIES_TAG] });

/** Every facet path, assembled from the per-department caches. */
export async function listProductCategoryPaths(): Promise<string[]> {
  const departments = await listProductDepartments();
  const lists = await Promise.all(departments.map((dept) => cachedPathsForDepartment(dept)));
  return assemblePathLists(lists);
}

/**
 * The Brand Analytics codes the crosswalk maps paths to (spec 2026-10-14 §7): what the Products page's broad
 * filter can match. Empty until the first build. The text is also a key part of the cache below, so an edit
 * to it starts a new entry (the callback does not inline it).
 */
export const BROAD_CATEGORY_LIST_SQL = 'SELECT DISTINCT code FROM ba_category_crosswalk ORDER BY code';

/**
 * The codes in code-unit order (the statement's ORDER BY follows the database's collation; re-sorted here).
 * Run through neonRunner, so PRODUCT_READ_TIMEOUT_MS caps the read like every web read (the weekly rebuild
 * deletes and re-inserts under a lock that admits readers, so none waits on it).
 */
async function fetchBroadCategoriesSorted(): Promise<string[]> {
  const run = neonRunner(neon(env.DATABASE_URL));
  const rows = (await run(BROAD_CATEGORY_LIST_SQL, [])) as Array<{ code: string }>;
  return rows.map((r) => r.code).sort(compareCodeUnits);
}

/** fetchBroadCategoriesSorted, cached an hour under its statement text (see BROAD_CATEGORY_LIST_SQL) and deduped per render. */
export const listProductBroadCategories = cache(
  unstable_cache(fetchBroadCategoriesSorted, ['product-broad-categories', BROAD_CATEGORY_LIST_SQL], { revalidate: REVALIDATE_SECONDS, tags: [PRODUCT_CATEGORIES_TAG] }),
);
```

(The `PATH_SEP` import is gone with the prefix predicate.)

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm vitest run lib/products/listCategories.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Type-check, lint, the two callers' suites, commit**

Run: `pnpm typecheck && pnpm exec eslint lib/products/listCategories.ts lib/products/listCategories.test.ts && pnpm vitest run lib/research "app/(app)/products/(list)/page.test.tsx"`
Expected: clean; the callers' suites still green (they mock the readers).

```bash
git add lib/products/listCategories.ts lib/products/listCategories.test.ts
git commit -m "perf(products): read the department and leaf-category lists from product_category_facets

Index reads of the weekly-built facets replace the per-department DISTINCT
scans over the 1.4 GB catalog (the cold-load cause); per-department caching
stays under Next's 2 MB entry limit (spec 2026-10-19 §6).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
### Task 6: `timed()` and the perf panel on `/products`

**Files:**
- Modify: `lib/perf/handlerTimer.ts` (add `timed`)
- Create: `lib/perf/handlerTimer.test.ts`
- Modify: `app/(app)/products/(list)/page.tsx`
- Modify: `app/(app)/products/(list)/page.test.tsx`

Context: read `node_modules/next/dist/docs/01-app/01-getting-started/05-server-and-client-components.md`. `PerfPanel` (`app/(app)/PerfPanel.tsx`) is admin-gated and takes `{ totalMs, steps }`; `startHandlerTimer()` gives `mark(label, note?)`, `totalMs()`, `steps`. The watchlist page (`app/(app)/watchlist/page.tsx`) is the wiring to copy. The page's five reads run in parallel, so each is timed on its own with `timed()` and the step `loads` carries the wall time with the per-read times in its note. Props between server components are not serialized, so the timer object passes from the page to the results component.

- [ ] **Step 1: Write the failing timer tests**

Create `lib/perf/handlerTimer.test.ts`:

```ts
// lib/perf/handlerTimer.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { startHandlerTimer, timed } from './handlerTimer';

afterEach(() => vi.restoreAllMocks());

describe('startHandlerTimer', () => {
  it('records each mark as the time since the previous one, with its note, and the total since the start', () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValueOnce(1_000); // start
    const timer = startHandlerTimer();
    now.mockReturnValueOnce(1_060); // mark auth
    timer.mark('auth');
    now.mockReturnValueOnce(1_390); // mark loads
    timer.mark('loads', 'parallel');
    now.mockReturnValueOnce(1_400); // totalMs
    expect(timer.steps).toEqual([
      { label: 'auth', ms: 60, note: undefined },
      { label: 'loads', ms: 330, note: 'parallel' },
    ]);
    expect(timer.totalMs()).toBe(400);
  });
});

describe('timed', () => {
  it("resolves to the promise's value and the ms it took to settle", async () => {
    vi.spyOn(Date, 'now').mockReturnValueOnce(5_000).mockReturnValueOnce(5_250);
    await expect(timed(Promise.resolve(['a', 'b']))).resolves.toEqual({ value: ['a', 'b'], ms: 250 });
  });

  it('passes a rejection through unchanged (the caller decides what a failed read means)', async () => {
    const failure = new Error('cold');
    await expect(timed(Promise.reject(failure))).rejects.toBe(failure);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run lib/perf/handlerTimer.test.ts`
Expected: FAIL — `timed` is not exported.

- [ ] **Step 3: Add `timed`**

Append to `lib/perf/handlerTimer.ts`:

```ts

/**
 * One promise's settle time, for reads that run in parallel (mark() measures sequential steps): resolves to
 * the value and the ms it took; a rejection passes through, untimed.
 */
export async function timed<T>(p: Promise<T>): Promise<{ value: T; ms: number }> {
  const t0 = Date.now();
  const value = await p;
  return { value, ms: Date.now() - t0 };
}
```

- [ ] **Step 4: Run the timer tests to see them pass**

Run: `pnpm vitest run lib/perf/handlerTimer.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the failing page test**

In `app/(app)/products/(list)/page.test.tsx`, add inside `describe('ProductsPage (/products)', …)` after the test `'for an admin: searches on the parsed filters …'`:

```ts
  it('for an admin: the perf panel shows the handler total with the auth and loads steps; the loads note times the five reads, run in parallel, with the path count and size', async () => {
    render(<>{await resolveAsync(await callPage())}</>);
    // The summary line (PerfPanel): total, then one entry per step.
    expect(screen.getByText(/^perf · total=\d+ms · auth=\d+ms · loads=\d+ms$/)).toBeInTheDocument();
    // The loads row's note: one path of 40 bytes in the fixture rounds to 0.0 MB.
    expect(screen.getByText(/^\(parallel: search \d+ · departments \d+ · broad \d+ · paths \d+ \(1 · 0\.0 MB\) · custom \d+ ms\)$/)).toBeInTheDocument();
  });
```

(The page redirects every non-admin before rendering, so the panel's `admin` prop cannot be exercised as false here; it is wired from `user.role` for the day the page opens to all accounts, and `PerfPanel`'s gate has its own test, `app/(app)/PerfPanel.test.tsx`, added in the review pass.)

- [ ] **Step 6: Run it to see it fail**

Run: `pnpm vitest run "app/(app)/products/(list)/page.test.tsx"`
Expected: FAIL — no `perf · …` text.

- [ ] **Step 7: Wire the timer and the panel**

Replace the whole of `app/(app)/products/(list)/page.tsx` with:

```tsx
/**
 * /products — find ASINs by the Keepa catalog's fields (spec 2026-10-09 §5). Admin only (§10).
 *
 * Server component, built like /explorer:
 *   1. Admin gate, then parse searchParams → ProductFilters (bad values fall back per field)
 *   2. Stream the shell; behind <Suspense>, expand the custom ids, run the product search, and read
 *      the department, broad-category, path and custom-category lists
 *   3. Render the admin PerfPanel (spec 2026-10-19 §7), ProductFilterPanel, ProductResultsTable and
 *      ProductPagination
 * Soft filter / sort / page changes run inside transitions, so the old results stay mounted
 * (with the loading overlay) and the skeleton only shows on initial loads.
 *
 * The (list) route group (no URL segment) scopes this folder's loading.tsx to the list: a
 * loading.tsx directly in products/ would also wrap /products/[asin] and flash the list skeleton
 * before the ASIN page's own. The panel, table and pager live one level up, in products/.
 */
import { Suspense } from 'react';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { neon } from '@neondatabase/serverless';
import type { User } from '@/db/schema';
import { env } from '@/lib/env';
import { requireAdmin, AuthError } from '@/lib/auth/requireAdmin';
import { expandCustomCategories } from '@/lib/customCategories/expand';
import { listCustomCategoriesForUser } from '@/lib/customCategories/loadServer';
import { startHandlerTimer, timed, type HandlerTimer } from '@/lib/perf/handlerTimer';
import { pageCategoryScope } from '@/lib/products/categoryPredicate';
import { parseProductFilters, productFiltersToSearchParams, type ProductFilters, type SearchParamsLike } from '@/lib/products/filters';
import { listProductBroadCategories, listProductCategoryPaths, listProductDepartments } from '@/lib/products/listCategories';
import { searchProducts, neonRunner } from '@/lib/products/searchProducts';
import { PerfPanel } from '@/app/(app)/PerfPanel';
import { ProductFilterPanel } from '../ProductFilterPanel';
import { ProductResultsTable } from '../ProductResultsTable';
import { ProductPagination } from '../ProductPagination';
import { ProductsSkeleton } from './loading';

export const metadata: Metadata = { title: 'Products' };

export default async function ProductsPage({ searchParams }: { searchParams: Promise<SearchParamsLike> }) {
  // The timer starts before the gate: the panel's total is the whole handler, as on the Watchlist.
  const timer = startHandlerTimer();
  // Page-level gate, as app/admin/keepa-enrichment/page.tsx does it: checked here before any data
  // read (the (app) layout only requires a signed-in user, and Next renders layouts and pages in
  // parallel). The Products tab itself shows only for admins.
  let user: User;
  try {
    user = await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) redirect(e.code === 'UNAUTHENTICATED' ? '/sign-in' : '/explorer');
    throw e;
  }
  timer.mark('auth');
  const filters = parseProductFilters(await searchParams);
  return (
    <Suspense fallback={<ProductsSkeleton />}>
      <ProductsResults filters={filters} user={user} timer={timer} />
    </Suspense>
  );
}

/**
 * The page's reads, in parallel, each timed on its own, and the moment they finished. The custom-category
 * ids expand (owner-scoped; unknown ids skipped, so an unowned selection scopes to nothing) before the
 * search they scope; the four option lists load alongside. One `loads` step on the timer = the wall time
 * of all five, with the per-read times (and the path list's count and raw size, the payload every load
 * ships) in its note. The clock is read once, here on the server, and passed to the (client) table as a
 * prop: every row's listing age counts to the same instant, and hydration reuses that value instead of
 * reading the browser's clock.
 */
async function loadProductsPage(filters: ProductFilters, userId: string, timer: HandlerTimer) {
  const sql = neon(env.DATABASE_URL);
  const searched = expandCustomCategories(userId, filters.customCategoryIds, []).then((customPaths) =>
    searchProducts(neonRunner(sql), filters, pageCategoryScope(filters, customPaths)),
  );
  // A failed department, broad-category or path read shows an empty list; caught here, outside the cached functions, so nothing empty is cached and the tools still reject.
  const [result, departments, broadCategories, leafCategories, customCategories] = await Promise.all([
    timed(searched),
    timed(listProductDepartments().catch(() => [] as string[])),
    timed(listProductBroadCategories().catch(() => [] as string[])),
    timed(listProductCategoryPaths().catch(() => [] as string[])),
    timed(listCustomCategoriesForUser(userId)),
  ]);
  const pathBytes = leafCategories.value.reduce((n, p) => n + p.length, 0);
  timer.mark(
    'loads',
    `parallel: search ${result.ms} · departments ${departments.ms} · broad ${broadCategories.ms} · paths ${leafCategories.ms} ` +
      `(${leafCategories.value.length.toLocaleString('en-US')} · ${(pathBytes / 1024 / 1024).toFixed(1)} MB) · custom ${customCategories.ms} ms`,
  );
  return {
    result: result.value,
    departments: departments.value,
    broadCategories: broadCategories.value,
    leafCategories: leafCategories.value,
    customCategories: customCategories.value,
    now: new Date(),
  };
}

async function ProductsResults({ filters, user, timer }: { filters: ProductFilters; user: User; timer: HandlerTimer }) {
  const { result, departments, broadCategories, leafCategories, customCategories, now } = await loadProductsPage(filters, user.id, timer);
  // Keyed by the applied filters (page aside): a header re-sort or an Apply re-seeds the panel's
  // inputs, while paging keeps any edits not yet applied.
  const panelKey = productFiltersToSearchParams({ ...filters, page: 1 }).toString();
  return (
    <div className="flex">
      <ProductFilterPanel key={panelKey} filters={filters} departments={departments} broadCategories={broadCategories} leafCategories={leafCategories} customCategories={customCategories} />
      <div className="min-w-0 flex-1 p-6">
        <PerfPanel admin={user.role === 'admin'} data={{ totalMs: timer.totalMs(), steps: timer.steps }} />
        <ProductResultsTable rows={result.rows} total={result.total} totalIsCapped={result.totalIsCapped} filters={filters} now={now} />
        <ProductPagination page={filters.page} total={result.total} totalIsCapped={result.totalIsCapped} pageSize={result.pageSize} />
      </div>
    </div>
  );
}
```

- [ ] **Step 8: Run the page tests to see them pass**

Run: `pnpm vitest run "app/(app)/products/(list)/page.test.tsx"`
Expected: PASS (the existing cases and the new one).

- [ ] **Step 9: Type-check, lint, commit**

Run: `pnpm typecheck && pnpm exec eslint lib/perf/handlerTimer.ts lib/perf/handlerTimer.test.ts "app/(app)/products/(list)/page.tsx" "app/(app)/products/(list)/page.test.tsx"`
Expected: clean (the `react-hooks/purity` rule is satisfied: `Date.now()` stays in `lib/perf/handlerTimer.ts`).

```bash
git add lib/perf/handlerTimer.ts lib/perf/handlerTimer.test.ts "app/(app)/products/(list)/page.tsx" "app/(app)/products/(list)/page.test.tsx"
git commit -m "feat(products): admin perf panel on /products — auth + loads steps, the five reads timed in parallel

timed() in lib/perf/handlerTimer for parallel reads; the loads note carries
each read's ms and the path list's count and raw size (spec 2026-10-19 §7).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: The results table's thirteen columns

**Files:**
- Modify: `app/(app)/products/ProductResultsTable.tsx`
- Modify: `app/(app)/products/ProductResultsTable.test.tsx`

Context: spec §8 is the column table. The magnifier copies the Explorer's (`app/(app)/explorer/ResultsTable.tsx`: a plain `<a>` with lucide `Search`, `inline-flex align-middle text-gray-400 transition-colors hover:text-blue-600`). `formatRatio` gives `"−35%"` (a real minus sign), `"+30%"`, `"0%"` or the dash; `availabilityLabel` maps Keepa's code (−1 "No Amazon offer", 0 "In stock", 1 "Pre-order", 2 "Unknown", 3 "Back-order", 4 "Delayed"); `offers()` in this file gives `"FBA 3 / FBM 1"`. Nothing new is sortable. The ASIN under the title becomes plain text: the magnifier is the row's Amazon link.

- [ ] **Step 1: Rewrite the row tests**

In `app/(app)/products/ProductResultsTable.test.tsx`, replace the whole `describe('ProductResultsTable rows', …)` block with:

```tsx
describe('ProductResultsTable rows (spec 2026-10-19 §8)', () => {
  it('formats one full row in the thirteen columns', () => {
    renderTable({ filters: { ...PRODUCT_DEFAULTS, age: 180 } });
    const cells = bodyCells();
    expect(cells).toHaveLength(13);
    const headers = screen.getAllByRole('columnheader');
    expect(headers).toHaveLength(13);
    expect(headers[0]).toHaveTextContent(/^Open on Amazon$/); // visually hidden
    expect(headers[1]).toHaveTextContent(/^Product$/);
    expect(headers[2]).toHaveTextContent(/^Leaf category$/);
    expect(headers[3]).toHaveTextContent(/Monthly sold/);
    expect(headers[4]).toHaveTextContent(/^Rating$/);
    expect(headers[5]).toHaveTextContent(/Reviews/);
    expect(headers[6]).toHaveTextContent(/Listed/);
    expect(headers[7]).toHaveTextContent(/BSR/);
    expect(headers[8]).toHaveTextContent(/vs 30d avg/);
    expect(headers[9]).toHaveTextContent(/Price/);
    expect(headers[10]).toHaveTextContent(/Keywords/);
    expect(headers[11]).toHaveTextContent(/^FBA$/);
    expect(headers[12]).toHaveTextContent(/^Amazon$/);
    expect(headers[8]).toHaveAttribute('title', 'BSR vs its 30-day average');
    expect(headers[11]).toHaveAttribute('title', 'New offers fulfilled by Amazon; hover a cell for the FBA / FBM counts');
    expect(headers[12]).toHaveAttribute('title', "Amazon's own offer on the listing");

    // 1: the magnifier opens the listing on Amazon in a new tab.
    const magnifier = within(cells[0]).getByRole('link', { name: 'Open B000000001 on Amazon' });
    expect(magnifier).toHaveAttribute('href', 'https://www.amazon.com/dp/B000000001');
    expect(magnifier).toHaveAttribute('target', '_blank');
    expect(magnifier).toHaveAttribute('rel', 'noopener noreferrer nofollow');
    expect(magnifier).toHaveAttribute('title', 'Open the listing on Amazon');

    // 2: the title links to the product page (its `from` = this exact list, percent-encoded); brand · ASIN as text.
    const title = within(cells[1]).getByRole('link', { name: 'LED Desk Lamp' });
    expect(title).toHaveAttribute('href', '/products/B000000001?from=%2Fproducts%3Fage%3D180');
    expect(title).toHaveAttribute('target', '_blank');
    expect(title).toHaveAttribute('data-prefetch', 'false');
    expect(title).not.toHaveAttribute('data-replace');
    expect(within(cells[1]).getByText('Acme')).toBeInTheDocument();
    expect(within(cells[1]).getByText('B000000001')).toBeInTheDocument();
    expect(within(cells[1]).queryByRole('link', { name: 'B000000001' })).not.toBeInTheDocument();

    expect(cells[2]).toHaveTextContent(/^Desk Lamps$/);
    expect(cells[2]).toHaveAttribute('title', 'Home & Kitchen › Lighting › Desk Lamps');
    expect(cells[3]).toHaveTextContent(/^1,000\+$/);
    expect(cells[4]).toHaveTextContent(/^★ 4\.4$/);
    expect(cells[5]).toHaveTextContent(/^120$/);
    expect(cells[6]).toHaveTextContent('Aug 1, 2026');
    expect(cells[6]).toHaveTextContent('69 days');
    expect(cells[7]).toHaveTextContent(/^1,234$/);
    expect(cells[8]).toHaveTextContent(/^−35%$/);
    expect(cells[9]).toHaveTextContent(/^\$19\.99$/);
    expect(cells[10]).toHaveTextContent(/^7$/);
    // 12–13: a check reads "Yes", an X reads "No"; the counts and the availability sit in the cells' titles.
    expect(cells[11]).toHaveTextContent(/^Yes$/);
    expect(cells[11]).toHaveAttribute('title', 'FBA 3 / FBM 1');
    expect(cells[12]).toHaveTextContent(/^No$/);
    expect(cells[12]).toHaveAttribute('title', 'No Amazon offer');
  });

  it('the from param is the bare list URL under the default filters, and carries the page', () => {
    const { unmount } = renderTable();
    expect(within(bodyCells()[1]).getByRole('link', { name: 'LED Desk Lamp' })).toHaveAttribute('href', '/products/B000000001?from=%2Fproducts');
    unmount();
    renderTable({ filters: { ...PRODUCT_DEFAULTS, page: 2 } });
    expect(within(bodyCells()[1]).getByRole('link', { name: 'LED Desk Lamp' })).toHaveAttribute('href', '/products/B000000001?from=%2Fproducts%3Fpage%3D2');
  });

  it("the from it sends is the ASIN page back control's products list: the exact filtered URL, never with a from of its own", () => {
    // A stray from= on the list URL is not a filter, so the parse drops it and it cannot nest.
    const filters = parseProductFilters({ age: '180', leaf: 'Home & Kitchen › Lighting', sort: 'listed', dir: 'asc', page: '2', from: '/explorer' });
    renderTable({ filters });
    const href = within(bodyCells()[1]).getByRole('link', { name: 'LED Desk Lamp' }).getAttribute('href') ?? '';
    const from = new URL(href, 'https://keywordquarry.test').searchParams.get('from') ?? '';
    expect(from).toBe('/products?age=180&leaf=Home+%26+Kitchen+%E2%80%BA+Lighting&sort=listed&dir=asc&page=2');
    expect(new URLSearchParams(from.slice(from.indexOf('?') + 1)).has('from')).toBe(false);
    expect(parseProductFilters(Object.fromEntries(new URLSearchParams(from.slice(from.indexOf('?') + 1))))).toEqual(filters);
    expect(resolveProductBack(from)).toEqual({ href: from, label: 'Back to products', cameFromPage: true });
  });

  it('a value that is not ASIN-shaped gets neither the product-page link (the route would 404 it) nor the magnifier', () => {
    renderTable({ rows: [makeRow({ asin: 'B00BAD#001', title: 'Odd Row' })] });
    const cells = bodyCells();
    expect(within(cells[0]).queryByRole('link')).not.toBeInTheDocument();
    expect(within(cells[1]).queryByRole('link', { name: 'Odd Row' })).not.toBeInTheDocument();
    expect(within(cells[1]).getByText('Odd Row')).toBeInTheDocument();
    expect(within(cells[1]).getByText('B00BAD#001')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /on Amazon/ })).not.toBeInTheDocument();
  });

  it('missing values render as dashes; an untitled product links by its ASIN; the magnifier still shows', () => {
    renderTable({
      rows: [makeRow({
        title: null, brand: null, categoryPath: null, listedSince: null, monthlySold: null, reviewCount: null, averageRatingX10: null, currentPriceCents: null,
        salesRank: null, rankRatioX100: null, fbaOfferCount: null, fbmOfferCount: null, amazonAvailability: null, enrichmentStatus: 'no_price', keywordCount: 0,
      })],
    });
    const cells = bodyCells();
    expect(within(cells[0]).getByRole('link', { name: 'Open B000000001 on Amazon' })).toHaveAttribute('href', 'https://www.amazon.com/dp/B000000001');
    expect(within(cells[1]).getByRole('link', { name: 'B000000001' })).toHaveAttribute('href', '/products/B000000001?from=%2Fproducts');
    for (const i of [2, 3, 4, 5, 6, 7, 8, 9, 11, 12]) expect(cells[i], `column ${i}`).toHaveTextContent(/^—$/);
    expect(cells[2]).not.toHaveAttribute('title');
    expect(cells[11]).not.toHaveAttribute('title');
    expect(cells[12]).not.toHaveAttribute('title');
    expect(cells[10]).toHaveTextContent(/^0$/);
  });

  it('a category path whose last segment is blank shows the whole path', () => {
    renderTable({ rows: [makeRow({ categoryPath: 'Home & Kitchen › ' })] });
    expect(bodyCells()[2]).toHaveTextContent(/^Home & Kitchen ›$/);
    expect(bodyCells()[2]).toHaveAttribute('title', 'Home & Kitchen › ');
  });

  it('the BSR comparison has its own column: a "+" chip above the average, "0%" at it, a dash without one while the rank still shows', () => {
    renderTable({
      rows: [
        makeRow({ asin: 'B000000001', rankRatioX100: 130 }),
        makeRow({ asin: 'B000000002', rankRatioX100: 100 }),
        makeRow({ asin: 'B000000003', rankRatioX100: null }),
      ],
    });
    expect(bodyCells(0)[8]).toHaveTextContent(/^\+30%$/);
    expect(bodyCells(1)[8]).toHaveTextContent(/^0%$/);
    expect(bodyCells(2)[7]).toHaveTextContent(/^1,234$/);
    expect(bodyCells(2)[8]).toHaveTextContent(/^—$/);
  });

  it('the rating and the reviews are two columns: a dash without a rating, large counts compact', () => {
    renderTable({ rows: [makeRow({ reviewCount: 1834, averageRatingX10: null })] });
    expect(bodyCells()[4]).toHaveTextContent(/^—$/);
    expect(bodyCells()[5]).toHaveTextContent(/^1\.8k$/);
  });

  it.each<[number | null, string]>([
    [null, '—'],
    [0, 'No'],
    [3, 'Yes'],
  ])('FBA %s reads "%s"', (fba, text) => {
    renderTable({ rows: [makeRow({ fbaOfferCount: fba, fbmOfferCount: 1 })] });
    expect(bodyCells()[11]).toHaveTextContent(new RegExp(`^${text}$`));
  });

  it.each<[number | null, string, string | null]>([
    [null, '—', null],
    [-1, 'No', 'No Amazon offer'],
    [0, 'Yes', 'In stock'],
    [4, 'Yes', 'Delayed'],
  ])('Amazon availability %s reads "%s"', (code, text, title) => {
    renderTable({ rows: [makeRow({ amazonAvailability: code })] });
    const cell = bodyCells()[12];
    expect(cell).toHaveTextContent(new RegExp(`^${text}$`));
    if (title === null) expect(cell).not.toHaveAttribute('title');
    else expect(cell).toHaveAttribute('title', title);
  });
});
```

The three `describe`s below it (count line / hint / empty state; sortable headers) stay as they are: the header names, their links and titles are unchanged.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run "app/(app)/products/ProductResultsTable.test.tsx"`
Expected: FAIL — 10 cells, old order.

- [ ] **Step 3: Rewrite the header, the row and the cell components**

In `app/(app)/products/ProductResultsTable.tsx`:

1. Add the icon import after the `next/link` import:

```tsx
import { Check, Search, X } from 'lucide-react';
```

2. Replace the `<thead>…</thead>` block with:

```tsx
            <thead className="bg-[#F8FAFD] text-left text-slate-500">
              <tr>
                <th className="w-8 p-2">
                  <span className="sr-only">Open on Amazon</span>
                </th>
                <th className="p-2">Product</th>
                <th className="p-2" title="The product's Keepa leaf category; hover a cell for the full path">Leaf category</th>
                <SortHeader filters={filters} sort="sold" label="Monthly sold" align="right" title="Amazon's “bought in past month” badge" />
                <th className="whitespace-nowrap p-2 text-right" title="Average star rating">Rating</th>
                <SortHeader filters={filters} sort="reviews" label="Reviews" align="right" />
                <SortHeader filters={filters} sort="listed" label="Listed" />
                <SortHeader filters={filters} sort="bsr" label="BSR" align="right" title="Best Sellers Rank in the main category" />
                <SortHeader filters={filters} sort="ratio" label="vs 30d avg" align="right" title="BSR vs its 30-day average" />
                <SortHeader filters={filters} sort="price" label="Price" align="right" />
                <SortHeader
                  filters={filters}
                  sort="keywords"
                  label="Keywords"
                  align="right"
                  title="Keywords this product is a top-3 clicked product for this week"
                />
                <th className="p-2 text-center" title="New offers fulfilled by Amazon; hover a cell for the FBA / FBM counts">FBA</th>
                <th className="p-2 text-center" title="Amazon's own offer on the listing">Amazon</th>
              </tr>
            </thead>
```

3. Replace the whole `ProductRow` function with:

```tsx
function ProductRow({ row, from, now }: { row: ProductSummaryRow; from: string; now: Date }) {
  const name = row.title ?? row.asin;
  // Only an ASIN-shaped value gets links: the ASIN page's route 404s anything else, and /dp/ of a
  // malformed value opens nothing useful.
  const linkable = isAsin(row.asin);
  const offerText = offers(row.fbaOfferCount, row.fbmOfferCount);
  return (
    <tr className="align-top hover:bg-[#F2F7FF]">
      <td className="p-2 text-center">
        {/* The Explorer's magnifier: a plain anchor on purpose (middle-click / ctrl+click stack tabs,
            no popup-blocker involvement); the list stays put. */}
        {linkable && (
          <a
            href={`https://www.amazon.com/dp/${encodeURIComponent(row.asin)}`}
            target="_blank"
            rel="noopener noreferrer nofollow"
            title="Open the listing on Amazon"
            aria-label={`Open ${row.asin} on Amazon`}
            className="inline-flex align-middle text-gray-400 transition-colors hover:text-blue-600"
          >
            <Search className="h-4 w-4" aria-hidden />
          </a>
        )}
      </td>
      <td className="max-w-sm p-2">
        <div className="truncate">
          {/* New tab, like the explorer's keyword links: the filtered list stays put. */}
          {linkable ? (
            <Link
              href={`/products/${row.asin}?from=${from}`}
              target="_blank"
              rel="noopener"
              prefetch={false}
              title={`${name} (opens the product page in a new tab)`}
              className="font-medium text-blue-700 hover:underline focus-visible:underline"
            >
              {name}
            </Link>
          ) : (
            <span className="font-medium text-gray-800" title={name}>
              {name}
            </span>
          )}
        </div>
        <div className="text-xs text-gray-500">
          {row.brand && (
            <>
              <span>{row.brand}</span>
              <span aria-hidden="true"> · </span>
            </>
          )}
          {/* Text, not a link: the magnifier is the row's Amazon link. */}
          <span className="font-mono">{row.asin}</span>
        </div>
      </td>
      <td className="max-w-40 p-2 text-xs text-gray-700" title={row.categoryPath || undefined}>
        {row.categoryPath ? (
          <span className="block truncate leading-5">{splitCategoryPath(row.categoryPath).leaf.trim() || row.categoryPath}</span>
        ) : (
          orDash(DASH)
        )}
      </td>
      <td className="p-2 text-right tabular-nums">{orDash(formatBadge(row.monthlySold))}</td>
      <td className="whitespace-nowrap p-2 text-right tabular-nums">
        <RatingCell ratingX10={row.averageRatingX10} />
      </td>
      <td className="p-2 text-right tabular-nums">{orDash(formatReviewCount(row.reviewCount))}</td>
      <td className="whitespace-nowrap p-2">
        {row.listedSince ? (
          <>
            <div>{formatDate(row.listedSince)}</div>
            <div className="text-xs text-gray-500">{listingAge(row.listedSince, now)}</div>
          </>
        ) : (
          orDash(DASH)
        )}
      </td>
      <td className="p-2 text-right tabular-nums">{row.salesRank === null ? orDash(DASH) : row.salesRank.toLocaleString('en-US')}</td>
      <td className="whitespace-nowrap p-2 text-right tabular-nums">
        <RatioCell ratioX100={row.rankRatioX100} />
      </td>
      <td className="p-2 text-right tabular-nums">{orDash(formatPriceCents(row.currentPriceCents))}</td>
      <td className={`p-2 text-right tabular-nums ${row.keywordCount === 0 ? 'text-gray-400' : ''}`}>{row.keywordCount.toLocaleString('en-US')}</td>
      <td className="p-2 text-center" title={offerText === DASH ? undefined : offerText}>
        <YesNoCell value={row.fbaOfferCount === null ? null : row.fbaOfferCount > 0} />
      </td>
      <td className="p-2 text-center" title={row.amazonAvailability === null ? undefined : availabilityLabel(row.amazonAvailability)}>
        {/* Keepa's code: −1 = no Amazon offer; 0 and above = Amazon has one (in stock, pre-order, unknown, back-order, delayed). */}
        <YesNoCell value={row.amazonAvailability === null ? null : row.amazonAvailability >= 0} />
      </td>
    </tr>
  );
}
```

4. Replace the `ReviewsCell` and `BsrCell` functions (keep `offers`, `SortHeader`, `SortLink`, `SortPending`) with:

```tsx
/** "★ 4.4" in the keyword page's review style; a dash without a rating. */
function RatingCell({ ratingX10 }: { ratingX10: number | null }) {
  if (ratingX10 === null) return orDash(DASH);
  return <span className="text-yellow-600">★ {(ratingX10 / 10).toFixed(1)}</span>;
}

/** The rank against its 30-day average: a green (better) or red (worse) chip, "0%" at the average, a dash without a comparison. */
function RatioCell({ ratioX100 }: { ratioX100: number | null }) {
  const change = formatRatio(ratioX100);
  if (ratioX100 === null || change === DASH) return orDash(DASH);
  if (change === '0%') return <>{change}</>;
  return (
    <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${ratioX100 < 100 ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}>
      {change}
    </span>
  );
}

/** A green check (true), a red X (false) or a dash (unknown); reads as "Yes" / "No" in assistive tech and in tests. */
function YesNoCell({ value }: { value: boolean | null }) {
  if (value === null) return orDash(DASH);
  return value ? (
    <span className="inline-flex align-middle text-emerald-600">
      <Check className="h-4 w-4" aria-hidden />
      <span className="sr-only">Yes</span>
    </span>
  ) : (
    <span className="inline-flex align-middle text-rose-600">
      <X className="h-4 w-4" aria-hidden />
      <span className="sr-only">No</span>
    </span>
  );
}
```

5. Update the file's component doc comment ("Results for /products …") to say: thirteen columns in the spec 2026-10-19 §8 order — the magnifier first, BSR and its 30-day comparison as two columns, Rating and Reviews as two, FBA and Amazon as check / X last.

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm vitest run "app/(app)/products/ProductResultsTable.test.tsx"`
Expected: PASS (all four describes).

- [ ] **Step 5: Type-check, lint, the page suite, commit**

Run: `pnpm typecheck && pnpm exec eslint "app/(app)/products/ProductResultsTable.tsx" "app/(app)/products/ProductResultsTable.test.tsx" && pnpm vitest run "app/(app)/products/(list)/page.test.tsx"`
Expected: clean; the page suite still green (it finds the title link by name).

```bash
git add "app/(app)/products/ProductResultsTable.tsx" "app/(app)/products/ProductResultsTable.test.tsx"
git commit -m "feat(products): results table in the owner's column order — magnifier, Rating/Reviews and BSR/vs-30d split, FBA/Amazon as check/X

The ASIN under the title is text now (the magnifier is the row's Amazon
link); a missing comparison shows a dash in its own column (spec 2026-10-19 §8).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
### Task 8: The filter panel's category block

**Files:**
- Modify: `app/(app)/products/ProductFilterPanel.tsx`
- Modify: `app/(app)/products/ProductFilterPanel.test.tsx`
- Modify: `app/(app)/products/(list)/page.test.tsx` (six label lookups)

Context: spec §9. The block's position in the panel (after "BSR vs 30-day avg", before "FBA offer"), the URL parameters and the filter semantics do not change; only the order, the labels, the hints and the typeahead's option list do. `PATH_SEP` (`' › '`) is exported by `lib/categoryBuilder/buildTree.ts`. Testing Library's `getByLabelText('…')` matches the whole label text, so every lookup of the two renamed controls changes with them.

- [ ] **Step 1: Update and extend the tests**

In `app/(app)/products/ProductFilterPanel.test.tsx`:

1. With the Edit tool (`replace_all`), rename the lookups: `control('Department')` → `control('Department (Keepa)')`; `optionTexts('Department')` → `optionTexts('Department (Keepa)')`; `change('Department', ` → `change('Department (Keepa)', `; `control('Broad category')` → `control('Broad category (Brand Analytics)')`; `optionTexts('Broad category')` → `optionTexts('Broad category (Brand Analytics)')`; `change('Broad category', ` → `change('Broad category (Brand Analytics)', `.
2. In `'renders every control at PRODUCT_DEFAULTS'`, replace the line asserting the old broad hint (`"Brand Analytics category, as on the Explorer, mapped from the product's Keepa category. One per product."`) with:

```ts
    expect(screen.getByText("Amazon's Brand Analytics category, as on the Explorer; one per product, mapped from its Keepa category.")).toBeInTheDocument();
    expect(screen.getByText('Narrows the leaf search below; also filters on its own.')).toBeInTheDocument();
```

   and change `screen.getByRole('group', { name: 'Leaf categories' })` to `screen.getByRole('group', { name: 'Leaf categories (Keepa)' })`.
3. At the end of `describe('ProductFilterPanel categories (spec 2026-10-12 §5.1)', …)` add:

```tsx
  it("lays the category block out in the Explorer's order: broad category, then department, then leaf categories (spec 2026-10-19 §9)", () => {
    renderPanel();
    // Field headings are <label>s (one control) or <p id>s (a group), in document order.
    const headings = [...document.querySelectorAll('label, p[id]')].map((el) => el.textContent ?? '');
    const at = (text: string) => headings.indexOf(text);
    expect(at('Broad category (Brand Analytics)')).toBeGreaterThan(at('BSR vs 30-day avg'));
    expect(at('Department (Keepa)')).toBeGreaterThan(at('Broad category (Brand Analytics)'));
    expect(at('Leaf categories (Keepa)')).toBeGreaterThan(at('Department (Keepa)'));
    expect(at('FBA offer')).toBeGreaterThan(at('Leaf categories (Keepa)'));
  });

  it('the department narrows the leaf typeahead to its paths and widens it back; the hint counts the narrowed list', () => {
    renderPanel();
    const input = control('Add leaf category');
    const options = () => within(screen.getByRole('listbox')).getAllByRole('option').map((o) => o.textContent);
    change('Department (Keepa)', 'Home & Kitchen');
    expect(screen.getByText(/^2 categories in Home & Kitchen — type to search/)).toBeInTheDocument();
    fireEvent.focus(input);
    // Each option is its leaf name followed by its parent path.
    expect(options()).toEqual(['Desk LampsHome & Kitchen › Lighting', 'Floor LampsHome & Kitchen › Lighting']);
    change('Department (Keepa)', '');
    expect(screen.getByText(/^3 categories — type to search/)).toBeInTheDocument();
    fireEvent.focus(input);
    expect(options()).toHaveLength(3);
  });

  it('a department change leaves the picks alone: a pick outside the department stays as a chip and applies (it matches nothing, as the predicate always did)', () => {
    renderPanel();
    pickCategory('Jigsaw Puzzles');
    change('Department (Keepa)', 'Home & Kitchen');
    expect(screen.getByRole('button', { name: `Remove ${LEAVES[2]}` })).toBeInTheDocument();
    fireEvent.click(applyButton());
    expect(replace).toHaveBeenLastCalledWith(
      `/products?${productFiltersToSearchParams({ ...PRODUCT_DEFAULTS, dept: 'Home & Kitchen', leafPaths: [LEAVES[2]] })}`,
      { scroll: false },
    );
  });
```

In `app/(app)/products/(list)/page.test.tsx`, rename the six lookups: `screen.getByLabelText('Department')` → `screen.getByLabelText('Department (Keepa)')` (three places) and `screen.getByLabelText('Broad category')` → `screen.getByLabelText('Broad category (Brand Analytics)')` (three places).

One pre-existing panel case, 'leaf picks accumulate as chips and apply as repeated leaf params, with the department', picks a Toys & Games leaf after choosing Home & Kitchen; the narrowing no longer offers it (by design), so that case picks 'Floor Lamps' as its second pick and expects `leafPaths: [LEAVES[0], LEAVES[1]]` (found and fixed during execution).

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run "app/(app)/products/ProductFilterPanel.test.tsx" "app/(app)/products/(list)/page.test.tsx"`
Expected: FAIL — the renamed labels are not found; the three new cases fail.

- [ ] **Step 3: Reorder, relabel, narrow**

In `app/(app)/products/ProductFilterPanel.tsx`:

1. Change the React import to `import { useMemo, useState, useTransition, type FormEvent, type ReactNode } from 'react';` and add, after the `formatBadge` import:

```ts
import { PATH_SEP } from '@/lib/categoryBuilder/buildTree';
```

2. Directly after the line that defines `broadOptions` add:

```ts
  // The leaf typeahead's options, narrowed to the pending department (the department itself and everything
  // under it) when one is chosen. The picks already made are left alone: a pick outside the department
  // matches nothing, as the predicate always did.
  const leafOptions = useMemo(
    () => (pending.dept === '' ? leafCategories : leafCategories.filter((p) => p === pending.dept || p.startsWith(pending.dept + PATH_SEP))),
    [leafCategories, pending.dept],
  );
```

3. Replace the three `<Field …>` blocks `Department`, `Broad category` and `Leaf categories` (in that order today, between the "BSR vs 30-day avg" field and the "FBA offer" field) with this block, in this order:

```tsx
            <Field label="Broad category (Brand Analytics)" htmlFor="pf-broad">
              <select id="pf-broad" value={pending.broad} onChange={(e) => set('broad', e.target.value)} className={INPUT}>
                <option value="">All broad categories</option>
                {broadOptions.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <p className={HINT}>Amazon&apos;s Brand Analytics category, as on the Explorer; one per product, mapped from its Keepa category.</p>
            </Field>

            <Field label="Department (Keepa)" htmlFor="pf-dept">
              <select id="pf-dept" value={pending.dept} onChange={(e) => set('dept', e.target.value)} className={INPUT}>
                <option value="">All departments</option>
                {departmentOptions.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
              <p className={HINT}>Narrows the leaf search below; also filters on its own.</p>
            </Field>

            <Field label="Leaf categories (Keepa)" groupId="pf-leaf-categories">
              {/* Leaf | Custom segmented toggle, as the explorer sidebar's. */}
              <div className="mb-2 flex overflow-hidden rounded-full border border-slate-300 text-xs font-medium">
                <button type="button" aria-pressed={pending.leafMode === 'leaf'} onClick={() => set('leafMode', 'leaf')} className={modeClass(pending.leafMode === 'leaf')}>
                  Leaf
                </button>
                <button
                  type="button"
                  aria-pressed={pending.leafMode === 'custom'}
                  onClick={() => set('leafMode', 'custom')}
                  className={`border-l border-slate-300 ${modeClass(pending.leafMode === 'custom')}`}
                >
                  Custom
                </button>
              </div>
              {pending.leafMode === 'leaf' ? (
                <>
                  <LeafCategoryTypeahead options={leafOptions} selected={pending.leafPaths} onChange={(next) => set('leafPaths', next)} />
                  <p className={HINT}>
                    {leafOptions.length.toLocaleString('en-US')} categories{pending.dept === '' ? '' : ` in ${pending.dept}`} — type to search, click or Enter to
                    add. Each pick includes its sub-categories; several match with OR.
                  </p>
                </>
              ) : customCategories.length === 0 ? (
                <>
                  <p className={HINT}>No custom categories yet — build one in the Category Builder tab.</p>
                  {missingCustomNote}
                </>
              ) : (
                <>
                  <div className="space-y-1">
                    {customCategories.map((c) => (
                      <label key={c.id} className="flex items-center gap-2 text-sm">
                        <input type="checkbox" checked={pending.customCategoryIds.includes(c.id)} onChange={() => toggleCustom(c.id)} />
                        <span>
                          {c.name} <span className="text-gray-400">({c.leafPaths.length})</span>
                        </span>
                      </label>
                    ))}
                  </div>
                  {selectedCustom.length > 0 && (
                    <p className={HINT}>
                      {selectedCustom.length} selected → {uniqueLeaves} leaves
                    </p>
                  )}
                  {missingCustomNote}
                </>
              )}
            </Field>
```

(The Custom side is byte-for-byte what it was; only the order and the two labels and hints around it changed, and the typeahead takes `leafOptions`.)

4. In the component's doc comment, add one sentence: "The category block follows the Explorer's order (broad, department, leaf; spec 2026-10-19 §9), and the department narrows the typeahead's options."

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm vitest run "app/(app)/products/ProductFilterPanel.test.tsx" "app/(app)/products/(list)/page.test.tsx"`
Expected: PASS.

- [ ] **Step 5: Type-check, lint, commit**

Run: `pnpm typecheck && pnpm exec eslint "app/(app)/products/ProductFilterPanel.tsx" "app/(app)/products/ProductFilterPanel.test.tsx" "app/(app)/products/(list)/page.test.tsx"`
Expected: clean.

```bash
git add "app/(app)/products/ProductFilterPanel.tsx" "app/(app)/products/ProductFilterPanel.test.tsx" "app/(app)/products/(list)/page.test.tsx"
git commit -m "feat(products): category filters in the Explorer's order — broad, department, leaf; the department narrows the leaf typeahead

Labels name the source (Brand Analytics / Keepa); URL parameters and filter
semantics unchanged (spec 2026-10-19 §9).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: The Products tab remembers its last list URL

**Files:**
- Modify: `app/(app)/TabNav.tsx`
- Modify: `app/(app)/TabNav.test.tsx`

Context: spec §10. The Explorer tab's mechanism (a localStorage key, `useSyncExternalStore` with a null server snapshot, an effect that writes on the list page) becomes one hook used by both tabs. `app/(app)/TabNav.test.tsx` drives `usePathname` / `useSearchParams` through its hoisted `nav` object and renders with `tabNav(showConnectAi, showAskAi, showProducts)`; `settled()` keeps the watchlist badge from suspending (see the memory note on `use()` + Suspense in tests).

- [ ] **Step 1: Write the failing tests**

In `app/(app)/TabNav.test.tsx`, after the `describe('remembering the last /explorer URL', …)` block (inside `describe('TabNav', …)`) add:

```tsx
  describe('remembering the last /products URL (spec 2026-10-19 §10)', () => {
    const LAST_PRODUCTS_URL_KEY = 'kw-analytics.last-products-url';
    const productsLink = () => screen.getByRole('link', { name: 'Products' });

    it('on /products, points the Products tab at the current URL and saves it; the Explorer memory is untouched', () => {
      nav.pathname = '/products';
      nav.search = 'dept=Pet+Supplies&sort=listed&page=2';
      render(tabNav(false, false, true));
      expect(productsLink()).toHaveAttribute('href', '/products?dept=Pet+Supplies&sort=listed&page=2');
      expect(localStorage.getItem(LAST_PRODUCTS_URL_KEY)).toBe('/products?dept=Pet+Supplies&sort=listed&page=2');
      expect(localStorage.getItem(LAST_EXPLORER_URL_KEY)).toBeNull();
    });

    it('on /products with no query string, saves the bare /products', () => {
      nav.pathname = '/products';
      render(tabNav(false, false, true));
      expect(productsLink()).toHaveAttribute('href', '/products');
      expect(localStorage.getItem(LAST_PRODUCTS_URL_KEY)).toBe('/products');
    });

    it('elsewhere, points the Products tab at the saved URL and the Explorer tab at its own', () => {
      localStorage.setItem(LAST_PRODUCTS_URL_KEY, '/products?broad=Pet+Products');
      localStorage.setItem(LAST_EXPLORER_URL_KEY, '/explorer?q=creatine');
      nav.pathname = '/watchlist';
      render(tabNav(false, false, true));
      expect(productsLink()).toHaveAttribute('href', '/products?broad=Pet+Products');
      expect(explorerLink()).toHaveAttribute('href', '/explorer?q=creatine');
    });

    it('does not remember product (ASIN) pages, and restores the list from one', () => {
      localStorage.setItem(LAST_PRODUCTS_URL_KEY, '/products?broad=Pet+Products');
      nav.pathname = '/products/B000000001';
      nav.search = 'from=%2Fproducts';
      render(tabNav(false, false, true));
      expect(productsLink()).toHaveAttribute('href', '/products?broad=Pet+Products');
      expect(localStorage.getItem(LAST_PRODUCTS_URL_KEY)).toBe('/products?broad=Pet+Products');
    });

    it('restores the filters after switching to the Explorer and back without remounting', () => {
      nav.pathname = '/products';
      nav.search = 'dept=Books&page=3';
      const { rerender } = render(tabNav(false, false, true));

      nav.pathname = '/explorer';
      nav.search = 'q=zinc';
      rerender(tabNav(false, false, true));
      expect(productsLink()).toHaveAttribute('href', '/products?dept=Books&page=3');
      expect(explorerLink()).toHaveAttribute('href', '/explorer?q=zinc');
    });

    it('elsewhere with nothing saved, falls back to the bare /products', () => {
      nav.pathname = '/watchlist';
      render(tabNav(false, false, true));
      expect(productsLink()).toHaveAttribute('href', '/products');
      expect(localStorage.getItem(LAST_PRODUCTS_URL_KEY)).toBeNull();
    });

    it('still points at the current URL when localStorage rejects the write', () => {
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('QuotaExceededError');
      });
      nav.pathname = '/products';
      nav.search = 'dept=Books';
      render(tabNav(false, false, true));
      expect(productsLink()).toHaveAttribute('href', '/products?dept=Books');
    });

    it('falls back to the bare /products when localStorage cannot be read', () => {
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('SecurityError');
      });
      nav.pathname = '/watchlist';
      render(tabNav(false, false, true));
      expect(productsLink()).toHaveAttribute('href', '/products');
    });

    it('server-renders the bare /products so hydration matches regardless of localStorage', () => {
      localStorage.setItem(LAST_PRODUCTS_URL_KEY, '/products?broad=Pet+Products');
      nav.pathname = '/watchlist';
      const html = renderToString(tabNav(false, false, true));
      expect(html).toContain('href="/products"');
      expect(html).not.toContain('Pet+Products');
    });
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run "app/(app)/TabNav.test.tsx"`
Expected: FAIL — the Products tab always links `/products` (the existing Explorer cases still pass).

- [ ] **Step 3: Lift the Explorer's memory into a hook and use it for both tabs**

In `app/(app)/TabNav.tsx`, replace everything from the doc comment above `const LAST_EXPLORER_URL_KEY` through the end of the `TabNav` function (keep the imports and `WatchlistBadge`) with:

```tsx
/**
 * Top-level navigation: Explorer | Products (only when showProducts is true) |
 * Watchlist (N) | Category Builder | Ask AI (only when showAskAi is true) |
 * Connect AI (only when showConnectAi is true) | Tutorials.
 *
 * Server-rendered text but client-side for usePathname() so the active
 * tab gets styled correctly without a full page reload after navigation.
 *
 * Remembers the most recent /explorer and /products list URLs (including
 * filter query params) so switching to another tab and back returns you
 * to the same filter state — instead of resetting to defaults. Stored in
 * localStorage, scoped per-browser (useRememberedListUrl, one key per tab).
 *
 * Detail-page URLs (/explorer/keyword/[id], /products/[asin]) are
 * intentionally NOT remembered — clicking a tab from a detail page should
 * return to its list, not back to the same detail page.
 *
 * The watchlist badge count arrives as a promise and streams in via
 * <Suspense> (see WatchlistBadge) so it never blocks the nav render.
 */
const LAST_EXPLORER_URL_KEY = 'kw-analytics.last-explorer-url';
const LAST_PRODUCTS_URL_KEY = 'kw-analytics.last-products-url';

// A remembered URL is read from localStorage via useSyncExternalStore
// instead of being copied into state from an effect (which the
// react-hooks/set-state-in-effect rule rejects). Every render re-reads
// the snapshot, and the only same-tab writer is the hook's own effect
// — its value is in place before the next render — so there is nothing
// to subscribe to and the subscription is a no-op. The server snapshot
// is null: the server render and the hydrating client render both show
// the bare list URL, and React re-renders with the real value right
// after hydration.
const subscribeToNothing = () => () => {};
const getServerSnapshot = () => null;
function readItem(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * Where a list tab points. On its own list page (`onListPage`) that's the
 * current URL, which the effect also records under `key`. Anywhere else
 * (another tab, a detail page) it's the remembered URL, so the tab restores
 * the user's filters, or the bare `base` when nothing is remembered or
 * localStorage is unavailable.
 */
function useRememberedListUrl({ key, base, onListPage, currentUrl }: { key: string; base: string; onListPage: boolean; currentUrl: string }): string {
  const remembered = useSyncExternalStore(subscribeToNothing, () => readItem(key), getServerSnapshot);
  useEffect(() => {
    if (!onListPage) return;
    try {
      localStorage.setItem(key, currentUrl);
    } catch {}
  }, [key, onListPage, currentUrl]);
  return onListPage ? currentUrl : remembered || base;
}

export function TabNav({
  watchlistCountPromise,
  showConnectAi,
  showAskAi,
  showProducts,
}: {
  watchlistCountPromise: Promise<number>;
  showConnectAi: boolean;
  showAskAi: boolean;
  showProducts: boolean;
}) {
  const pathname = usePathname() ?? '';
  const searchParams = useSearchParams();
  const isExplorer = pathname === '/explorer' || pathname.startsWith('/explorer/');
  const isProducts = pathname === '/products' || pathname.startsWith('/products/');
  const isWatchlist = pathname === '/watchlist' || pathname.startsWith('/watchlist/');
  const isCategoryBuilder = pathname === '/category-builder' || pathname.startsWith('/category-builder/');
  const isAskAi = pathname === '/ask' || pathname.startsWith('/ask/');
  const isConnectAi = pathname === '/connect-ai' || pathname.startsWith('/connect-ai/');

  // The two list tabs: on the list page itself (NOT /explorer/keyword/*,
  // NOT /products/*), the tab is the current URL, which is also recorded;
  // anywhere else it's the remembered one. Both hooks run on every render
  // (a hook cannot sit behind showProducts).
  const qs = searchParams?.toString() ?? '';
  const explorerHref = useRememberedListUrl({
    key: LAST_EXPLORER_URL_KEY,
    base: '/explorer',
    onListPage: pathname === '/explorer',
    currentUrl: qs ? `/explorer?${qs}` : '/explorer',
  });
  const productsHref = useRememberedListUrl({
    key: LAST_PRODUCTS_URL_KEY,
    base: '/products',
    onListPage: pathname === '/products',
    currentUrl: qs ? `/products?${qs}` : '/products',
  });

  // Navy-bar tabs (2026-07 reskin): active = white with an amber underline
  // pinned to the bar's bottom edge; inactive = slate, brightens on hover.
  const tabClass = (active: boolean) =>
    `relative flex h-full items-center whitespace-nowrap px-1 text-sm font-semibold ${
      active
        ? 'text-white after:absolute after:inset-x-0 after:bottom-0 after:h-[3px] after:rounded-t after:bg-amber-300'
        : 'text-slate-300 hover:text-white'
    }`;

  return (
    <nav className="flex h-full items-stretch gap-6">
      <Link href={explorerHref} className={tabClass(isExplorer)}>
        Explorer
      </Link>
      {showProducts && (
        <Link href={productsHref} className={tabClass(isProducts)}>
          Products
        </Link>
      )}
      <Link href="/watchlist" className={tabClass(isWatchlist)}>
        Watchlist{' '}
        <Suspense fallback={null}>
          <WatchlistBadge countPromise={watchlistCountPromise} active={isWatchlist} />
        </Suspense>
      </Link>
      <Link href="/category-builder" className={tabClass(isCategoryBuilder)}>
        Category Builder
      </Link>
      {showAskAi && (
        <Link href="/ask" className={tabClass(isAskAi)}>
          Ask AI
        </Link>
      )}
      {showConnectAi && (
        <Link href="/connect-ai" className={tabClass(isConnectAi)}>
          Connect AI
        </Link>
      )}
      {/* Lives in the marketing layout (/help) — never matches an app
          pathname, so it never shows the active underline. Intentional. */}
      <Link href="/help" className={tabClass(false)}>
        Tutorials
      </Link>
    </nav>
  );
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm vitest run "app/(app)/TabNav.test.tsx"`
Expected: PASS — the Explorer cases unchanged, the nine Products cases new.

- [ ] **Step 5: Type-check, lint, commit**

Run: `pnpm typecheck && pnpm exec eslint "app/(app)/TabNav.tsx" "app/(app)/TabNav.test.tsx"`
Expected: clean (`react-hooks/set-state-in-effect` and `react-hooks/rules-of-hooks` are satisfied: no state, both hooks unconditional).

```bash
git add "app/(app)/TabNav.tsx" "app/(app)/TabNav.test.tsx"
git commit -m "feat(nav): the Products tab remembers its last list URL, like the Explorer tab

One useRememberedListUrl hook for both tabs (localStorage, null server
snapshot); detail pages are never remembered (spec 2026-10-19 §10).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Final review, build, docs

Not a subagent implementation task: the controller runs it.

- [ ] **Step 1: The whole suite, the build**

Run: `pnpm vitest run` then `pnpm typecheck` then `pnpm build`.
Expected: every test green (the suite was 2,9xx at arc 10), no type errors, a clean build. Capture `$?` of the vitest run before trusting a piped output.

- [ ] **Step 2: Final whole-diff review**

Dispatch a code-reviewer subagent over `git diff 1fe214d..HEAD` (the spec commit to the last task commit) with the spec and this plan, looking for what per-task reviews miss: the ship-order dependency on 0055 (nothing on `main` may be pushed before the owner's steps), an empty facets table's behaviour end to end, the thirteen-column order against spec §8, the renamed labels everywhere (the Connect AI guide or the research guide text, if they name the filters), the hook's hydration safety. Fix findings through the warm implementers (or inline for one-line nits), re-run the touched suites, commit.

- [ ] **Step 3: Docs**

Append a "Landed shape" section to this plan (what each task actually produced: file list, commit SHAs, test counts) and update the arc memory (`products-page-perf.md`: the arc is code-complete, awaiting Task 11). One docs commit:

```bash
git add docs/superpowers/plans/2026-10-19-products-list-polish.md
git commit -m "docs(products): list polish plan — landed shape

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Stop here. Task 11 is the owner's.

---

### Task 11: Ship (owner-gated, in order)

Not a subagent task: the controller runs it with the owner, each step on the owner's go (spec §13). The apply script below is written at step 1 and never committed. Record each step in the Results table at the end.

- [ ] **Step 1: Migration 0055**

Write the UNTRACKED `scripts/applyMigration0055.ts`:

```ts
// scripts/applyMigration0055.ts (UNTRACKED — run only on the owner's go)
/**
 * Applies db/migrations/0055_product_category_facets.sql in one short transaction: the table is new and empty,
 * so a plain CREATE INDEX is instant (no CONCURRENTLY needed). Idempotent (IF NOT EXISTS).
 * Run: APPLY_0055=yes node --env-file=.env.local --import tsx scripts/applyMigration0055.ts
 * Expect: "3 statements", three "ok:" lines, "committed", "assertions passed (0 rows)".
 */
import { readFileSync } from 'node:fs';
import { Client } from 'pg';

if (process.env.APPLY_0055 !== 'yes') { console.error('Refusing to run: set APPLY_0055=yes'); process.exit(1); }
if (!process.env.DATABASE_URL) { console.error('Refusing to run: DATABASE_URL is not set'); process.exit(1); }
const code = (e: unknown) => (e as { code?: string })?.code ?? (e instanceof Error ? e.name : 'unknown');

(async () => {
  const sqlText = readFileSync('db/migrations/0055_product_category_facets.sql', 'utf8');
  const statements = sqlText.split(/-->\s*statement-breakpoint/).map((s) => s.replace(/^\s*--.*$/gm, '').trim().replace(/;\s*$/, '')).filter((s) => s.length > 0);
  if (statements.length !== 3) throw new Error(`split_mismatch: ${statements.length} statements`);
  console.log(`Applying 0055_product_category_facets.sql (${statements.length} statements)`);
  const c = new Client({ connectionString: process.env.DATABASE_URL, statement_timeout: 120_000 });
  c.on('error', () => undefined);
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL lock_timeout = '5s'");
    for (const s of statements) { await c.query(s); console.log(`ok: ${s.slice(0, 72).replace(/\s+/g, ' ')}…`); }
    await c.query('COMMIT');
    console.log('committed');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end();
    throw e;
  }
  try {
    const cols = await c.query<{ n: number }>("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'product_category_facets'");
    const idx = await c.query<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE tablename = 'product_category_facets' ORDER BY 1");
    const names = idx.rows.map((r) => r.indexname);
    if (cols.rows[0].n !== 4) throw new Error(`column_count: ${cols.rows[0].n}`);
    if (!names.includes('product_category_facets_department_idx') || !names.includes('product_category_facets_pkey')) throw new Error(`indexes: ${names.join(',')}`);
    const rows = await c.query<{ n: number }>('SELECT count(*)::int AS n FROM product_category_facets');
    console.log(`assertions passed (${rows.rows[0].n} rows)`);
  } finally {
    await c.end();
  }
})().catch((e) => { console.error('failed:', code(e)); process.exit(1); });
```

Run (owner's go): `APPLY_0055=yes node --env-file=.env.local --import tsx scripts/applyMigration0055.ts`
Expected: `3 statements`, three `ok:` lines, `committed`, `assertions passed (0 rows)`.

- [ ] **Step 2: The first facets build**

Optional dry run first: `PRODUCT_FACETS_DRY_RUN=1 node --env-file=.env.local --import tsx scripts/buildProductCategoryFacets.ts` (read-only; prints the counts).
Run (owner's go): `node --env-file=.env.local --import tsx scripts/buildProductCategoryFacets.ts`
Expected: `built in N.Ns: paths≈23429 departments=36 products≈1176481` (the 2026-10-19 probe's numbers; a later week drifts slightly). Cross-check read-only: `SELECT count(*)::int AS paths, count(DISTINCT department)::int AS departments, sum(product_count)::bigint AS products FROM product_category_facets` equals the printed stats.

- [ ] **Step 2b: The integration case (owner's go)**

Run: `RUN_INTEGRATION=1 pnpm vitest run tests/integration/productsQueries.test.ts --disableConsoleIntercept -t "option lists"` (read-only against production; Task 5b rewrote the case for the facets). Expect: the facets' path count within 5 % of the live catalog scope (departments printed beside the live count and ≥ 20), the three largest per-department entries printed (each well under 1.5M chars), the per-department statement planned on `product_category_facets_department_idx` with no Sort node (an `Index Only Scan` once the build's VACUUM has set the visibility map; the case prints all-visible pages of total), the departments statement planned, both timed in milliseconds. The case reports as skipped while the table is empty. If the plan shows Seq Scan + Sort beside a low all-visible page count, the build's VACUUM could not set the visibility map (another connection held an older snapshot): run `VACUUM (ANALYZE) product_category_facets` by hand and re-run the case.

- [ ] **Step 3: Push and deploys**

Run: `node --env-file=.env.local --import tsx scripts/checkActiveJobs.ts` (no live import, the explorer aggregate sync older than 70 min, inside the push window), then, as its own Bash call, exactly: `git push origin main`.
Watch: `gh api repos/raw5045/AmazonAnalytics/commits/<sha>/status --jq '"overall: \(.state)", (.statuses[] | "\(.context): \(.state) @ \(.updated_at)")'` until Vercel and both Railway services are green (the Keepa service has no code change here but redeploys with the repo). Then re-sync the Inngest app so the worker's 13th function (the daily facets cron, Task 12) registers: `curl -X PUT https://amazonanalytics-production.up.railway.app/api/inngest` → "Successfully registered"; the Inngest dashboard lists `rebuild-product-category-facets` with its cron (existing crons keep firing without the sync, which hides a missed one). Its first run is the next 14:00 ET: expect a `[category-facets] daily paths=… departments=… products=… in …ms` line in the worker log.

- [ ] **Step 4: Smoke in the owner's Chrome**

On `/products`: the perf line renders (`perf · total=… · auth=… · loads=…`; open it: the loads note names the five reads; `paths` is milliseconds, the count ≈ 23k); the thirteen columns in the spec §8 order; a row with a 30-day comparison shows the chip in its own column, one without shows a dash there and the rank still; Rating and Reviews separate; FBA / Amazon checks and Xs with the counts / availability on hover; the magnifier opens the Amazon listing in a new tab; the filter panel reads Broad category (Brand Analytics) → Department (Keepa) → Leaf categories (Keepa); choosing a department narrows the typeahead and the hint says "in <department>"; a leaf pick + Apply filters as before. Then: apply a filter, click the Explorer tab, click the Products tab — the filtered URL returns (page included); open a product page and use Back to products — the same list. Report what differs from the spec, if anything. Also judge, as the owner: the green check / red X meaning for the Amazon column (a private-label seller may read "Amazon on the listing" as the bad case; neutral icons are a one-line change); the table at your laptop width (Keywords, FBA and Amazon may sit off-screen at 1366 px; the card scrolls sideways as before); the neutral `0%` chip; and the "Broad category (Brand Analytics)" label, which may wrap to two lines in the sidebar.

- [ ] **Step 5: The 2026-10-20 import**

After the import: `SELECT phase, started_at, duration_ms, rows_affected FROM import_phase_timings WHERE phase IN ('ba_crosswalk_build', 'category_facets_build') ORDER BY started_at DESC LIMIT 4` shows `category_facets_build` right after `ba_crosswalk_build`, a few seconds, rows ≈ 23k; the worker log has one `[category-facets] paths=… departments=… products=…` line (the admin chip cannot show hook phases after mark_imported — spec §14); `SELECT max(built_at) FROM product_category_facets` is the latest build's time (the import's phase, or the 14:00 ET cron if it ran after it). If the phase failed, the previous rows are still there: re-run `scripts/buildProductCategoryFacets.ts` and read the failure's code in the worker log.

- [ ] **Step 6: Results**

Fill the table below (one docs commit per step is fine) and update the memory file.

#### Results

| Step | When (UTC) | Outcome |
|---|---|---|
| 0055 applied | 2026-10-19 ≈15:20 UTC | `APPLY_0055=yes … applyMigration0055.ts`: 3 statements, committed, assertions passed (0 rows) |
| First facets build (paths / departments / products / seconds) | 2026-10-19 ≈16:35 UTC | `scripts/buildProductCategoryFacets.ts`: built in 3.8 s: 23,429 / 36 / 1,176,481 (the dry run before it counted the same in 9.2 s cold); exit 0 |
| Integration: option lists on the facets (counts, largest entries, plan) | 2026-10-19 16:44 UTC | PASS (1 passed, 21 skipped): facets 36 / 23,429 / 1,176,481 = live catalog 36 / 23,429; largest entries Books 4,070 paths ≈ 345k chars, Clothing 169k, Kindle Store 159k; per-department plan on the department index, all 443 pages visible, no sort; both list statements 0.17 s warm |
| Push (sha) + three deploys green | 2026-10-19 ≈16:50 UTC | checkActiveJobs clean (no live runs, aggregate sync 555 min old); `git push origin main` 644cd05..3d00b84 (46 commits); keepa-importer 16:45:35Z, Vercel 16:46:25Z, worker 16:48:01Z all success; Inngest re-sync `PUT /api/inngest` → "Successfully registered", function_count 13 |
| Smoke (page) | 2026-10-19 ≈17:05 UTC, owner's Chrome | PASS: first load after the deploy 3.7 s to results (cache entries fresh after the deploy; perf line total 1,874 ms = auth 103 + loads 1,771), warm reload 0.76 s (perf 439 ms: search 163 · departments 45 · broad 161 · paths 382 (23,429 · 1.9 MB) · custom 240); thirteen headers in the spec order; Rating / Reviews and BSR / vs 30d split with the chip tooltip; FBA / Amazon read Yes / No with the counts and availability in the cell titles; magnifier → amazon.com/dp/ASIN with aria-label; filter block Broad (Brand Analytics) → Department (Keepa) → Leaf categories (Keepa); Department = Pet Supplies narrows the typeahead (525 categories in Pet Supplies; 'dog' lists Dogs › …); Apply → ?dept=Pet+Supplies → Explorer tab → Products tab returns to ?dept=Pet+Supplies with the filter applied; a product page's Back to products returns to the same list. Owner's visual judgements (icons' colour meaning, laptop width, neutral 0% chip, the Broad label wrap) pending the owner's own look |
| Daily cron's first run (Task 12) | 2026-10-19 18:00:49 UTC (14:00 ET) | `built_at` advanced from 16:44 to 18:00:49 UTC; 23,429 paths / 36 departments; the table sits at 885 pages, all visible (DELETE + INSERT with TRUNCATE false, then the VACUUM) |
| 2026-10-20 import: `category_facets_build` (duration / rows) | 2026-10-20 16:51:27 UTC | 4 s, 22,925 rows, right after `ba_crosswalk_build` (12 s, 24,271 paths, week 2026-10-17) and before `summary_refresh` (9,136 s); the 14:00 ET cron rebuilt again at 18:00:01 UTC (22,943 paths / 35 departments after the week's re-scope). The import itself: first attempt 2026-10-19 died in the COPY (the worker crashed on an unhandled R2 stream error — hotfix a4448f6/378082a/66617bb shipped 2026-10-20 07:00 ET), re-run 13:23–19:24 UTC: COPY 213 s / 2,879,753 rows, kwm_insert 3.1 h, keepa_enqueue 2,396,314, top_asins 8,518,156, summary_refresh 2.5 h; kwm 2,844,079 rows for the week; no old Keepa job run (arc 11) |

Rollback: reverting the code needs no DDL; the table can stay (the next import simply stops rebuilding it).

---

## Landed shape (2026-10-19, subagent-driven; local commits on `main`, nothing pushed)

Every task had a spec-compliance review and a code-quality review; the nits each raised were applied by the same implementer before the next task closed. Gate at `5ab3adf`: `pnpm vitest run` 242 files / 2,978 tests green, `pnpm typecheck` clean, `pnpm build` clean (56 static pages); re-run at the final HEAD after the review follow-ups: at `a09c495` (a09c495 + cda6019 + 2a44dc7 + efc562e): 242 files / 2,979 tests green, typecheck clean, build clean.

| Task | Commits | Tests (file) |
|---|---|---|
| 1 Migration 0055 + mirror | c21459a; nits 43a840a (whole-COMMENT pin, row-type pin, header + mirror wording) | `db/schema/productCategoryFacets.test.ts` 5 |
| 2 Facets builder | 13d53a6; nits 984173e (COMMIT-failure case, telling INSERT fixture, VACUUM comment names the visibility map) | `lib/products/buildCategoryFacets.test.ts` 14 |
| 3 Import phase + chip | f5a2e2a, 5626097 (the three earlier connect-failure chains hand the facets phase its client); nits 036b5b5 (replay comment, positive assertions) | `inngest/functions/importFile.test.ts` 26; `app/admin/ImportStatusChip.test.tsx` 6 |
| 4 Hand-run build script | ae85ba9; nits f711c9c (failure stage + hints per SQLSTATE, exit 2 on a zero-row build, header accuracy) | — (typecheck + eslint) |
| 5 Readers on the facets | 335155b; nits fe8e277 (code-unit re-sort visible on both lists, whole-sequence pin, departments-read failure, header accuracy) | `lib/products/listCategories.test.ts` 11 |
| 5b Integration option-lists case (added during execution) | de8b0b1 | `tests/integration/productsQueries.test.ts` (owner-run, read-only; skips while the table is empty) |
| 6 `timed()` + perf panel | 244b77c, c5c685c (parallel-reads case, `pathChars`); nits 468250d (honest `loads` docstring, `timed()` wording, `app/(app)/PerfPanel.test.tsx`) | `lib/perf/handlerTimer.test.ts` 4; `app/(app)/PerfPanel.test.tsx` 2; `app/(app)/products/(list)/page.test.tsx` 8 |
| 7 Thirteen-column table | 96a8499; nits 511ee02 (neutral chip at the average with a tooltip, `ariaSort(filters, sort)`, star `aria-hidden`, hidden-text and tooltip pins, Keepa code 2 case) | `app/(app)/products/ProductResultsTable.test.tsx` 24 |
| 8 Filter panel category block | db53204 (one pre-existing case picks inside the department now); nits cbc1148 (separator rule pinned, adjacency-proving order test, mixed picks survive a department change, "1 category") | `app/(app)/products/ProductFilterPanel.test.tsx` 42 |
| 9 Tab memory | 27eb960; nits 5ab3adf (stable `getSnapshot`, `RememberedListUrlArgs`, `readStoredUrl`, the two memories proven apart, a real "and back") | `app/(app)/TabNav.test.tsx` 29 |
| docs | 4b5299b (chip gap, follow-ups, Task 2 count), b8372d9 (Task 5b + step 2b), cf3d21a (step 2b wording), 4febde3 (review findings) | — |
| 12 Daily facets cron (owner's decision after the final review; see Task 12 below) | 8b32ab1; nits 9c7f20b | `inngest/functions/rebuildProductCategoryFacets.test.ts` 5 |
| Final whole-diff review (Ship) follow-ups | a09c495 (the builder refuses an empty build: `facets_empty` rolls back and keeps last build's rows; INSERT in index order), cda6019 (script: `facets_empty` hint, dead zero-row branch removed), 2a44dc7 (research loaders' and readers' comments), efc562e (perf-panel footnote: the remainder is read before the render) | `lib/products/buildCategoryFacets.test.ts` 15 |

Deviations from the spec text, all reviewed: the builder reads its stats from the table inside the transaction (equivalent under the lock) and vacuums with `TRUNCATE false`; the FBA header says "hover a cell for"; `BsrCell` was replaced (rank inline + `RatioCell`); the chip at exactly the average is a neutral slate chip, not bare `0%`; spec §13's chip sentence was removed (the admin chip cannot show post-import phases; pre-existing, §14). Found by the reviews and recorded in spec §14: the chip gap, a pooled-phase helper for `importFile.ts`, the typeahead placeholder, the dead-pick note, `amazon=no` semantics, the magnifier contrast; the builder's floor guard was added in the follow-ups (a09c495).

---

### Task 12: Daily facets rebuild cron (added 2026-10-19 after the final review; owner's decision)

**Why:** the Products tools validate category paths against the facets (`lib/research/products.ts`); the Keepa service adds paths all week, so with a weekly build a path first seen after the import is rejected with a false CATEGORY_NOT_AVAILABLE until the next import (spec §14). A daily rebuild (about two seconds) caps that lag at a day.

**Files:**
- Create: `inngest/functions/rebuildProductCategoryFacets.ts` — `rebuildProductCategoryFacetsFn`: `inngest.createFunction({ id: 'rebuild-product-category-facets', name: 'Daily: rebuild product_category_facets', retries: 0, concurrency: { limit: 1 }, triggers: [{ cron: 'TZ=America/New_York 0 14 * * *' }] }, …)`; its own one-connection `pg` Pool with the import phase's options and `'error'` guards; `buildProductCategoryFacets(client)`; logs `[category-facets] daily paths=… departments=… products=… in …ms`; on failure logs `[category-facets] daily rebuild failed (previous rows stay) {"stage","error","code"}` through `errFields` and resolves `{ ok: false, stage, code }` (fail-soft; tomorrow is the retry); release and `pool.end()` in `finally`.
- Create: `inngest/functions/rebuildProductCategoryFacets.test.ts` — the config pins; success (pool options, guard before the build, the log line, cleanup, the return); a build failure and a `facets_empty` refusal (coded log fields only, no message text, cleanup, resolves ok false); a connect failure (stage `connect`, builder never called).
- Modify: `inngest/functions/index.ts` — the worker's 13th registered function.

**Ship:** after the deploy, re-sync the Inngest app so the 13th function registers (`PUT https://amazonanalytics-production.up.railway.app/api/inngest`, as for arc 11); the first run is the next 14:00 ET; check the worker log for the `[category-facets] daily …` line and `max(built_at)`.

**Landed:** 8b32ab1 (function, test, registration; 5 tests), nits 9c7f20b (honest schedule docblock, retries: 1, callers' comments).
