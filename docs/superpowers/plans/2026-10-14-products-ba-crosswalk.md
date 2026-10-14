# Products: one Brand Analytics category per product by a Keepa-path crosswalk — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every product the Products page can return carries exactly one Brand Analytics category, the code its Keepa category path maps to, learned weekly from the report; arc 9's per-row column on the pair table is retired.

**Architecture:** A small table `ba_category_crosswalk` (one row per distinct `asin_products.category_path`) holds the majority Brand Analytics code per path, decided by the votes of products that are the #1 clicked product somewhere (Top Clicked Category #1 is then the product's own category), backing off to parent paths under 20 votes. A builder (`lib/baCategory/`) relearns it at each weekly import, right after the pair-table build; the three readers (search predicate, code list, product facts) join it at read time, so a product has a code the moment Keepa gives it a path. Migration 0053 creates the table before the deploy; migration 0054 drops arc 9's column after it.

**Tech Stack:** Next 16 (App Router; read `node_modules/next/dist/docs/` before touching page code), TypeScript, Postgres on Neon (`pg` for the worker and scripts, `@neondatabase/serverless` for the web readers), drizzle schema mirrors (journal frozen: hand-numbered migrations, applied by untracked owner-gated scripts), Inngest import pipeline, vitest (never type-checks: keep the type-only pins), eslint per file.

**Spec:** `docs/superpowers/specs/2026-10-14-products-ba-crosswalk-design.md` (a302f26 + 5219866). Section numbers below are the spec's.

---

## Conventions (every task)

- Commit trailer, exactly: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Local commits on `main` only; never push (the push is Task 9, owner-gated). `git add` named files only, never `-A` or `.` (the tree holds untracked throwaway scripts).
- Edit with the Edit tool only, exact-match, never converting line endings (the tree mixes CRLF and LF).
- Lint touched files only: `pnpm exec eslint <files>`. Type-check the whole tree: `pnpm typecheck`. Run tests per file: `pnpm vitest run <file>`.
- Never log a DB error's `.message`: the worker uses `errFields` (`@/lib/ask/logSafe`), scripts print `e.code ?? e.name`. Never print member emails.
- No DDL from code or tests. The integration tests (Task 8) are written, never run here: the owner runs them (Task 9).
- `main` hard-depends on migration 0053 from Task 5 on (the readers query `ba_category_crosswalk`): no push, and no hotfix push of `main`, before the owner applies it (Task 9 step 1). A hotfix needed earlier is cherry-picked onto `origin/main`.

## File structure

| File | Responsibility |
|---|---|
| `db/migrations/0053_ba_category_crosswalk.sql` (create) | the crosswalk table + its (code, path) index + comment |
| `db/schema/baCategoryCrosswalk.ts` (create) + `.test.ts` | drizzle mirror, pinned to the migration text |
| `db/migrations/0054_drop_top_asins_broad_category.sql` (create) | drops arc 9's column (and with it the partial index) on the pair table and `_prev` |
| `lib/baCategory/assignCodes.ts` (create) + `.test.ts` | pure: votes + catalog paths → one code per path (prefix totals, MIN_VOTES backoff, ties) |
| `lib/baCategory/buildCrosswalk.ts` (create) + `.test.ts` | the week's votes SQL, the catalog paths SQL, computeCrosswalk (read-only), writeCrosswalk (one transaction), buildCrosswalk |
| `scripts/buildBaCrosswalk.ts` (create, tracked) | the one-off / re-run build by hand |
| `inngest/functions/importFile.ts` + `.test.ts` | phase `ba_crosswalk_build` after `top_asins_build` |
| `lib/products/searchProducts.ts` + `.test.ts` | the broad predicate: a semi-join on the crosswalk by path |
| `lib/products/listCategories.ts` + `.test.ts` | the code list: `SELECT DISTINCT code` |
| `app/(app)/products/ProductFilterPanel.tsx` + `.test.tsx` | the hint under the Broad category select |
| `lib/products/loadProduct.ts` + `.test.ts` | `ProductFacts.broadCategory: string \| null` from a LEFT JOIN in the facts statement; the codes read is gone |
| `app/(app)/products/[asin]/FactsCard.tsx` + `.test.tsx` | one "Broad category" line |
| `lib/research/contracts.ts`, `products.ts`, `tools.ts`, `catalog.ts` + their tests | scalar `product.broadCategory`, new descriptions and rules, `GUIDE_VERSION = 6` |
| `lib/topAsins/buildWeek.ts`, `backfill.ts`, `db/schema/keywordTopAsins.ts` + their tests | the pair table back to eight columns; no broad-index renames |
| `tests/integration/topAsinsBuild.test.ts` | without the carried-code check; tolerant of the column until 0054 |
| `tests/integration/productsQueries.test.ts` | the broad cases rewritten for the crosswalk predicate |
| `tests/integration/baCrosswalk.test.ts` (create) | computeCrosswalk against production, read-only |
| `docs/superpowers/plans/2026-10-14-products-ba-crosswalk.md` | this plan; Task 9's Results table |

---

### Task 1: Migration 0053 and the schema mirror

**Files:**
- Create: `db/migrations/0053_ba_category_crosswalk.sql`
- Create: `db/schema/baCategoryCrosswalk.ts`
- Create: `db/schema/baCategoryCrosswalk.test.ts`
- Modify: `db/schema/index.ts` (one export line after `export * from './keywordTopAsins';`, line 39)

- [ ] **Step 1: Write the failing test**

`db/schema/baCategoryCrosswalk.test.ts`:

```ts
// db/schema/baCategoryCrosswalk.test.ts
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { baCategoryCrosswalk } from '@/db/schema';

describe('ba_category_crosswalk schema (migration 0053, spec 2026-10-14 §4.1)', () => {
  const MARKER = '--> statement-breakpoint';
  const raw = readFileSync('db/migrations/0053_ba_category_crosswalk.sql', 'utf8');
  // The apply script splits on the marker; comment-only lines are not SQL.
  const chunks = raw.split(MARKER);
  const statements = chunks.map((s) => s.replace(/^\s*--.*$/gm, '').trim()).filter((s) => s.length > 0);
  const flat = statements.join(' ').replace(/\s+/g, ' ');
  // Column definitions are the two-space-indented lowercase lines of a CREATE TABLE body.
  const declared = (body: string) => [...body.matchAll(/^ {2}([a-z][a-z0-9_]*) /gm)].map((m) => m[1]).sort();

  it('has 3 statements, one per chunk, split by 2 breakpoints', () => {
    expect(chunks).toHaveLength(3);
    expect(statements).toHaveLength(3);
    for (const s of statements) expect(s.match(/^(COMMENT|CREATE)\b/gm) ?? []).toHaveLength(1);
  });

  it('creates the table exactly as the mirror declares it, keyed by the path', () => {
    const create = statements[0];
    expect(create.startsWith('CREATE TABLE IF NOT EXISTS ba_category_crosswalk (')).toBe(true);
    expect(declared(create)).toEqual(Object.values(getTableColumns(baCategoryCrosswalk)).map((c) => c.name).sort());
    expect(create).toContain('category_path text PRIMARY KEY');
    expect(create).toContain('code varchar(255) NOT NULL');
    expect(create).toContain('source_path text NOT NULL');
    expect(create).toContain('votes integer NOT NULL');
    expect(create).toContain('share_pct smallint NOT NULL');
    expect(create).toContain('week_end_date date NOT NULL');
    expect(create).toContain('built_at timestamptz NOT NULL DEFAULT now()');
  });

  it("indexes (code, category_path): the search predicate's subquery and the code list", () => {
    expect(flat).toContain('CREATE INDEX IF NOT EXISTS ba_category_crosswalk_code_idx ON ba_category_crosswalk (code, category_path)');
    const cfg = getTableConfig(baCategoryCrosswalk);
    const idx = cfg.indexes.find((i) => i.config.name === 'ba_category_crosswalk_code_idx');
    expect(idx?.config.columns.map((c) => (c as { name: string }).name)).toEqual(['code', 'category_path']);
    expect(cfg.columns.find((c) => c.name === 'category_path')?.primary).toBe(true);
    expect(cfg.columns.find((c) => c.name === 'code')?.getSQLType()).toBe('varchar(255)');
    expect(cfg.columns.find((c) => c.name === 'share_pct')?.getSQLType()).toBe('smallint');
  });

  it('says what the table is and that the build relearns it weekly', () => {
    expect(statements[2].startsWith('COMMENT ON TABLE ba_category_crosswalk IS')).toBe(true);
    expect(statements[2]).toContain('relearned at each weekly import (lib/baCategory/buildCrosswalk.ts)');
    expect(statements[2]).toContain("A product''s broad category is the code of its path");
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm vitest run db/schema/baCategoryCrosswalk.test.ts`
Expected: FAIL — `ENOENT` on the migration file / `baCategoryCrosswalk` is not exported from `@/db/schema`.

- [ ] **Step 3: Write the migration**

`db/migrations/0053_ba_category_crosswalk.sql` (the CREATE TABLE body lines are two-space indented, lowercase names first, as the test's `declared` regex reads them):

```sql
-- db/migrations/0053_ba_category_crosswalk.sql
-- 0053 (hand-numbered, applied by the untracked scripts/applyMigration0053.ts on the owner's go;
-- never through drizzle-kit — the journal is frozen). Spec 2026-10-14 (products BA crosswalk) §4.1.
-- ADDITIVE: one small table (Keepa category path → Brand Analytics code, one row per distinct
-- asin_products.category_path, ~24k rows) and its (code, path) index. Empty until the first build
-- (lib/baCategory/buildCrosswalk.ts, run by hand once, then by every weekly import).
-- Must be applied BEFORE the code that reads it deploys: the readers fail loudly (42P01) without it.

CREATE TABLE IF NOT EXISTS ba_category_crosswalk (
  category_path text PRIMARY KEY,
  code varchar(255) NOT NULL,
  source_path text NOT NULL,
  votes integer NOT NULL,
  share_pct smallint NOT NULL,
  week_end_date date NOT NULL,
  built_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ba_category_crosswalk_code_idx ON ba_category_crosswalk (code, category_path);
--> statement-breakpoint
COMMENT ON TABLE ba_category_crosswalk IS
  'Keepa category path (as asin_products.category_path) -> Brand Analytics code, one row per path in the catalog; relearned at each weekly import (lib/baCategory/buildCrosswalk.ts). A product''s broad category is the code of its path. source_path = the path whose vote decided it (the path itself, or the ancestor it backed off to); votes = training products there, all codes; share_pct = the winning code''s share of them.';
```

- [ ] **Step 4: Write the mirror and export it**

`db/schema/baCategoryCrosswalk.ts`:

```ts
// db/schema/baCategoryCrosswalk.ts
import { pgTable, text, varchar, integer, smallint, date, timestamp, index } from 'drizzle-orm/pg-core';

/**
 * Keepa category path → Brand Analytics code (migration 0053; spec 2026-10-14 §4.1): one row per
 * distinct asin_products.category_path, relearned at each weekly import by
 * lib/baCategory/buildCrosswalk.ts. A product's broad category is the code of its path, joined at
 * read time (nothing is stored on the product). The index serves the search predicate's subquery
 * (one code's paths) and the code list.
 */
export const baCategoryCrosswalk = pgTable(
  'ba_category_crosswalk',
  {
    categoryPath: text('category_path').primaryKey(),
    code: varchar('code', { length: 255 }).notNull(),
    /** The path whose votes decided the code: the path itself, or the ancestor it backed off to. */
    sourcePath: text('source_path').notNull(),
    /** Training products at source_path, all codes. */
    votes: integer('votes').notNull(),
    /** The winning code's share of those votes, 0–100. */
    sharePct: smallint('share_pct').notNull(),
    weekEndDate: date('week_end_date').notNull(),
    builtAt: timestamp('built_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    codeIdx: index('ba_category_crosswalk_code_idx').on(t.code, t.categoryPath),
  }),
);

export type BaCategoryCrosswalkRow = typeof baCategoryCrosswalk.$inferSelect;
```

In `db/schema/index.ts`, after line 39 (`export * from './keywordTopAsins';`) add:

```ts
export * from './baCategoryCrosswalk';
```

- [ ] **Step 5: Run the test, lint, type-check**

Run: `pnpm vitest run db/schema/baCategoryCrosswalk.test.ts` — Expected: PASS (4 tests).
Run: `pnpm exec eslint db/schema/baCategoryCrosswalk.ts db/schema/baCategoryCrosswalk.test.ts db/schema/index.ts` — Expected: clean.
Run: `pnpm typecheck` — Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add db/migrations/0053_ba_category_crosswalk.sql db/schema/baCategoryCrosswalk.ts db/schema/baCategoryCrosswalk.test.ts db/schema/index.ts
git commit -m "feat(products): migration 0053 — the Keepa-path → Brand Analytics crosswalk table and its mirror

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `assignCodes`, the pure core

**Files:**
- Create: `lib/baCategory/assignCodes.ts`
- Create: `lib/baCategory/assignCodes.test.ts`

Context: a vote is one training product: `{ path, code, products }` rows come grouped by (path, code) from SQL (Task 3). `PATH_SEP` is `' › '` (`lib/categoryBuilder/buildTree.ts` line 13). The output feeds the INSERT of Task 3.

- [ ] **Step 1: Write the failing tests**

`lib/baCategory/assignCodes.test.ts`:

```ts
// lib/baCategory/assignCodes.test.ts
import { describe, it, expect } from 'vitest';
import { assignCodes, MIN_VOTES, prefixesOf, type CrosswalkVote } from './assignCodes';

const HH = 'Health & Household';
const SUPPLIES = `${HH} › Household Supplies`;
const TISSUES = `${SUPPLIES} › Tissues, Toilet Paper & Sprays`;
const TOILET = `${TISSUES} › Toilet Paper`;
const TOWELS = `${TISSUES} › Paper Towels`;
const PET = 'Pet Supplies';
const DOG_TOYS = `${PET} › Dogs › Toys`;

const vote = (path: string, code: string, products: number): CrosswalkVote => ({ path, code, products });
const byPath = (rows: ReturnType<typeof assignCodes>) => Object.fromEntries(rows.map((r) => [r.categoryPath, r]));

describe('prefixesOf', () => {
  it('lists the path and every ancestor, deepest first, split on the › separator', () => {
    expect(prefixesOf(TOILET)).toEqual([TOILET, TISSUES, SUPPLIES, HH]);
    expect(prefixesOf(HH)).toEqual([HH]);
    const deep = Array.from({ length: 10 }, (_, i) => `L${i + 1}`).join(' › ');
    expect(prefixesOf(deep)).toHaveLength(10);
    expect(prefixesOf(deep)[9]).toBe('L1');
  });
});

describe('assignCodes (spec 2026-10-14 §5.2)', () => {
  it('MIN_VOTES is 20', () => {
    expect(MIN_VOTES).toBe(20);
  });

  it('a path with MIN_VOTES votes decides itself by majority; the row records the source, the votes and the share', () => {
    const rows = assignCodes([vote(TOILET, 'Health & Personal Care', 17), vote(TOILET, 'Biss', 3)], [TOILET]);
    expect(rows).toEqual([{ categoryPath: TOILET, code: 'Health & Personal Care', sourcePath: TOILET, votes: 20, sharePct: 85 }]);
  });

  it('under the threshold a path borrows its parent: the nearest ancestor with MIN_VOTES votes decides', () => {
    // Toilet paper has 5 votes (Biss); its sibling paper towels has 25 (Health & Personal Care). The parent holds 30.
    const votes = [vote(TOILET, 'Biss', 5), vote(TOWELS, 'Health & Personal Care', 25)];
    const rows = byPath(assignCodes(votes, [TOILET, TOWELS]));
    expect(rows[TOILET]).toEqual({ categoryPath: TOILET, code: 'Health & Personal Care', sourcePath: TISSUES, votes: 30, sharePct: 83 });
    expect(rows[TOWELS]).toEqual({ categoryPath: TOWELS, code: 'Health & Personal Care', sourcePath: TOWELS, votes: 25, sharePct: 100 });
  });

  it('a catalog path with no votes of its own takes the nearest ancestor that has enough', () => {
    const rows = assignCodes([vote(TOWELS, 'Health & Personal Care', 20)], [TOILET]);
    expect(rows).toEqual([{ categoryPath: TOILET, code: 'Health & Personal Care', sourcePath: TISSUES, votes: 20, sharePct: 100 }]);
  });

  it('backs off level by level up to the department', () => {
    const rows = assignCodes([vote(`${HH} › Vitamins`, 'Health & Personal Care', 20)], [TOILET]);
    expect(rows[0]).toMatchObject({ categoryPath: TOILET, code: 'Health & Personal Care', sourcePath: HH, votes: 20 });
  });

  it('a department under the threshold still decides when it has any vote; one with none gives no row', () => {
    const rows = assignCodes([vote(DOG_TOYS, 'Pet Products', 3)], [DOG_TOYS, `${PET} › Cats`, 'Gift Cards › Restaurants']);
    expect(rows).toEqual([
      { categoryPath: `${PET} › Cats`, code: 'Pet Products', sourcePath: PET, votes: 3, sharePct: 100 },
      { categoryPath: DOG_TOYS, code: 'Pet Products', sourcePath: PET, votes: 3, sharePct: 100 },
    ]);
  });

  it('exactly MIN_VOTES decides; one fewer backs off', () => {
    const at = assignCodes([vote(TOILET, 'Biss', 20), vote(TOWELS, 'Home', 100)], [TOILET]);
    expect(at[0]).toMatchObject({ code: 'Biss', sourcePath: TOILET, votes: 20 });
    const under = assignCodes([vote(TOILET, 'Biss', 19), vote(TOWELS, 'Home', 100)], [TOILET]);
    expect(under[0]).toMatchObject({ code: 'Home', sourcePath: TISSUES, votes: 119 });
  });

  it('ties break by code text ascending, deterministically', () => {
    const rows = assignCodes([vote(DOG_TOYS, 'Toys', 10), vote(DOG_TOYS, 'Apparel', 10)], [DOG_TOYS]);
    expect(rows[0]).toMatchObject({ code: 'Apparel', votes: 20, sharePct: 50 });
  });

  it('rounds the share to a whole percent', () => {
    const rows = assignCodes([vote(DOG_TOYS, 'Pet Products', 2), vote(DOG_TOYS, 'Toys', 1)], [DOG_TOYS], 3);
    expect(rows[0]).toMatchObject({ code: 'Pet Products', votes: 3, sharePct: 67 });
  });

  it('de-duplicates and sorts the catalog paths, ignores non-positive votes, and never invents a path', () => {
    const votes = [vote(DOG_TOYS, 'Pet Products', 25), vote(DOG_TOYS, 'Toys', 0), vote(TOWELS, 'Home', -4)];
    const rows = assignCodes(votes, [DOG_TOYS, PET, DOG_TOYS]);
    expect(rows.map((r) => r.categoryPath)).toEqual([PET, DOG_TOYS]);
    expect(rows.every((r) => r.code === 'Pet Products')).toBe(true);
    expect(rows.find((r) => r.categoryPath === DOG_TOYS)?.sharePct).toBe(100);
  });

  it('is pure: the same input gives the same output and the inputs are untouched', () => {
    const votes = [vote(TOILET, 'Biss', 30)];
    const paths = [TOWELS, TOILET];
    const a = assignCodes(votes, paths);
    const b = assignCodes(votes, paths);
    expect(a).toEqual(b);
    expect(paths).toEqual([TOWELS, TOILET]);
    expect(votes).toEqual([vote(TOILET, 'Biss', 30)]);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run lib/baCategory/assignCodes.test.ts`
Expected: FAIL — cannot resolve `./assignCodes`.

- [ ] **Step 3: Write the module**

`lib/baCategory/assignCodes.ts`:

```ts
// lib/baCategory/assignCodes.ts
/**
 * The pure core of the crosswalk (spec 2026-10-14 §5.2): from one week's votes (one per training
 * product, grouped by the product's Keepa path and its code) and the catalog's paths, decide one
 * Brand Analytics code per catalog path.
 *
 * Votes count at the path itself and at every ancestor (`Health & Household`, `Health & Household ›
 * Household Supplies`, …), so a path with too few votes borrows its parent's majority. For each
 * catalog path the first prefix, from the path itself upward, with at least MIN_VOTES votes decides;
 * a department (level 1) under MIN_VOTES still decides with any vote at all; a path whose department
 * has no vote gets no row (its products show no category).
 *
 * Deterministic and pure: ties between codes break by code text ascending; the rows come back sorted
 * by path; the inputs are not mutated. No I/O.
 */
import { PATH_SEP } from '@/lib/categoryBuilder/buildTree';

export interface CrosswalkVote {
  /** A Keepa path exactly as asin_products.category_path stores it. */
  path: string;
  /** A Brand Analytics code (Top Clicked Category spelling). */
  code: string;
  /** Training products with this path and this code. */
  products: number;
}

export interface CrosswalkRow {
  categoryPath: string;
  code: string;
  /** The prefix whose votes decided: the path itself, or the ancestor it backed off to. */
  sourcePath: string;
  /** Training products at sourcePath, all codes. */
  votes: number;
  /** The winning code's share of those votes, rounded to a whole percent. */
  sharePct: number;
}

/**
 * Votes a prefix needs to decide on its own. At 20 a 17–3 split is still an 85 % majority, while under
 * it a handful of single-keyword accidents could decide a leaf; higher, and the backoff loses the fine
 * split a leaf gives (measured 2026-10-14: 5,194 paths with 20+ votes hold 86 % of fetched products).
 */
export const MIN_VOTES = 20;

/** `A › B › C` → `['A › B › C', 'A › B', 'A']`: the path and every ancestor, deepest first. */
export function prefixesOf(path: string): string[] {
  const levels = path.split(PATH_SEP);
  const out: string[] = [];
  for (let depth = levels.length; depth >= 1; depth--) out.push(levels.slice(0, depth).join(PATH_SEP));
  return out;
}

type Decision = Omit<CrosswalkRow, 'categoryPath'>;

export function assignCodes(votes: readonly CrosswalkVote[], catalogPaths: readonly string[], minVotes: number = MIN_VOTES): CrosswalkRow[] {
  // Votes per code at every prefix of every voting path.
  const tallies = new Map<string, Map<string, number>>();
  for (const v of votes) {
    if (!(v.products > 0)) continue;
    for (const prefix of prefixesOf(v.path)) {
      let byCode = tallies.get(prefix);
      if (!byCode) tallies.set(prefix, (byCode = new Map()));
      byCode.set(v.code, (byCode.get(v.code) ?? 0) + v.products);
    }
  }
  const decide = (prefix: string): Decision | null => {
    const byCode = tallies.get(prefix);
    if (!byCode) return null;
    let total = 0;
    let winner: { code: string; n: number } | null = null;
    for (const [code, n] of byCode) {
      total += n;
      if (winner === null || n > winner.n || (n === winner.n && code < winner.code)) winner = { code, n };
    }
    if (winner === null || total === 0) return null;
    return { code: winner.code, sourcePath: prefix, votes: total, sharePct: Math.round((100 * winner.n) / total) };
  };
  const rows: CrosswalkRow[] = [];
  for (const path of [...new Set(catalogPaths)].sort()) {
    const prefixes = prefixesOf(path);
    let decided: Decision | null = null;
    for (const prefix of prefixes) {
      const d = decide(prefix);
      if (d !== null && d.votes >= minVotes) { decided = d; break; }
    }
    // The department (the last prefix) decides under the threshold when it has any vote at all.
    if (decided === null) decided = decide(prefixes[prefixes.length - 1]);
    if (decided !== null) rows.push({ categoryPath: path, ...decided });
  }
  return rows;
}
```

- [ ] **Step 4: Run the tests, lint, type-check**

Run: `pnpm vitest run lib/baCategory/assignCodes.test.ts` — Expected: PASS (12 tests).
Run: `pnpm exec eslint lib/baCategory/assignCodes.ts lib/baCategory/assignCodes.test.ts` — Expected: clean.
Run: `pnpm typecheck` — Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add lib/baCategory/assignCodes.ts lib/baCategory/assignCodes.test.ts
git commit -m "feat(products): assignCodes — one Brand Analytics code per Keepa path from the week's votes, with the parent-path backoff

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
### Task 3: `buildCrosswalk` (compute, write, build) and the tracked script

**Files:**
- Create: `lib/baCategory/buildCrosswalk.ts`
- Create: `lib/baCategory/buildCrosswalk.test.ts`
- Create: `scripts/buildBaCrosswalk.ts` (tracked, like `scripts/buildTopAsinsWeek.ts`)

Context: `lib/topAsins/buildWeek.ts` exports `kwmPartitionFor(week)` (the yearly kwm partition, `keyword_weekly_metrics_<year>`; throws `TopAsinsBuildError('top_asins_bad_date')` on a malformed week), `Queryable` (`query(text, values?) → { rowCount, rows }`) and `SqlStatement` (`{ text, values }`). The test helpers `dbCols`, `aliasCols`, `notIn` live in `lib/products/testHelpers.ts`. The week's slot-1 columns on kwm are `top_clicked_product_1_asin` and `top_clicked_category_1`.

- [ ] **Step 1: Write the failing tests**

`lib/baCategory/buildCrosswalk.test.ts`:

```ts
// lib/baCategory/buildCrosswalk.test.ts
import { describe, it, expect } from 'vitest';
import { asinProducts, baCategoryCrosswalk, keywordWeeklyMetrics } from '@/db/schema';
import { dbCols, notIn } from '@/lib/products/testHelpers';
import { TopAsinsBuildError } from '@/lib/topAsins/buildWeek';
import type { CrosswalkRow } from './assignCodes';
import { BaCrosswalkError, CATALOG_PATHS_SQL, buildCrosswalk, computeCrosswalk, insertSql, votesSql, writeCrosswalk, WRITE_CHUNK } from './buildCrosswalk';

const WEEK = '2026-10-10';
const TOYS = 'Pet Supplies › Dogs › Toys';
const CATS = 'Pet Supplies › Cats';
const VITAMINS = 'Health & Household › Vitamins';
const GIFT = 'Gift Cards › Restaurants';
const VOTE_ROWS = [
  { path: TOYS, code: 'Pet Products', products: 30 },
  { path: TOYS, code: 'Toys', products: 2 },
  { path: VITAMINS, code: 'Health & Personal Care', products: 40 },
];
const PATH_ROWS = [{ path: TOYS }, { path: CATS }, { path: VITAMINS }, { path: GIFT }];

/** Answers by statement head (the first match wins) and records every call in order. */
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
const ANSWERS: Array<[string, { rows?: unknown[]; rowCount?: number }]> = [
  ['SELECT a.category_path AS path', { rows: VOTE_ROWS }],
  ['SELECT DISTINCT category_path', { rows: PATH_ROWS }],
  ['INSERT INTO ba_category_crosswalk', { rowCount: 3 }],
];
const row = (categoryPath: string, code: string, sourcePath: string, votes: number, sharePct: number): CrosswalkRow => ({ categoryPath, code, sourcePath, votes, sharePct });

describe('votesSql (spec 2026-10-14 §5.1)', () => {
  const q = votesSql(WEEK);
  it("reads the week's slot-1 rows from its year partition, one vote per product (the mode of category #1), joined to the catalog and grouped by path and code", () => {
    expect(q.text).toContain('FROM keyword_weekly_metrics_2026 m');
    expect(q.text).toContain("m.week_end_date = $1::date AND m.top_clicked_product_1_asin ~ '^[A-Z0-9]{10}$' AND m.top_clicked_category_1 IS NOT NULL");
    expect(q.text).toContain('mode() WITHIN GROUP (ORDER BY m.top_clicked_category_1) AS code');
    expect(q.text).toContain('JOIN asin_products a ON a.asin = v.asin');
    expect(q.text).toContain('WHERE a.category_path IS NOT NULL');
    expect(q.text.trim().endsWith('GROUP BY 1, 2')).toBe(true);
    expect(q.text.startsWith('SELECT a.category_path AS path, v.code, count(*)::int AS products')).toBe(true);
    expect(q.values).toEqual([WEEK]);
  });
  it('names only real columns', () => {
    const m = new Set([...q.text.matchAll(/\bm\.([a-z0-9_]+)/g)].map((x) => x[1]));
    const a = new Set([...q.text.matchAll(/\ba\.([a-z0-9_]+)/g)].map((x) => x[1]));
    expect([...m].sort()).toEqual(['top_clicked_category_1', 'top_clicked_product_1_asin', 'week_end_date']);
    expect([...a].sort()).toEqual(['asin', 'category_path']);
    expect(notIn(m, dbCols(keywordWeeklyMetrics))).toEqual([]);
    expect(notIn(a, dbCols(asinProducts))).toEqual([]);
  });
  it('rejects a malformed week before any SQL (the partition name is interpolated)', () => {
    expect(() => votesSql('2026/10/10')).toThrow(TopAsinsBuildError);
  });
  it('lists the distinct catalog paths', () => {
    expect(CATALOG_PATHS_SQL).toBe('SELECT DISTINCT category_path AS path FROM asin_products WHERE category_path IS NOT NULL');
  });
});

describe('computeCrosswalk', () => {
  it('runs the votes read then the paths read, assigns the codes and counts the stats', async () => {
    const { client, calls, heads } = fakeClient(ANSWERS);
    const { rows, stats } = await computeCrosswalk(client, WEEK);
    expect(heads()).toEqual(['SELECT a.category_path', 'SELECT DISTINCT']);
    expect(calls[0].values).toEqual([WEEK]);
    expect(rows).toEqual([
      row(VITAMINS, 'Health & Personal Care', VITAMINS, 40, 100),
      row(CATS, 'Pet Products', 'Pet Supplies', 32, 94), // no votes of its own: the department decides
      row(TOYS, 'Pet Products', TOYS, 32, 94),
    ]);
    expect(stats).toEqual({ week: WEEK, paths: 3, direct: 2, backedOff: 1, uncoded: 1, trainingProducts: 72, codes: 2 });
  });
  it('a malformed week is refused with its own code, before any query', async () => {
    const { client, calls } = fakeClient(ANSWERS);
    await expect(computeCrosswalk(client, '2026/10/10')).rejects.toMatchObject({ name: 'BaCrosswalkError', code: 'ba_crosswalk_bad_date' });
    expect(calls).toHaveLength(0);
  });
  it('a week with no slot-1 votes is refused (not imported), and the paths read never runs', async () => {
    const { client, calls } = fakeClient([['SELECT a.category_path AS path', { rows: [] }]]);
    await expect(computeCrosswalk(client, WEEK)).rejects.toMatchObject({ code: 'ba_crosswalk_no_votes' });
    expect(calls).toHaveLength(1);
    expect(new BaCrosswalkError('ba_crosswalk_no_votes', 'x').name).toBe('BaCrosswalkError');
  });
});

describe('insertSql', () => {
  const rows = [row(TOYS, 'Pet Products', TOYS, 32, 94), row(CATS, 'Pet Products', 'Pet Supplies', 32, 94)];
  const q = insertSql(rows, WEEK);
  it('inserts the rows from five unnested arrays plus the week, in the mirror\'s columns', () => {
    expect(q.text.replace(/\s+/g, ' ')).toBe(
      'INSERT INTO ba_category_crosswalk (category_path, code, source_path, votes, share_pct, week_end_date) ' +
        'SELECT r.category_path, r.code, r.source_path, r.votes, r.share_pct, $6::date FROM unnest($1::text[], $2::text[], $3::text[], $4::int[], $5::smallint[]) AS r(category_path, code, source_path, votes, share_pct)',
    );
    expect(q.values).toEqual([[TOYS, CATS], ['Pet Products', 'Pet Products'], [TOYS, 'Pet Supplies'], [32, 32], [94, 94], WEEK]);
  });
  it('names only real columns (built_at takes its default)', () => {
    const cols = q.text.slice(q.text.indexOf('(') + 1, q.text.indexOf(')')).split(',').map((c) => c.trim());
    expect(cols).toHaveLength(6);
    expect(notIn(cols, dbCols(baCategoryCrosswalk))).toEqual([]);
  });
});

describe('writeCrosswalk', () => {
  const rows = [row(TOYS, 'Pet Products', TOYS, 32, 94), row(CATS, 'Pet Products', 'Pet Supplies', 32, 94), row(VITAMINS, 'Health & Personal Care', VITAMINS, 40, 100)];
  it('replaces the table in one transaction: BEGIN, TRUNCATE, the INSERTs, COMMIT; returns the rows written', async () => {
    const { client, heads } = fakeClient([['INSERT INTO ba_category_crosswalk', { rowCount: 3 }]]);
    await expect(writeCrosswalk(client, rows, WEEK)).resolves.toBe(3);
    expect(heads()).toEqual(['BEGIN', 'TRUNCATE ba_category_crosswalk', 'INSERT INTO', 'COMMIT']);
  });
  it('chunks the INSERT by WRITE_CHUNK rows', async () => {
    expect(WRITE_CHUNK).toBe(10_000);
    const many = Array.from({ length: WRITE_CHUNK + 1 }, (_, i) => row(`P${i}`, 'Home', `P${i}`, 20, 100));
    const { client, calls, heads } = fakeClient([['INSERT INTO ba_category_crosswalk', { rowCount: 1 }]]);
    await writeCrosswalk(client, many, WEEK);
    expect(heads()).toEqual(['BEGIN', 'TRUNCATE ba_category_crosswalk', 'INSERT INTO', 'INSERT INTO', 'COMMIT']);
    expect((calls[2].values as unknown[][])[0]).toHaveLength(WRITE_CHUNK);
    expect((calls[3].values as unknown[][])[0]).toHaveLength(1);
  });
  it('a failing INSERT rolls back and rethrows the error unchanged', async () => {
    const boom = Object.assign(new Error('SECRET'), { code: '23505' });
    const { client, heads } = fakeClient([['INSERT INTO ba_category_crosswalk', { throws: boom }]]);
    await expect(writeCrosswalk(client, rows, WEEK)).rejects.toBe(boom);
    expect(heads()).toEqual(['BEGIN', 'TRUNCATE ba_category_crosswalk', 'INSERT INTO', 'ROLLBACK']);
  });
});

describe('buildCrosswalk', () => {
  it('refuses a Pool before any query', async () => {
    const pool = { totalCount: 0, async query() { throw new Error('must not run'); } };
    await expect(buildCrosswalk(pool, WEEK)).rejects.toMatchObject({ code: 'ba_crosswalk_bad_client' });
  });
  it('computes, writes, analyzes (best-effort) and returns the stats', async () => {
    const { client, heads } = fakeClient([...ANSWERS, ['ANALYZE', { throws: Object.assign(new Error('late'), { code: '57014' }) }]]);
    await expect(buildCrosswalk(client, WEEK)).resolves.toEqual({ week: WEEK, paths: 3, direct: 2, backedOff: 1, uncoded: 1, trainingProducts: 72, codes: 2 });
    expect(heads()).toEqual(['SELECT a.category_path', 'SELECT DISTINCT', 'BEGIN', 'TRUNCATE ba_category_crosswalk', 'INSERT INTO', 'COMMIT', 'ANALYZE ba_category_crosswalk']);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run lib/baCategory/buildCrosswalk.test.ts`
Expected: FAIL — cannot resolve `./buildCrosswalk`.

- [ ] **Step 3: Write the module**

`lib/baCategory/buildCrosswalk.ts`:

```ts
// lib/baCategory/buildCrosswalk.ts
/**
 * Build the Keepa-path → Brand Analytics crosswalk for one report week (spec 2026-10-14 §5).
 *
 * computeCrosswalk (read-only): one vote per product — the mode of Top Clicked Category #1 over the
 * keywords where the product is the #1 clicked product (the case the report nearly guarantees), joined
 * to the catalog and grouped by the product's path — plus the catalog's distinct paths; assignCodes
 * decides one code per path. writeCrosswalk: TRUNCATE + INSERT in one transaction (readers wait for the
 * commit and then see the new rows; nothing is ever half-written). buildCrosswalk = both, then a
 * best-effort ANALYZE; re-running a week is idempotent.
 *
 * `client` must be ONE dedicated connection (never a Pool): the write is a transaction. Callers: the
 * import phase ba_crosswalk_build (inngest/functions/importFile.ts) and scripts/buildBaCrosswalk.ts.
 * The callers set the statement timeout (30 minutes in the import, 10 in the script).
 */
import { assignCodes, type CrosswalkRow, type CrosswalkVote } from './assignCodes';
import { kwmPartitionFor, type Queryable, type SqlStatement } from '@/lib/topAsins/buildWeek';

export type BaCrosswalkErrorCode = 'ba_crosswalk_bad_date' | 'ba_crosswalk_bad_client' | 'ba_crosswalk_no_votes';
export class BaCrosswalkError extends Error {
  constructor(public readonly code: BaCrosswalkErrorCode, message: string) { super(message); this.name = 'BaCrosswalkError'; }
}

export interface CrosswalkStats {
  week: string;
  /** Rows written: catalog paths that got a code. */
  paths: number;
  /** Paths decided by their own votes. */
  direct: number;
  /** Paths decided by an ancestor's votes. */
  backedOff: number;
  /** Catalog paths that got no row (their department has no vote). */
  uncoded: number;
  /** Products that voted (one vote each). */
  trainingProducts: number;
  /** Distinct codes among the rows. */
  codes: number;
}

const ASIN_RE = "'^[A-Z0-9]{10}$'";

/** The week's votes: one per product (the mode of its category #1), grouped by its path and code. */
export function votesSql(week: string): SqlStatement {
  const partition = kwmPartitionFor(week);
  return {
    text: `SELECT a.category_path AS path, v.code, count(*)::int AS products
FROM (
  SELECT m.top_clicked_product_1_asin AS asin, mode() WITHIN GROUP (ORDER BY m.top_clicked_category_1) AS code
  FROM ${partition} m
  WHERE m.week_end_date = $1::date AND m.top_clicked_product_1_asin ~ ${ASIN_RE} AND m.top_clicked_category_1 IS NOT NULL
  GROUP BY 1
) v
JOIN asin_products a ON a.asin = v.asin
WHERE a.category_path IS NOT NULL
GROUP BY 1, 2`,
    values: [week],
  };
}

/** Every path the crosswalk must decide: the catalog's distinct paths (fetched products only have one). */
export const CATALOG_PATHS_SQL = 'SELECT DISTINCT category_path AS path FROM asin_products WHERE category_path IS NOT NULL';

export async function computeCrosswalk(client: Queryable, week: string): Promise<{ rows: CrosswalkRow[]; stats: CrosswalkStats }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(week)) throw new BaCrosswalkError('ba_crosswalk_bad_date', 'week must be YYYY-MM-DD');
  const votes = votesSql(week);
  const voteRows = (await client.query(votes.text, votes.values)).rows as CrosswalkVote[];
  if (voteRows.length === 0) throw new BaCrosswalkError('ba_crosswalk_no_votes', `week ${week} has no slot-1 rows with a category (not imported?)`);
  const catalogPaths = ((await client.query(CATALOG_PATHS_SQL)).rows as Array<{ path: string }>).map((r) => r.path);
  const rows = assignCodes(voteRows, catalogPaths);
  const direct = rows.filter((r) => r.sourcePath === r.categoryPath).length;
  return {
    rows,
    stats: {
      week,
      paths: rows.length,
      direct,
      backedOff: rows.length - direct,
      uncoded: new Set(catalogPaths).size - rows.length,
      trainingProducts: voteRows.reduce((n, v) => n + v.products, 0),
      codes: new Set(rows.map((r) => r.code)).size,
    },
  };
}

/** Rows per INSERT (24k paths today, so three statements); each binds five arrays and the week. */
export const WRITE_CHUNK = 10_000;

export function insertSql(rows: readonly CrosswalkRow[], week: string): SqlStatement {
  return {
    text: `INSERT INTO ba_category_crosswalk (category_path, code, source_path, votes, share_pct, week_end_date)
SELECT r.category_path, r.code, r.source_path, r.votes, r.share_pct, $6::date
FROM unnest($1::text[], $2::text[], $3::text[], $4::int[], $5::smallint[]) AS r(category_path, code, source_path, votes, share_pct)`,
    values: [rows.map((r) => r.categoryPath), rows.map((r) => r.code), rows.map((r) => r.sourcePath), rows.map((r) => r.votes), rows.map((r) => r.sharePct), week],
  };
}

/** TRUNCATE + INSERT in one transaction: readers queue on the truncate's lock for the moment it takes and then see the new rows. */
export async function writeCrosswalk(client: Queryable, rows: readonly CrosswalkRow[], week: string): Promise<number> {
  await client.query('BEGIN');
  try {
    await client.query('TRUNCATE ba_category_crosswalk');
    let written = 0;
    for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
      const ins = insertSql(rows.slice(i, i + WRITE_CHUNK), week);
      written += (await client.query(ins.text, ins.values)).rowCount ?? 0;
    }
    await client.query('COMMIT');
    return written;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  }
}

export async function buildCrosswalk(client: Queryable, week: string): Promise<CrosswalkStats> {
  if ('totalCount' in client) throw new BaCrosswalkError('ba_crosswalk_bad_client', 'buildCrosswalk needs one dedicated connection, not a Pool');
  const { rows, stats } = await computeCrosswalk(client, week);
  await writeCrosswalk(client, rows, week);
  // Best-effort: the write is committed; the table is small and autovacuum's analyze covers a miss.
  await client.query('ANALYZE ba_category_crosswalk').catch(() => undefined);
  return stats;
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run lib/baCategory/buildCrosswalk.test.ts` — Expected: PASS (14 tests).

- [ ] **Step 5: Write the tracked script**

`scripts/buildBaCrosswalk.ts`:

```ts
// scripts/buildBaCrosswalk.ts
/**
 * Build (or rebuild) the Keepa-path → Brand Analytics crosswalk by hand (spec 2026-10-14 §5.5): the
 * one-off first build after migration 0053, or a re-run after the import's own ba_crosswalk_build
 * phase logged a failure. Relearns ba_category_crosswalk from one report week's slot-1 rows and the
 * catalog's paths per lib/baCategory/buildCrosswalk.ts; re-running a week is idempotent.
 *
 * Run: BA_CROSSWALK_WEEK=2026-10-10 node --env-file=.env.local --import tsx scripts/buildBaCrosswalk.ts
 * BA_CROSSWALK_WEEK defaults to the Explorer week (keyword_current_summary_meta). BA_CROSSWALK_DRY_RUN=1
 * computes and prints the stats without writing.
 * Careful: .env.local's DATABASE_URL points at PRODUCTION — the write replaces the live table in one
 * transaction (readers wait a moment for the commit; the votes read takes about a minute).
 */
import { Pool } from 'pg';
import { buildCrosswalk, computeCrosswalk } from '@/lib/baCategory/buildCrosswalk';

const envWeek = process.env.BA_CROSSWALK_WEEK;
if (envWeek !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(envWeek)) {
  console.error('Refusing to run: BA_CROSSWALK_WEEK must be YYYY-MM-DD (or unset for the Explorer week).');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('Refusing to run: DATABASE_URL is not set (pass --env-file=.env.local).');
  process.exit(1);
}
// Only the exact value 1 is a dry run; anything else ("0", "true", empty) is refused, not ignored.
if (process.env.BA_CROSSWALK_DRY_RUN !== undefined && process.env.BA_CROSSWALK_DRY_RUN !== '1') {
  console.error('Refusing to run: BA_CROSSWALK_DRY_RUN must be 1 (set BA_CROSSWALK_DRY_RUN=1 or unset it).');
  process.exit(1);
}
const dryRun = process.env.BA_CROSSWALK_DRY_RUN === '1';

(async () => {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    statement_timeout: 600_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    connectionTimeoutMillis: 20_000,
  });
  // Dropped-socket guard, as in scripts/buildTopAsinsWeek.ts: an unhandled 'error' would crash the script.
  pool.on('error', () => undefined);
  const client = await pool.connect();
  try {
    client.on('error', () => undefined);
    let week = envWeek;
    if (!week) {
      const meta = await client.query('SELECT current_week_end_date::text AS week FROM keyword_current_summary_meta WHERE singleton');
      week = (meta.rows[0] as { week: string | null } | undefined)?.week ?? undefined;
      if (!week) throw new Error('keyword_current_summary_meta has no week: set BA_CROSSWALK_WEEK');
    }
    console.log(`${dryRun ? 'computing' : 'building'} the crosswalk for week ${week} (the votes read takes about a minute)`);
    const t0 = Date.now();
    const stats = dryRun ? (await computeCrosswalk(client, week)).stats : await buildCrosswalk(client, week);
    console.log(
      `${dryRun ? 'computed' : 'built'} week ${stats.week} in ${((Date.now() - t0) / 1000).toFixed(0)}s: paths=${stats.paths} direct=${stats.direct} ` +
        `backedOff=${stats.backedOff} uncoded=${stats.uncoded} trainingProducts=${stats.trainingProducts} codes=${stats.codes}`,
    );
    if (!dryRun) {
      const top = await client.query(
        `SELECT x.code, count(*)::int AS products FROM asin_products a JOIN ba_category_crosswalk x ON x.category_path = a.category_path
         WHERE a.in_scope AND a.enrichment_status IN ('active', 'no_price') GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 8`,
      );
      for (const r of top.rows as Array<{ code: string; products: number }>) console.log(`  ${r.code}: ${r.products} products`);
    }
  } finally {
    client.release();
    await pool.end();
  }
})().catch((e) => {
  console.error('failed:', e instanceof Error ? e.name : 'unknown', (e as { code?: string })?.code ?? '');
  process.exit(1);
});
```

- [ ] **Step 6: Lint, type-check**

Run: `pnpm exec eslint lib/baCategory/buildCrosswalk.ts lib/baCategory/buildCrosswalk.test.ts scripts/buildBaCrosswalk.ts` — Expected: clean.
Run: `pnpm typecheck` — Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add lib/baCategory/buildCrosswalk.ts lib/baCategory/buildCrosswalk.test.ts scripts/buildBaCrosswalk.ts
git commit -m "feat(products): buildCrosswalk — the week's votes, the catalog's paths, one transactional write; scripts/buildBaCrosswalk.ts

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: The import phase `ba_crosswalk_build`

**Files:**
- Modify: `inngest/functions/importFile.ts` (imports at lines 23–25; the `if (!isReplay) { … }` block that ends after the `top_asins_build` phase, around lines 998–1114)
- Modify: `inngest/functions/importFile.test.ts` (the module mocks at lines 94–102; the `processFileImport — keepa_enqueue hook` describe from line 161: its clients, `mockPoolConnect` chain, `beforeEach`; the pool-count expectations; the `top_asins_build phase` describe from line 327)

Context: the two existing hook phases (`keepa_enqueue`, `top_asins_build`) share one shape: `timePhase(file.id, '<phase>', async () => { own Pool (max 1, statement_timeout 1_800_000, keepAlive, connectionTimeoutMillis 20_000) with an 'error' no-op; connect; client 'error' no-op; the work; release; on error `errFields(e)` → `console.error('[tag] failed (import continues)', JSON.stringify({ week, stage, error, code }))` and return null; pool.end() }, (r) => rows or null)`. The new phase copies the `top_asins_build` block exactly, with these differences: no expected-skip error class (every error is a failure), the log line prints the stats, `rows_affected` = `paths`.

- [ ] **Step 1: Extend the test**

In `inngest/functions/importFile.test.ts`:

1. Next to the declaration of `mockBuildTopAsinsWeek` (grep it; it is declared with the other `vi.fn()` mocks above the `vi.mock` calls — mirror that exact form), declare `mockBuildCrosswalk` the same way.
2. After the `vi.mock('@/lib/topAsins/buildWeek', …)` block (lines 98–102) add:

```ts
// Likewise the crosswalk build: the real BaCrosswalkError stays importable.
vi.mock('@/lib/baCategory/buildCrosswalk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/baCategory/buildCrosswalk')>()),
  buildCrosswalk: mockBuildCrosswalk,
}));
```

3. In `describe('processFileImport — keepa_enqueue hook', …)`: after `const topAsinsClient = …` (line 164) add `const crosswalkClient = { on: vi.fn(), release: vi.fn(), query: vi.fn() };`; change the comment above `copyClient` to end "…the third the top-ASINs phase's, the fourth the crosswalk phase's."; in `beforeEach` extend the connect chain with `.mockResolvedValueOnce(crosswalkClient)` after `topAsinsClient`, and after the `mockBuildTopAsinsWeek` reset add:

```ts
    // A successful crosswalk build by default, so the phase after the pair table adds no stray failure line.
    mockBuildCrosswalk
      .mockReset()
      .mockResolvedValue({ week: '2026-04-11', paths: 0, direct: 0, backedOff: 0, uncoded: 0, trainingProducts: 0, codes: 0 });
```

4. Bump every count of the hook pools: lines 248, 251, 273, 296, 368, 371, 413, 451 from `3` to `4` (and their comments from "the two hook pools" to "the three hook pools"); line 484 `expect(mockPoolCtor).toHaveBeenCalledTimes(3)` → `4`. Lines 321 and 460 (replay: the COPY pool only) stay `1`.
5. In the order test (line 359) the order becomes `['keepa_enqueue', 'top_asins_build', 'ba_crosswalk_build', 'summary_refresh']`, and its `mockPoolOn` last-call comment says "the crosswalk phase's".
6. Append, inside the same outer describe after the `top_asins_build phase` describe, a new describe:

```ts
  // The phase after top_asins_build (spec 2026-10-14 §5.4): the same pool shape and fail-soft rule.
  describe('ba_crosswalk_build phase', () => {
    const crosswalkLines = (spy: { mock: { calls: unknown[][] } }) =>
      spy.mock.calls.map((args) => args.join(' ')).filter((line) => line.includes('[ba-crosswalk]'));
    const crosswalkTimings = () =>
      insertValues.mock.calls
        .map(([row]) => row as { phase?: string; rowsAffected?: number | null })
        .filter((row) => row.phase === 'ba_crosswalk_build');

    it('builds the imported week once, after the pair table and before the summary refresh, logs the stats and cleans up', async () => {
      const { log } = spyConsole();
      mockBuildCrosswalk.mockResolvedValue({ week: '2026-04-11', paths: 23968, direct: 5194, backedOff: 18774, uncoded: 0, trainingProducts: 614676, codes: 118 });

      await processFileImport({ uploadedFileId: 'f1' });

      expect(mockBuildCrosswalk).toHaveBeenCalledTimes(1);
      expect(mockBuildCrosswalk).toHaveBeenCalledWith(crosswalkClient, '2026-04-11');
      expect(mockBuildTopAsinsWeek.mock.invocationCallOrder[0]).toBeLessThan(mockBuildCrosswalk.mock.invocationCallOrder[0]);
      expect(mockBuildCrosswalk.mock.invocationCallOrder[0]).toBeLessThan(mockRefreshSummary.mock.invocationCallOrder[0]);
      expect(crosswalkClient.on).toHaveBeenCalledWith('error', expect.any(Function));
      expect(crosswalkClient.release).toHaveBeenCalledTimes(1);
      expect(mockPoolEnd).toHaveBeenCalledTimes(4);
      expect(crosswalkLines(log)).toEqual(['[ba-crosswalk] week 2026-04-11: paths=23968 direct=5194 backedOff=18774 uncoded=0 trainingProducts=614676 codes=118']);
      expect(crosswalkTimings()).toEqual([expect.objectContaining({ rowsAffected: 23968 })]);
    });

    it('a failure logs only the week, stage, error name and code; the import completes with a null timing row', async () => {
      const { log, err } = spyConsole();
      mockBuildCrosswalk.mockRejectedValue(Object.assign(new Error('SECRET failed query params'), { name: 'error', code: '57014' }));

      await expect(processFileImport({ uploadedFileId: 'f1' })).resolves.toEqual({ rowsImported: expect.any(Number) });

      expect(crosswalkLines(err)).toEqual(['[ba-crosswalk] failed (import continues) {"week":"2026-04-11","stage":"build","error":"error","code":"57014"}']);
      expect([...log.mock.calls, ...err.mock.calls].flat().join(' ')).not.toContain('SECRET');
      expect(crosswalkClient.release).toHaveBeenCalledTimes(1);
      expect(mockPoolEnd).toHaveBeenCalledTimes(4);
      expect(mockRefreshSummary).toHaveBeenCalledTimes(1);
      expect(crosswalkTimings()).toEqual([expect.objectContaining({ rowsAffected: null })]);
    });

    it('a connect failure is logged at the connect stage', async () => {
      const { err } = spyConsole();
      mockPoolConnect.mockReset().mockResolvedValueOnce(copyClient()).mockResolvedValueOnce(hookClient).mockResolvedValueOnce(topAsinsClient)
        .mockRejectedValueOnce(Object.assign(new Error('SECRET'), { code: 'ECONNRESET' }));

      await processFileImport({ uploadedFileId: 'f1' });

      expect(crosswalkLines(err)).toEqual(['[ba-crosswalk] failed (import continues) {"week":"2026-04-11","stage":"connect","error":"Error","code":"ECONNRESET"}']);
      expect(mockBuildCrosswalk).not.toHaveBeenCalled();
      expect(mockRefreshSummary).toHaveBeenCalledTimes(1);
    });
  });
```

(`errFields` reports an Error's `name` as `error`; an `ECONNRESET` error has no pg code, so `code` is the string the helper gives for a missing code — run the test once to read what `errFields` returns for `{ code: 'ECONNRESET' }` and keep whichever of `'ECONNRESET'` the helper passes through; if the helper drops non-SQLSTATE codes, assert what it prints, never the message.)

7. In the replay test that asserts `mockPoolConnect` was called once (line ~460), add `expect(mockBuildCrosswalk).not.toHaveBeenCalled();`.

- [ ] **Step 2: Run the file to see the new tests fail**

Run: `pnpm vitest run inngest/functions/importFile.test.ts`
Expected: FAIL — the three new tests (no phase yet) and the bumped counts (3 pools, not 4).

- [ ] **Step 3: Add the phase**

In `inngest/functions/importFile.ts`, after line 24 add `import { buildCrosswalk } from '@/lib/baCategory/buildCrosswalk';`. Inside `if (!isReplay) { … }`, right after the `top_asins_build` `await timePhase(…);` call (the one ending with `(r) => (r ? r.rows : null),\n      );`) and before the block's closing `}`, insert:

```ts

      // ----------------------------------------------------------------
      // Brand Analytics crosswalk (spec 2026-10-14 §5.4): relearn the Keepa
      // path → code mapping from this week's report, right after the pair
      // table and BEFORE the long summary refresh. Fail-soft, like the two
      // phases above: a failure never fails the import — the previous
      // crosswalk stays in place and scripts/buildBaCrosswalk.ts re-runs
      // it by hand. Same replay rule: a historical week must not relearn it.
      // ----------------------------------------------------------------
      await timePhase(
        file.id,
        'ba_crosswalk_build',
        async () => {
          const crosswalkPool = new Pool({
            connectionString: env.DATABASE_URL,
            max: 1,
            statement_timeout: 1_800_000,
            keepAlive: true,
            keepAliveInitialDelayMillis: 10_000,
            connectionTimeoutMillis: 20_000,
          });
          // Dropped-socket guards, as in the hand-off above.
          crosswalkPool.on('error', () => undefined);
          let stage: 'connect' | 'build' = 'connect';
          try {
            const client = await crosswalkPool.connect();
            stage = 'build';
            try {
              client.on('error', () => undefined);
              const r = await buildCrosswalk(client, weekEndDate);
              console.log(
                `[ba-crosswalk] week ${weekEndDate}: paths=${r.paths} direct=${r.direct} backedOff=${r.backedOff} uncoded=${r.uncoded} trainingProducts=${r.trainingProducts} codes=${r.codes}`,
              );
              return r;
            } finally {
              client.release();
            }
          } catch (e) {
            const { error, code } = errFields(e);
            console.error(
              '[ba-crosswalk] failed (import continues)',
              JSON.stringify({ week: weekEndDate, stage, error, code }),
            );
            return null;
          } finally {
            await crosswalkPool.end();
          }
        },
        // rows_affected = paths written; null marks a failed build.
        (r) => (r ? r.paths : null),
      );
```

- [ ] **Step 4: Run the file, lint, type-check**

Run: `pnpm vitest run inngest/functions/importFile.test.ts` — Expected: PASS (every test, including the bumped counts).
Run: `pnpm exec eslint inngest/functions/importFile.ts inngest/functions/importFile.test.ts` — Expected: clean.
Run: `pnpm typecheck` — Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add inngest/functions/importFile.ts inngest/functions/importFile.test.ts
git commit -m "feat(import): ba_crosswalk_build phase — relearn the Keepa-path → Brand Analytics crosswalk after the pair table, fail-soft

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: The filter side — the search predicate, the code list, the hint

**Files:**
- Modify: `lib/products/searchProducts.ts` (header lines 7–11; the predicate at lines 83–86)
- Modify: `lib/products/searchProducts.test.ts` (lines 91–110; the `keywordTopAsins` import)
- Modify: `lib/products/listCategories.ts` (header bullet at lines 13–15; `BROAD_CATEGORY_LIST_SQL` and its comment at lines 87–99)
- Modify: `lib/products/listCategories.test.ts` (line 77; lines 115–131)
- Modify: `app/(app)/products/ProductFilterPanel.tsx` (line 215 comment; line 460 hint)
- Modify: `app/(app)/products/ProductFilterPanel.test.tsx` (the test `renders every control at PRODUCT_DEFAULTS`, line 46)

Read `node_modules/next/dist/docs/` for anything touching the page component before editing it (the hint is plain JSX; nothing else changes).

- [ ] **Step 1: Rewrite the search tests**

In `lib/products/searchProducts.test.ts` replace the two tests at lines 91–106 with:

```ts
  it("broadCategory is a semi-join on the crosswalk: the product's path must be one of the code's paths (spec 2026-10-14 §6)", () => {
    const q = productSearchSql({ ...PRODUCT_DEFAULTS, broadCategory: 'Home' }, EMPTY_CATEGORY_SCOPE);
    expect(q.rows.text).toContain('a.category_path IN (SELECT x.category_path FROM ba_category_crosswalk x WHERE x.code = $1::text) AND a.monthly_sold IS NOT NULL');
    expect(q.rows.values).toEqual(['Home', 50, 0]);
    expect(q.count.text).toContain('x.code = $1::text');
    expect(q.count.values).toEqual(['Home']);
    expect(dbCols(baCategoryCrosswalk).has('category_path') && dbCols(baCategoryCrosswalk).has('code')).toBe(true);
  });
  it('the broad category predicate follows the category scope and precedes the offer filters', () => {
    const scope: ProductCategoryScope = { dept: 'Tools', subtreePaths: [], exactPaths: [], scoped: false };
    const q = productSearchSql({ ...PRODUCT_DEFAULTS, dept: 'Tools', broadCategory: 'Home', fba: 'no' }, scope);
    expect(q.rows.text).toContain(
      '(a.category_path = $1::text OR starts_with(a.category_path, $2::text)) AND a.category_path IN (SELECT x.category_path FROM ba_category_crosswalk x WHERE x.code = $3::text) AND a.fba_offer_count = 0',
    );
    expect(q.rows.values).toEqual(['Tools', 'Tools › ', 'Home', 50, 0]);
  });
```

and in the null case (line 108) change `not.toContain('broad_category')` to `not.toContain('ba_category_crosswalk')`. Replace the `keywordTopAsins` import with `baCategoryCrosswalk` (same `@/db/schema` import line; drop `keywordTopAsins` if nothing else in the file uses it — grep first).

- [ ] **Step 2: Rewrite the list tests**

In `lib/products/listCategories.test.ts`: line 77 becomes `if (text.includes('SELECT DISTINCT code FROM ba_category_crosswalk')) return BROAD_ROWS;`. The test at lines 115–125 becomes:

```ts
  it('lists the distinct codes of the crosswalk, in code-unit order (spec 2026-10-14 §7)', async () => {
    await expect(listProductBroadCategories()).resolves.toEqual(['Home', 'Misc SDP', 'Toys', 'apparel']);
    // One neonRunner batch: the page's statement timeout first (its 30 s value is pinned in searchProducts.test.ts), then the list statement.
    expect(neonMock.queries).toHaveLength(2);
    expect(neonMock.queries[0]).toEqual({ text: `SET LOCAL statement_timeout = ${PRODUCT_READ_TIMEOUT_MS}`, values: [] });
    expect(neonMock.queries[1]).toEqual({ text: BROAD_CATEGORY_LIST_SQL, values: [] });
    expect(BROAD_CATEGORY_LIST_SQL).toBe('SELECT DISTINCT code FROM ba_category_crosswalk ORDER BY code');
  });
```

and the next test's title becomes `'an empty crosswalk gives an empty code list; a failed read rejects (never an empty list cached for an hour)'` (its body is unchanged).

- [ ] **Step 3: Pin the hint**

In `app/(app)/products/ProductFilterPanel.test.tsx`, inside `it('renders every control at PRODUCT_DEFAULTS', …)` after the `optionTexts('Broad category')` expectation (line 65) add:

```ts
    expect(screen.getByText("Brand Analytics category, as on the Explorer, mapped from the product's Keepa category. One per product.")).toBeInTheDocument();
```

(`screen` comes from `@testing-library/react`; add it to the file's existing import from that package if it is not already imported.)

- [ ] **Step 4: Run the three files to see them fail**

Run: `pnpm vitest run lib/products/searchProducts.test.ts lib/products/listCategories.test.ts "app/(app)/products/ProductFilterPanel.test.tsx"`
Expected: FAIL — the old predicate, the old list statement, the old hint.

- [ ] **Step 5: Change the code**

`lib/products/searchProducts.ts`: in the header comment replace lines 9–10

```
 * the category predicate (see ./categoryPredicate), and 0052's keyword_top_asins_broad_category_idx for
 * the broad-category semi-join. Rating, FBA and Amazon have no index of their own and ride whichever
```

with

```
 * the category predicate (see ./categoryPredicate), and 0053's ba_category_crosswalk_code_idx for the
 * broad-category semi-join (one code's paths; the equality probes ride asin_products_category_path_idx).
 * Rating, FBA and Amazon have no index of their own and ride whichever
```

and replace lines 84–86 (the two comment lines and the `if`) with:

```ts
  // The product's broad category is the code of its Keepa path (spec 2026-10-14 §6): a semi-join against the code's paths.
  // ba_category_crosswalk_code_idx serves the subquery; asin_products_category_path_idx serves the equality probes.
  if (f.broadCategory !== null) where.push(`a.category_path IN (SELECT x.category_path FROM ba_category_crosswalk x WHERE x.code = ${bind(f.broadCategory)}::text)`);
```

`lib/products/listCategories.ts`: the header bullet (lines 13–15) becomes

```
 *  - listProductBroadCategories: the distinct codes of ba_category_crosswalk (spec 2026-10-14 §7; ~24k
 *    rows, one index scan), read through neonRunner so PRODUCT_READ_TIMEOUT_MS caps it like the page's reads.
```

and lines 87–99 (the comment and the constant) become

```ts
/**
 * The Brand Analytics codes the crosswalk maps paths to (spec 2026-10-14 §7): what the Products page's broad
 * filter can match. Empty until the first build. The text is also a key part of the cache below, so an edit
 * to it starts a new entry (the callback does not inline it).
 */
export const BROAD_CATEGORY_LIST_SQL = 'SELECT DISTINCT code FROM ba_category_crosswalk ORDER BY code';
```

In the comment above `fetchBroadCategoriesSorted` replace "like every web read of keyword_top_asins: a reader holds a lock the weekly table swap waits on (120 s at most), so a stuck one must not outlive it" with "like every web read: the weekly rebuild truncates the table in a transaction readers queue behind for a moment".

`app/(app)/products/ProductFilterPanel.tsx`: line 215 comment → `/** The Brand Analytics codes of the crosswalk (lib/products/listCategories), the Broad category select's options. */`; line 460 → `<p className={HINT}>Brand Analytics category, as on the Explorer, mapped from the product&apos;s Keepa category. One per product.</p>`.

- [ ] **Step 6: Run the three files, lint, type-check**

Run: `pnpm vitest run lib/products/searchProducts.test.ts lib/products/listCategories.test.ts "app/(app)/products/ProductFilterPanel.test.tsx"` — Expected: PASS.
Run: `pnpm exec eslint lib/products/searchProducts.ts lib/products/searchProducts.test.ts lib/products/listCategories.ts lib/products/listCategories.test.ts "app/(app)/products/ProductFilterPanel.tsx" "app/(app)/products/ProductFilterPanel.test.tsx"` — Expected: clean.
Run: `pnpm typecheck` — Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add lib/products/searchProducts.ts lib/products/searchProducts.test.ts lib/products/listCategories.ts lib/products/listCategories.test.ts "app/(app)/products/ProductFilterPanel.tsx" "app/(app)/products/ProductFilterPanel.test.tsx"
git commit -m "feat(products): the broad filter reads the crosswalk — a semi-join on the code's paths, the code list, the hint

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
### Task 6: One `broadCategory` per product, end to end — the loader, the facts card, the tools

**Files:**
- Modify: `lib/products/loadProduct.ts` (the `ProductFacts` doc at lines 61–65 and the field at 77–78; `FACTS_COLUMNS`/`productFactsSql` at 80–93; `productBroadCategoriesSql` at 120–127; `FactsRow` (add `broad_category`); `toFacts`, `untrackedStub`, `loadProduct` at 171–257)
- Modify: `lib/products/loadProduct.test.ts`
- Modify: `app/(app)/products/[asin]/FactsCard.tsx` (header lines 6–7; lines 95–97) and `.test.tsx` (line 43; line 103; lines 162–165)
- Modify: `lib/research/contracts.ts` (lines 338–345 comment; the `broadCategory` filter description at 390–392; the `ProductDetailsResponse` doc at 697–700)
- Modify: `lib/research/products.ts` (line 52 comment; the messages at lines 141–143)
- Modify: `lib/research/tools.ts` (lines 121, 139, 144)
- Modify: `lib/research/catalog.ts` (line 17 `GUIDE_VERSION`; the rules at lines 244 and 251)
- Modify: `lib/research/products.test.ts`, `lib/research/service.test.ts`, `lib/research/tools.test.ts`, `lib/research/catalog.test.ts`, `lib/research/contracts.test.ts`

One task because `ProductFacts` is the shared type: changing it in the loader must land with every consumer so `pnpm typecheck` stays clean at the commit. The research loader named `broadCategories` (the code list for validation) keeps its name; only the facts field changes.

- [ ] **Step 1: Rewrite the loader tests**

In `lib/products/loadProduct.test.ts`:

- Delete the `describe('productBroadCategoriesSql', …)` block (lines 85–97), the `CODES_TEXT` constant (line 19) and `productBroadCategoriesSql` from the import.
- `fakeRun`'s results type loses `codes`; its answer for the facts statement is keyed on the new `FACTS_TEXT` (it is derived from `productFactsSql('x').text`, so it follows the code).
- In the `ACTIVE`, `NEVER_FETCHED` and `UNTRACKED` fixtures replace `broadCategories: [],` with `broadCategory: null,`.
- The facts-statement test (the one asserting `aliasCols(q.text, 'a')`, lines 44–47) gains:

```ts
    expect(q.text).toContain('x.code AS broad_category FROM asin_products a LEFT JOIN ba_category_crosswalk x ON x.category_path = a.category_path WHERE a.asin = $1');
    expect(aliasCols(q.text, 'x')).toEqual(new Set(['code', 'category_path']));
    expect(notIn(aliasCols(q.text, 'x'), dbCols(baCategoryCrosswalk))).toEqual([]);
```

(import `baCategoryCrosswalk` from `@/db/schema` beside `asinProducts`.)

- The stub test (line 208) expects the calls `[FACTS_TEXT, TRACKED_TEXT, FALLBACK_TEXT]` and values `[['B000000003'], ['B000000003'], ['B000000003']]`; the null-title stub test is unchanged; the not-found test expects `[FACTS_TEXT, TRACKED_TEXT]`; the blank-title test's comment becomes `// facts and the keyword-side title` with `toHaveLength(2)`.
- Replace the test `'carries the codes, most keywords first, on a catalog row and on a stub'` (lines 226–233) with:

```ts
  it("carries the code of the product's path from the crosswalk join; null when the path is unmapped or there is no path (spec 2026-10-14 §9)", async () => {
    await expect(loadProduct(fakeRun({ facts: [rawRow({ broad_category: 'Health & Personal Care' })] }).run, 'B000000001')).resolves.toEqual({ ...ACTIVE, broadCategory: 'Health & Personal Care' });
    await expect(loadProduct(fakeRun({ facts: [rawRow({ broad_category: null })] }).run, 'B000000001')).resolves.toEqual(ACTIVE);
    await expect(loadProduct(fakeRun({ facts: [rawRow({ broad_category: '  ' })] }).run, 'B000000001')).resolves.toEqual(ACTIVE);
    // A stub has no path, so no code.
    const { run } = fakeRun({ facts: [], tracked: [{ '?column?': 1 }], fallback: [] });
    await expect(loadProduct(run, 'B000000003')).resolves.toEqual(UNTRACKED);
  });
```

- Delete the test `'starts the facts and codes reads together, not one after the other'` (from line 235 to its end).
- `rawRow()` gains `broad_category: null` in its defaults.

- [ ] **Step 2: Rewrite the facts card tests**

`app/(app)/products/[asin]/FactsCard.test.tsx`: line 43 `broadCategories: ['Home', 'Pet Supplies'],` → `broadCategory: 'Health & Personal Care',`; line 103 → `expect(fact('Broad category')).toHaveTextContent('Health & Personal Care');`; lines 162–165 become:

```ts
  it('a product whose path is unmapped reads a dash for its broad category', () => {
    render(<FactsCard facts={{ ...FULL, broadCategory: null }} now={NOW} />);
    expect(fact('Broad category')).toHaveTextContent(/^—$/);
  });
```

- [ ] **Step 3: Rewrite the research tests**

- `lib/research/products.test.ts`: in `catalogFacts` and `stubFacts` (lines 62, 71) `broadCategories: [],` → `broadCategory: null,`; line 352 → `expect(out.product.broadCategory).toBeNull();`; lines 363–367 become:

```ts
  it("returns the facts' broadCategory as the loader gives it (the code of the product's Keepa path)", async () => {
    const deps = makeDeps({ facts: vi.fn(async () => ({ ...catalogFacts, broadCategory: 'Health & Personal Care' })) });
    const res = await productDetailsForTool(deps, admin, { asin: ASIN });
    expect(res.product.broadCategory).toBe('Health & Personal Care');
  });
```

  and the two `CATEGORY_NOT_AVAILABLE` message expectations for the broad filter (grep `keyword-to-product table` and `clicked products` in this file) become `'No broad categories are available yet: the Keepa-to-Brand-Analytics crosswalk has not been built.'` and `'"Home" is not a broad category of the product catalog. Pass one of: ' + BROAD_CODES.join('; ') + '.'` (keep the file's own way of building the expected string).
- `lib/research/service.test.ts`: line 89 `guideVersion: 5` → `6`; line 426 `broadCategories: [],` → `broadCategory: null,`.
- `lib/research/tools.test.ts`: line 72 → `expect(details).toContain('product.inCatalog false: keywords known, no product facts (the title may still come from the keyword side; broadCategory is null');` and line 73 → `expect(details).toContain("with the product's own Brand Analytics category as broadCategory (the code its Keepa category path maps to; null when the path is unmapped)");`.
- `lib/research/catalog.test.ts`: lines 229–230 `5` → `6`; line 279 → `expect(rules).toContain('inCatalog false: the keywords know the ASIN but there are no product facts (the title may still come from the keyword side; broadCategory is null; usually the category is excluded from enrichment)');`; lines 296–301 become:

```ts
    expect(rules).toContain("filters.department is one of the catalog's storefront departments");
    expect(rules).toContain("not a keyword row's broadCategory");
    expect(rules).toContain("filters.broadCategory is a Brand Analytics code as search_keywords' broadCategory carries it");
    expect(rules).toContain("the product's own category: the code its Keepa category path maps to, one per product, relearned weekly from the report");
    expect(rules).toContain("get_product_details returns it as product.broadCategory");
    expect(rules).toContain("A keyword's broadCategory is the category most clicked for that search");
```

- `lib/research/contracts.test.ts`: the `filters.broadCategory.description` pin (line 529) becomes the new description text from Step 5 below, verbatim.

- [ ] **Step 4: Run the test files to see them fail**

Run: `pnpm vitest run lib/products/loadProduct.test.ts "app/(app)/products/[asin]/FactsCard.test.tsx" lib/research/products.test.ts lib/research/service.test.ts lib/research/tools.test.ts lib/research/catalog.test.ts lib/research/contracts.test.ts`
Expected: FAIL across the board (old field, old statements, old strings, version 5).

- [ ] **Step 5: Change the code**

`lib/products/loadProduct.ts`:

1. `ProductFacts`: the doc at lines 61–65 says "only the keyword-side title can be set"; replace the field at lines 77–78 with

```ts
  /** The Brand Analytics code of the product's Keepa path (ba_category_crosswalk, spec 2026-10-14 §9); null when the path is unmapped or the product has no path. */
  broadCategory: string | null;
```

2. `productFactsSql` becomes

```ts
/** One catalog row by primary key, with its path's Brand Analytics code (a LEFT JOIN: an unmapped path reads null). The only predicate is the ASIN. */
export function productFactsSql(asin: string): SqlStatement {
  return { text: `SELECT ${FACTS_COLUMNS}, x.code AS broad_category FROM asin_products a LEFT JOIN ba_category_crosswalk x ON x.category_path = a.category_path WHERE a.asin = $1`, values: [asin] };
}
```

3. Delete `productBroadCategoriesSql` (the comment and function at lines 120–127). Add `broad_category: string | null;` to `FactsRow` (after `tier: number;`).
4. `toFacts(r, title)` loses its third parameter and sets `broadCategory: nonBlank(r.broad_category)`; `untrackedStub(asin, title)` loses its third parameter and sets `broadCategory: null`.
5. `loadProduct` becomes (replace the doc comment and the function, lines 233–257):

```ts
/**
 * The facts for one ASIN: the primary-key read (which carries the path's code), plus the keyword-side
 * title read only when the row has no title. With no catalog row, one more read checks the reverse
 * table: an ASIN found there is a stub (`inCatalog: false`, no path, so no code); null, which the page
 * answers with a 404, means neither table has the ASIN.
 */
export async function loadProduct(run: SqlRunner, asin: string): Promise<ProductFacts | null> {
  const facts = productFactsSql(asin);
  const row = ((await run(facts.text, facts.values)) as FactsRow[])[0];
  if (row) return toFacts(row, nonBlank(row.title) ?? (await keywordSideTitle(run, asin)));
  const tracked = productTrackedSql(asin);
  if (((await run(tracked.text, tracked.values)) as unknown[]).length === 0) return null;
  return untrackedStub(asin, await keywordSideTitle(run, asin));
}
```

`app/(app)/products/[asin]/FactsCard.tsx`: header lines 6–7 "The Brand Analytics codes of its keyword rows this week read as one line, most keywords first (a dash when none)." → "Its Brand Analytics category (the code of its Keepa path) reads as one line, a dash when the path is unmapped."; lines 95–97 become

```tsx
          <Fact label="Broad category">{facts.broadCategory ?? DASH}</Fact>
```

`lib/research/contracts.ts`:
- lines 340–342 of the comment: "`broadCategory` the page's broadCategory (checked against the pair table's code list)" → "`broadCategory` the page's broadCategory (checked against the crosswalk's code list)".
- the filter description (line 391) becomes:

```ts
      "One Brand Analytics code, spelled as the Explorer's broad categories ('Home', 'Apparel', 'Biss', 'Pet Products'): the product's own category, the code its Keepa category path maps to (one per product, relearned weekly from the report). Independent of filters.department (the product's Keepa storefront department); both may be set. An unknown code fails with CATEGORY_NOT_AVAILABLE and the valid codes.",
```

- the `ProductDetailsResponse` doc (lines 698–700): "so there are no product facts (the title and broadCategories may still come from the keyword side)" → "so there are no product facts (the title may still come from the keyword side; broadCategory is null)".

`lib/research/products.ts`: line 52 → `/** The Brand Analytics codes of the crosswalk (lib/products/listCategories, cached an hour): a search's broadCategory must be one of them. */`; lines 141–143 become

```ts
      const message = codes.length === 0
        ? 'No broad categories are available yet: the Keepa-to-Brand-Analytics crosswalk has not been built.'
        : `"${broad}" is not a broad category of the product catalog. Pass one of: ${codes.join('; ')}.`;
```

`lib/research/tools.ts`:
- line 121: replace "broad category (the Brand Analytics code a keyword row's broadCategory carries; any of a product's codes)" with "broad category (the product's own Brand Analytics code, mapped from its Keepa category path)".
- line 139: replace "with the product's Brand Analytics codes as broadCategories (most keywords first)" with "with the product's own Brand Analytics category as broadCategory (the code its Keepa category path maps to; null when the path is unmapped)".
- line 144: replace "(the title and broadCategories may still come from the keyword side; usually the category is excluded from enrichment)" with "(the title may still come from the keyword side; broadCategory is null; usually the category is excluded from enrichment)".

`lib/research/catalog.ts`:
- line 17: `export const GUIDE_VERSION = 6;`
- line 244 (the whole string) becomes:

```ts
  "filters.broadCategory is a Brand Analytics code as search_keywords' broadCategory carries it ('Home', 'Apparel', 'Biss' …): the product's own category: the code its Keepa category path maps to, one per product, relearned weekly from the report; get_product_details returns it as product.broadCategory. A keyword's broadCategory is the category most clicked for that search, so a product and the keywords it ranks for usually agree but need not (get_product_details lists the product's keywords). filters.department is the product's own Keepa storefront department — a different list; both may be set. An unknown code fails with CATEGORY_NOT_AVAILABLE and the valid codes.",
```

- line 251: replace "(the title and broadCategories may still come from the keyword side; usually the category is excluded from enrichment)" with "(the title may still come from the keyword side; broadCategory is null; usually the category is excluded from enrichment)".

Then grep the tree for the old names and fix every hit in a comment or a string: `grep -rn "broadCategories\b" app lib --include=*.ts --include=*.tsx | grep -v "listProductBroadCategories\|broadCategories: () =>\|deps.broadCategories\|broadCategories()\|ProductLoaders\|'broadCategories'"` (the research LOADER keeps the name; every other hit changes). `app/(app)/products/[asin]/page.tsx` and `StreamedProductSections.tsx` carry comments naming the codes read: reword them to the single code from the facts statement.

- [ ] **Step 6: Run the files, lint, type-check**

Run: `pnpm vitest run lib/products/loadProduct.test.ts "app/(app)/products/[asin]/FactsCard.test.tsx" lib/research/products.test.ts lib/research/service.test.ts lib/research/tools.test.ts lib/research/catalog.test.ts lib/research/contracts.test.ts` — Expected: PASS.
Run: `pnpm exec eslint lib/products/loadProduct.ts lib/products/loadProduct.test.ts "app/(app)/products/[asin]/FactsCard.tsx" "app/(app)/products/[asin]/FactsCard.test.tsx" lib/research/contracts.ts lib/research/products.ts lib/research/tools.ts lib/research/catalog.ts lib/research/products.test.ts lib/research/service.test.ts lib/research/tools.test.ts lib/research/catalog.test.ts lib/research/contracts.test.ts` — Expected: clean.
Run: `pnpm typecheck` — Expected: clean (this is the gate for the type change).
Run: `pnpm vitest run app lib` — Expected: PASS (the page tests of `app/(app)/products` build facts fixtures too: fix any that still carry `broadCategories`).

- [ ] **Step 7: Commit**

```bash
git add lib/products/loadProduct.ts lib/products/loadProduct.test.ts "app/(app)/products/[asin]/FactsCard.tsx" "app/(app)/products/[asin]/FactsCard.test.tsx" "app/(app)/products/[asin]/page.tsx" "app/(app)/products/[asin]/StreamedProductSections.tsx" lib/research/contracts.ts lib/research/products.ts lib/research/tools.ts lib/research/catalog.ts lib/research/products.test.ts lib/research/service.test.ts lib/research/tools.test.ts lib/research/catalog.test.ts lib/research/contracts.test.ts
git commit -m "feat(products): one broadCategory per product — the facts statement joins the crosswalk; facts card, contracts, tool text, GUIDE_VERSION 6

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

(Only add the page files if Step 5's grep changed them.)

---

### Task 7: The pair table back to eight columns, and migration 0054

**Files:**
- Modify: `lib/topAsins/buildWeek.ts` (header lines 11–13 and the two "(only PREV_BROAD_GUARD …)" mentions at lines 36 and 64; `slotSelect` at lines 104–111; `insertText` at 117–139; `BROAD_INDEX`/`PREV_BROAD_GUARD` and the swap at 141–185)
- Modify: `lib/topAsins/buildWeek.test.ts`
- Modify: `lib/topAsins/backfill.ts` (the INSERT at lines 169–174; the swap at lines 236–245; the "all nine columns" comment)
- Modify: `lib/topAsins/backfill.test.ts`
- Modify: `db/schema/keywordTopAsins.ts` (header lines 8–10; the column at 23–24; the index at 29; the unused imports)
- Modify: `db/schema/keywordTopAsins.test.ts`
- Create: `db/migrations/0054_drop_top_asins_broad_category.sql`
- Modify: `tests/integration/topAsinsBuild.test.ts` (written only; the owner runs it)

The column stays in the database until the owner applies 0054 AFTER the deploy (spec §4.2–4.3). The new build must run either way: it names eight columns (an existing ninth, nullable, takes NULL), and `LIKE … INCLUDING ALL` copies whatever the live table has. So nothing here may reference the column, and the integration test must tolerate its presence.

- [ ] **Step 1: Rewrite the build and backfill unit tests**

`lib/topAsins/buildWeek.test.ts`:
- Replace the test at lines 32–38 with one that pins the absence:

```ts
  it('carries no code: the slot selects name the five slot columns only (the crosswalk replaced the per-row code, spec 2026-10-14 §4.2)', () => {
    for (const st of everyMode) {
      for (const slot of [1, 2, 3]) expect(st.insert.text).toContain(`top_clicked_product_${slot}_conversion_share AS conversion_share\n`);
      expect(st.insert.text).not.toContain('broad_category');
      expect(st.insert.text).not.toContain('top_clicked_category');
      expect(st.insert.text).toContain('week_end_date)');
    }
  });
```

- The same-week swap expectation (lines 83–95) becomes the five promote statements after the DROP, with no `_prev` statement at all:

```ts
  it('same-week rebuild: drops the stale current table and promotes _next with its comment; nothing names _prev', () => {
    for (const st of [sameWeekPrev, sameWeekNone]) {
      expect(swapOf(st)).toEqual([
        'DROP TABLE keyword_top_asins',
        'ALTER TABLE keyword_top_asins_next RENAME TO keyword_top_asins',
        CURRENT_COMMENT,
        'ALTER INDEX keyword_top_asins_next_asin_search_term_id_idx RENAME TO keyword_top_asins_asin_idx',
        'ALTER TABLE keyword_top_asins RENAME CONSTRAINT keyword_top_asins_next_pkey TO keyword_top_asins_pkey',
      ]);
      expect(swapOf(st).filter((t) => t.includes('keyword_top_asins_prev'))).toEqual([]);
    }
  });
```

- The rewind expectation (lines 97–108) drops its `ALTER INDEX IF EXISTS keyword_top_asins_next_broad_category_asin_idx …` line. The advance expectation (above line 80; grep `RENAME TO keyword_top_asins_prev_asin_idx`) drops both `IF EXISTS` broad lines.
- Delete the drift test (lines 110–117) and the whole `describe('index-name model …')` block (lines 118–195).
- In `'names only real columns'` (lines 204–215): `kwmCols.size` 14 → 11 (and drop `top_clicked_category_[123]` from the regex), `insertCols` length 9 → 8.
- The transaction case at line 384: title → `'same-week rebuild: carries from _prev, drops the stale current table, keeps the _prev table untouched'`; the `_prev` filter expectation (line 393) → `toEqual([])`.
- Add, beside the real-columns test:

```ts
  it('no swap statement touches a broad-category index (0054 drops the column and its index outside the build)', () => {
    for (const st of everyMode) expect(swapOf(st).some((t) => t.includes('broad_category'))).toBe(false);
  });
```

`lib/topAsins/backfill.test.ts`: `'names only real columns'` (133–140): 14 → 11, 9 → 8, drop the category part of the regex; the `_prev` test title at 204 "(all nine columns, …)" → "(all eight columns, …)"; the swap-length test (line ~216) `toHaveLength(7)` → `5`; delete the third-index test (lines 218–223) and add in its place:

```ts
  it('renames nothing but the asin index and the primary key (no broad-category index since spec 2026-10-14 §4.2)', () => {
    expect(f.swap.map((s) => norm(s.text)).some((t) => t.includes('broad_category'))).toBe(false);
  });
```

`db/schema/keywordTopAsins.test.ts`: the column list at line 12 loses `'broad_category'`; line 67 becomes `expect(declared(createTable('keyword_top_asins'))).toEqual(mirror(getTableColumns(keywordTopAsins)));` with its comment removed; delete the `describe('migration 0052 SQL text', …)` block (lines 82–114) and add:

```ts
describe('migration 0054 SQL text (drops 0052\'s column, spec 2026-10-14 §4.2)', () => {
  const MARKER = '--> statement-breakpoint';
  const raw = readFileSync('db/migrations/0054_drop_top_asins_broad_category.sql', 'utf8');
  const chunks = raw.split(MARKER);
  const statements = chunks.map((s) => s.replace(/^\s*--.*$/gm, '').trim()).filter((s) => s.length > 0);

  it('has 2 statements, one per chunk', () => {
    expect(chunks).toHaveLength(2);
    expect(statements).toEqual([
      'ALTER TABLE keyword_top_asins DROP COLUMN IF EXISTS broad_category;',
      'ALTER TABLE IF EXISTS keyword_top_asins_prev DROP COLUMN IF EXISTS broad_category;',
    ]);
  });
  it('the mirror no longer declares the column or its index', () => {
    expect(Object.values(getTableColumns(keywordTopAsins)).map((c) => c.name)).not.toContain('broad_category');
    expect(getTableConfig(keywordTopAsins).indexes.map((i) => i.config.name)).toEqual(['keyword_top_asins_asin_idx']);
  });
  it('says the drop takes the partial index with it and comes after the deploy', () => {
    expect(raw).toContain('drops keyword_top_asins_broad_category_idx');
    expect(raw).toContain('AFTER the deploy');
  });
});
```

- [ ] **Step 2: Run the three test files to see them fail**

Run: `pnpm vitest run lib/topAsins/buildWeek.test.ts lib/topAsins/backfill.test.ts db/schema/keywordTopAsins.test.ts`
Expected: FAIL (the code still carries the column and the renames; 0054 is missing).

- [ ] **Step 3: Change the build, the backfill, the mirror; write 0054**

`lib/topAsins/buildWeek.ts`:
- Delete the header paragraph at lines 11–13 ("Each row also carries `broad_category` … like the asin index."). At line 36 "keeping the _prev table (only PREV_BROAD_GUARD may rename its broad index)" → "keeping the _prev table"; at line 64 "keep the _prev table (only PREV_BROAD_GUARD may rename its broad index);" → "keep the _prev table;".
- `slotSelect`: the second line loses `, top_clicked_category_${slot} AS broad_category`.
- `insertText`: the head's column list ends `week_end_date)`; both bodies lose the `p.broad_category` line (and the comma after `$1::date` in the carry-none body and after `$1::date,` → `$1::date` in the carrying body).
- Delete `BROAD_INDEX` and `PREV_BROAD_GUARD` with their comments (lines 141–155). In `swapStatements`: delete the `ALTER INDEX IF EXISTS ${BROAD_INDEX.next} …` line from `promoteNext`; the same-week branch becomes `return [sql('DROP TABLE keyword_top_asins'), ...promoteNext];`; delete the `sql(PREV_BROAD_GUARD), // on an advance …` line from the advance branch. The function's doc comment loses its two sentences about the broad index and PREV_BROAD_GUARD ("The broad-index renames tolerate …", "except that PREV_BROAD_GUARD moves …" → "same-week rebuild: drops the stale current table and leaves _prev alone;").

`lib/topAsins/backfill.ts`: the INSERT column list ends `week_end_date)`, the `p.broad_category` line goes (fix the trailing comma on `$1::date`); in the swap delete the comment and the two `ALTER INDEX IF EXISTS …` statements (lines 238–239 and 243); the comment "(all nine columns, like a build-made _prev)" → "(all eight columns, like a build-made _prev)" wherever it appears in the file (grep `nine`).

`db/schema/keywordTopAsins.ts`: delete lines 8–10 of the header (the broad_category sentences), the column (lines 23–24), the `broadCategoryIdx` line (29); drop the now-unused `sql` and `varchar` imports.

`db/migrations/0054_drop_top_asins_broad_category.sql`:

```sql
-- db/migrations/0054_drop_top_asins_broad_category.sql
-- 0054 (hand-numbered, applied by the untracked scripts/applyMigration0054.ts on the owner's go;
-- never through drizzle-kit — the journal is frozen). Spec 2026-10-14 (products BA crosswalk) §4.2.
-- RETIRES arc 9's per-row code on the keyword→ASIN pair table: the Keepa-path crosswalk
-- (ba_category_crosswalk, 0053) replaced it. DROP COLUMN drops keyword_top_asins_broad_category_idx
-- (and _prev's copy, whatever name a swap left it under) with the column. Metadata only: instant, a
-- brief exclusive lock readers queue behind for milliseconds.
-- Apply only AFTER the deploy that stops reading the column is green: the readers before it select
-- broad_category and would fail with 42703.

ALTER TABLE keyword_top_asins DROP COLUMN IF EXISTS broad_category;
--> statement-breakpoint
ALTER TABLE IF EXISTS keyword_top_asins_prev DROP COLUMN IF EXISTS broad_category;
```

- [ ] **Step 4: Run the three files, then every unit test, lint, type-check**

Run: `pnpm vitest run lib/topAsins/buildWeek.test.ts lib/topAsins/backfill.test.ts db/schema/keywordTopAsins.test.ts` — Expected: PASS.
Run: `pnpm vitest run` — Expected: PASS (the pair-table mirror lost a column; nothing else may still name it: grep `broad_category` under `lib`, `app`, `db`, `inngest` — only `lib/baCategory`, `lib/products/loadProduct.ts` (the alias `x.code AS broad_category`) and the 0052/0054 migration files may match).
Run: `pnpm exec eslint lib/topAsins/buildWeek.ts lib/topAsins/buildWeek.test.ts lib/topAsins/backfill.ts lib/topAsins/backfill.test.ts db/schema/keywordTopAsins.ts db/schema/keywordTopAsins.test.ts` — Expected: clean.
Run: `pnpm typecheck` — Expected: clean.

- [ ] **Step 5: Adjust the integration build test (not run)**

`tests/integration/topAsinsBuild.test.ts`:
- Header: delete the bullet about the carried broad_category (lines 7–9); in the preconditions (lines 36–37) "migrations 0051 and 0052 applied (the scratch tables copy keyword_top_asins, so the broad_category column and its index must exist)" → "migration 0051 applied (0052's column may or may not still exist: the build no longer names it, and 0054 drops it after the deploy)".
- `generatedNames` loses `broadIndex`; add after it: `const BROAD_COLUMN_SQL = "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'keyword_top_asins' AND column_name = 'broad_category') AS ok";` and a `let hasBroadColumn = false;` beside `currentWeek`.
- In `beforeAll` replace the 0052 check (lines 136–139) with `hasBroadColumn = (await client.query<{ ok: boolean }>(BROAD_COLUMN_SQL)).rows[0]?.ok === true;` and a log line `console.log(\`[topAsinsBuild] 0052's broad_category column ${hasBroadColumn ? 'still exists (0054 not applied yet)' : 'is gone (0054 applied)'}\`);`.
- Delete the carried-code check (from the comment "The code travels from the same kwm row" through `expect(codes.coded, …).toBeGreaterThan(0);`, lines 268–297).
- In the LIKE-names case (lines 351–372): the copy's indexes are `[generated.asinIndex, generated.pkey]` plus, when `hasBroadColumn`, `` `${NAMES_PROBE}_broad_category_asin_idx` `` — build the expected array accordingly and sort it; the live table's indexes contain `keyword_top_asins_pkey` and `keyword_top_asins_asin_idx` (drop the broad name); replace the comment about 0052 with "The live table may still carry 0052's partial index under any name until 0054 runs; the swap never touches it."
- In the advance-swap case (lines 376–391): delete the two `IF EXISTS … broad_category …` expectations and add `expect(swap.some((t) => t.includes('broad_category')), 'no swap statement names the retired column').toBe(false);`.

Run: `pnpm exec eslint tests/integration/topAsinsBuild.test.ts` — Expected: clean. `pnpm typecheck` — Expected: clean. Do NOT run the test.

- [ ] **Step 6: Commit**

```bash
git add lib/topAsins/buildWeek.ts lib/topAsins/buildWeek.test.ts lib/topAsins/backfill.ts lib/topAsins/backfill.test.ts db/schema/keywordTopAsins.ts db/schema/keywordTopAsins.test.ts db/migrations/0054_drop_top_asins_broad_category.sql tests/integration/topAsinsBuild.test.ts
git commit -m "refactor(products): the pair table back to eight columns — no per-row code, no broad-index renames; migration 0054 drops the column after the deploy

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
### Task 8: Integration tests — written here, run by the owner only

**Files:**
- Modify: `tests/integration/productsQueries.test.ts` (header lines 14–26 and 59–62; the imports at line 78; `BROAD_INDEX` at 107–108; `beforeAll` lines 166–169; `codesPresent`/`skipUnlessCodes` at 216–227; `mostCommon`/`largestCode` at 229–251; the end of `broadSearch` at 336–344; the six broad cases from line 474 to the end of the multi-code case)
- Create: `tests/integration/baCrosswalk.test.ts`

Never run these here (`RUN_INTEGRATION` stays unset; they read PRODUCTION). Lint and type-check them. The owner runs them in Task 9 step 3.

- [ ] **Step 1: Rewrite the broad cases of `productsQueries.test.ts`**

1. Header: the bullets at lines 14–26 become

```
 *  - the broad-category filter (spec 2026-10-14 §6): the product's path must be one of the code's paths
 *    in ba_category_crosswalk. Six cases, the cold ones first: the code with the most paths plans on
 *    ba_category_crosswalk_code_idx; the code list statement (BROAD_CATEGORY_LIST_SQL, imported) runs
 *    under a 5 s cold bound and matches a distinct count; loadProduct's facts statement carries the code
 *    of the sampled ASIN's path (checked against an independent lookup); the code with the fewest paths
 *    probes asin_products_category_path_idx and never walks the sold sort index; a code with its
 *    department (Pet Products in Pet Supplies); the code with the most paths per sellable product (the
 *    planner's worst case: many paths, few products) stays under the cap. Every broad search has its rows
 *    and count statements planned (both plans printed), timed apart under a local cap of twice the page's,
 *    re-run with EXPLAIN (ANALYZE, BUFFERS), and every row of its page checked to map to the code;
```

and the precondition bullet at lines 59–62 becomes

```
 *  - migration 0053 applied (checked up front: the file fails at once when ba_category_crosswalk is
 *    missing) and the crosswalk built once (scripts/buildBaCrosswalk.ts, spec 2026-10-14 §13 step 2):
 *    until it holds a row the six broad cases skip with a note ("crosswalk not built");
```

2. Line 78: `import { loadProduct } from '@/lib/products/loadProduct';` (drop `productBroadCategoriesSql`). Lines 107–108 become

```ts
/** The broad-category filter's index (migration 0053): (code, category_path) on the crosswalk; the equality probes ride the category-path index above. */
const CROSSWALK_INDEX = 'ba_category_crosswalk_code_idx';
```

3. `beforeAll` lines 166–169 become

```ts
    const crosswalk = await client.query<{ ok: boolean }>("SELECT to_regclass('ba_category_crosswalk') IS NOT NULL AS ok");
    if (!crosswalk.rows[0]?.ok) throw new Error('migration 0053 is not applied (ba_category_crosswalk is missing)');
```

4. Lines 216–227 become

```ts
  /** The crosswalk is filled by its first build (spec 2026-10-14 §13 step 2); before it, the broad cases skip. */
  async function codesPresent(): Promise<boolean> {
    const r = await client.query('SELECT 1 FROM ba_category_crosswalk LIMIT 1');
    return (r.rowCount ?? 0) > 0;
  }

  /** The start of every broad case: skip it, with a note, until the crosswalk is built (ctx.skip throws, so nothing after it runs). */
  async function skipUnlessCodes(ctx: TestContext): Promise<void> {
    if (await codesPresent()) return;
    console.log('[productsQueries] crosswalk not built yet: skipped');
    ctx.skip('crosswalk not built');
  }
```

5. Replace `mostCommon` and `largestCode` (lines 229–251) with

```ts
  /**
   * The code with the most paths: the planner's first most-common value of ba_category_crosswalk.code (pg_stats; the build
   * analyzes the table), else a count over the 24k-row table. Neither touches the catalog, so the search timed next is not
   * warmed by the pick.
   */
  async function largestCode(): Promise<string> {
    const stat = await client.query<{ v: string | null }>(
      "SELECT (most_common_vals::text::text[])[1] AS v FROM pg_stats WHERE schemaname = current_schema() AND tablename = 'ba_category_crosswalk' AND attname = 'code'",
    );
    if (stat.rows[0]?.v) return stat.rows[0].v;
    const counted = await client.query<{ code: string }>('SELECT code FROM ba_category_crosswalk GROUP BY 1 ORDER BY count(*) DESC, 1 LIMIT 1');
    return counted.rows[0].code;
  }

  /** Sellable products of a code (a join over the catalog: run only AFTER a timed read, it warms the pages). */
  async function productsOf(code: string): Promise<number> {
    const r = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM asin_products a JOIN ba_category_crosswalk x ON x.category_path = a.category_path
       WHERE x.code = $1 AND a.in_scope AND a.enrichment_status IN ('active', 'no_price')`,
      [code],
    );
    return r.rows[0].n;
  }
```

6. `broadSearch` takes a third parameter `scope: ProductCategoryScope = EMPTY_CATEGORY_SCOPE` and passes it to both `productSearchSql` and `searchProducts` calls; its final check (lines 336–344) becomes

```ts
    const without = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM unnest($1::text[]) r(asin) JOIN asin_products a ON a.asin = r.asin
       LEFT JOIN ba_category_crosswalk x ON x.category_path = a.category_path WHERE x.code IS DISTINCT FROM $2`,
      [result.rows.map((r) => r.asin), code],
    );
    expect(without.rows[0].n, `rows of the "${code}" page whose path does not map to the code`).toBe(0);
```

(the two timing expectations after it stay). Its doc comment's "every row of the page is checked to have a pair row carrying the code" → "every row of the page is checked to map to the code".

7. Replace the six cases (from `it('the largest broad category under the default sort …'` at line 474 through the end of the multi-code case, inclusive) with:

```ts
  it(
    'the code with the most paths under the default sort plans on the crosswalk index and every row maps to the code',
    async (ctx) => {
      await inReadOnlyTransaction(async () => {
        await skipUnlessCodes(ctx);
        const code = await largestCode();
        const { lines, rows } = await broadSearch(code);
        // Counted only after the timed read, so the join did not warm it.
        console.log(`[productsQueries] code with the most paths "${code}": ${await productsOf(code)} sellable products`);
        expect(lines.join('\n'), `the plan of the "${code}" search`).toContain(CROSSWALK_INDEX);
        expect(rows.length, `rows on the "${code}" page`).toBeGreaterThanOrEqual(1);
        expect(rows.length, `rows on the "${code}" page`).toBeLessThanOrEqual(PRODUCT_PAGE_SIZE);
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'the code list statement runs inside the 5 s cold bound and lists every distinct code',
    async (ctx) => {
      await inReadOnlyTransaction(async () => {
        await skipUnlessCodes(ctx);
        const started = performance.now();
        const listed = await client.query<{ code: string }>(BROAD_CATEGORY_LIST_SQL);
        const seconds = (performance.now() - started) / 1000;
        console.log(`[productsQueries] broad category list: ${listed.rows.length} codes in ${seconds.toFixed(2)}s (the cold bound is 5s)`);
        const distinct = await client.query<{ n: number }>('SELECT count(DISTINCT code)::int AS n FROM ba_category_crosswalk');
        expect(listed.rows.length, 'codes the list statement returns, against the distinct codes on the table').toBe(distinct.rows[0].n);
        expect(seconds, 'the code list statement (the cold bound)').toBeLessThan(5);
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "loadProduct carries the code of the sampled ASIN's path, as an independent lookup of the crosswalk gives it",
    async (ctx) => {
      await inReadOnlyTransaction(async () => {
        await skipUnlessCodes(ctx);
        const { asin, from } = await sampleAsin();
        await client.query(`SET LOCAL statement_timeout = '${SEARCH_TIMEOUT}'`);
        const started = performance.now();
        const facts = await loadProduct(run, asin);
        const seconds = (performance.now() - started) / 1000;
        await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);
        const expected = await client.query<{ code: string | null }>(
          'SELECT x.code FROM asin_products a LEFT JOIN ba_category_crosswalk x ON x.category_path = a.category_path WHERE a.asin = $1',
          [asin],
        );
        console.log(`[productsQueries] ${asin} (${from}): path ${facts?.categoryPath ?? 'none'} → broadCategory ${facts?.broadCategory ?? 'null'} in ${seconds.toFixed(3)}s`);
        expect(facts, `facts of ${asin}`).not.toBeNull();
        expect(facts?.broadCategory ?? null, `the code of ${asin}`).toBe(expected.rows[0]?.code ?? null);
        expect(seconds, `the facts read of ${asin}`).toBeLessThan(PRODUCT_READ_TIMEOUT_MS / 1000);
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "the code with the fewest paths probes the category-path index and never walks the sold sort index",
    async (ctx) => {
      await inReadOnlyTransaction(async () => {
        await skipUnlessCodes(ctx);
        const picked = await client.query<{ code: string; paths: number }>('SELECT code, count(*)::int AS paths FROM ba_category_crosswalk GROUP BY 1 ORDER BY 2, 1 LIMIT 1');
        const { code, paths } = picked.rows[0];
        console.log(`[productsQueries] code with the fewest paths: "${code}", ${paths} path(s)`);
        const { lines, rows } = await broadSearch(code);
        const plan = lines.join('\n');
        expect(plan, `the plan of the "${code}" search`).toContain(CATEGORY_PATH_INDEX);
        expect(plan, `the plan of the "${code}" search must not walk the sold sort index`).not.toContain('asin_products_monthly_sold_idx');
        const products = await productsOf(code);
        console.log(`[productsQueries] "${code}": ${products} sellable products`);
        expect(rows.length, `rows on the page of "${code}"`).toBeLessThanOrEqual(Math.max(products, 0));
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'a code with its department (Pet Products in Pet Supplies) stays under the cap and returns rows',
    async (ctx) => {
      await inReadOnlyTransaction(async () => {
        await skipUnlessCodes(ctx);
        const present = await client.query<{ ok: boolean }>(
          "SELECT EXISTS (SELECT 1 FROM ba_category_crosswalk WHERE code = 'Pet Products' AND category_path LIKE 'Pet Supplies › %') AS ok",
        );
        if (!present.rows[0]?.ok) {
          console.log('[productsQueries] no Pet Supplies path maps to Pet Products: the department case is skipped.');
          return ctx.skip('no Pet Products path under Pet Supplies');
        }
        const scope: ProductCategoryScope = { dept: 'Pet Supplies', subtreePaths: [], exactPaths: [], scoped: false };
        const { rows } = await broadSearch('Pet Products', 'with the Pet Supplies department', scope);
        console.log(`[productsQueries] Pet Products in Pet Supplies: ${rows.length} rows on the page`);
        expect(rows.length).toBeGreaterThanOrEqual(1);
        for (const r of rows) expect(r.categoryPath?.startsWith('Pet Supplies'), `department of ${r.asin}`).toBe(true);
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "the code with the most paths per sellable product (many paths, few products) stays under the page's cap",
    async (ctx) => {
      await inReadOnlyTransaction(async () => {
        await skipUnlessCodes(ctx);
        // The planner's worst case: the semi-join's estimate rests on the code's path count, so a code with many paths and few
        // products may be planned like a large one. The pick joins the catalog (warm pages), so the times printed are warm ones.
        await client.query("SET LOCAL work_mem = '256MB'");
        const picked = await client.query<{ code: string; paths: number; products: number }>(
          `SELECT x.code, count(DISTINCT x.category_path)::int AS paths, count(a.asin)::int AS products
           FROM ba_category_crosswalk x
           LEFT JOIN asin_products a ON a.category_path = x.category_path AND a.in_scope AND a.enrichment_status IN ('active', 'no_price') AND a.monthly_sold IS NOT NULL
           GROUP BY 1 HAVING count(DISTINCT x.category_path) >= 50
           ORDER BY count(a.asin)::float / count(DISTINCT x.category_path) ASC, count(DISTINCT x.category_path) DESC LIMIT 1`,
        );
        await client.query('SET LOCAL work_mem TO DEFAULT');
        const worst = picked.rows[0];
        if (!worst) {
          console.log('[productsQueries] no code has 50 paths: the many-paths case is skipped.');
          return ctx.skip('no code with 50 paths');
        }
        console.log(`[productsQueries] most paths per product: "${worst.code}", ${worst.paths} paths, ${worst.products} sellable products with the badge`);
        const { rows } = await broadSearch(worst.code, 'warm (the pick read the same pages)');
        console.log(`[productsQueries] "${worst.code}": the page holds ${rows.length} rows`);
      });
    },
    TEST_TIMEOUT_MS,
  );
```

(`ProductCategoryScope` is already imported for `EMPTY_CATEGORY_SCOPE`'s type, or import it from `@/lib/products/categoryPredicate`; `ProductSummaryRow` has `categoryPath`.)

- [ ] **Step 2: Write `tests/integration/baCrosswalk.test.ts`**

```ts
// tests/integration/baCrosswalk.test.ts
/**
 * computeCrosswalk (lib/baCategory/buildCrosswalk.ts) against production, READ-ONLY (spec 2026-10-14 §12):
 * the votes statement and the paths statement run for the Explorer week inside BEGIN READ ONLY …
 * ROLLBACK (writeCrosswalk is never called; the real table is never written), then the assignment is
 * checked for shape, coverage and two known paths, and the two statements are planned.
 *
 * Run on the owner's go only, never in CI:
 *   RUN_INTEGRATION=1 pnpm vitest run tests/integration/baCrosswalk.test.ts --disableConsoleIntercept
 * Preconditions: migration 0053 applied (the table may be empty: only kwm and the catalog are read);
 * the Explorer week imported; prefer a quiet hour (the votes read aggregates the week's slot-1 rows of
 * the kwm partition: minutes cold; this test records the first timing).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { CATALOG_PATHS_SQL, computeCrosswalk, votesSql } from '@/lib/baCategory/buildCrosswalk';
import { MIN_VOTES, prefixesOf } from '@/lib/baCategory/assignCodes';

const RUN = !!process.env.RUN_INTEGRATION;
const TEST_TIMEOUT_MS = 10 * 60_000;
const HOOK_TIMEOUT_MS = 2 * 60_000;
const TOILET_PAPER = 'Health & Household › Household Supplies › Tissues, Toilet Paper & Sprays › Toilet Paper';

describe.skipIf(!RUN)('BA crosswalk compute (integration, read-only)', () => {
  let pool: Pool;
  let client: PoolClient;
  let week: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, keepAlive: true, keepAliveInitialDelayMillis: 10_000, connectionTimeoutMillis: 60_000 });
    pool.on('error', () => undefined);
    client = await pool.connect();
    client.on('error', () => undefined);
    const table = await client.query<{ ok: boolean }>("SELECT to_regclass('ba_category_crosswalk') IS NOT NULL AS ok");
    if (!table.rows[0]?.ok) throw new Error('migration 0053 is not applied (ba_category_crosswalk is missing)');
    const kcs = await client.query<{ week: string }>('SELECT current_week_end_date::text AS week FROM keyword_current_summary_meta WHERE singleton');
    if (!kcs.rows[0]) throw new Error('keyword_current_summary_meta has no row: the explorer week is unknown');
    week = kcs.rows[0].week;
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    try {
      await client?.query('ROLLBACK').catch(() => undefined);
    } finally {
      client?.release();
      await pool?.end();
    }
  }, HOOK_TIMEOUT_MS);

  /** BEGIN READ ONLY … ROLLBACK around `fn`: a write would error, and nothing persists either way. */
  async function inReadOnlyTransaction(fn: () => Promise<void>): Promise<void> {
    await client.query('BEGIN READ ONLY');
    try {
      await client.query("SET LOCAL statement_timeout = '300s'");
      await client.query("SET LOCAL client_connection_check_interval = '10s'");
      await client.query("SET LOCAL work_mem = '256MB'");
      await fn();
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
    }
  }

  it(
    'computes the Explorer week: each catalog path at most once, sources are the path or an ancestor, shares in range, coverage, the two known paths',
    async () => {
      // computeCrosswalk opens its own REPEATABLE READ READ ONLY transaction with its SET LOCAL limits, so it runs outside the wrapper.
      const started = performance.now();
      const { rows, stats } = await computeCrosswalk(client, week);
      const seconds = (performance.now() - started) / 1000;
      console.log(`[baCrosswalk] week ${week}: ${JSON.stringify(stats)} in ${seconds.toFixed(1)}s (the first timing of the kwm form)`);
      await inReadOnlyTransaction(async () => {
        expect(stats.paths, 'paths').toBe(rows.length);
        expect(stats.direct + stats.backedOff, 'direct + backedOff').toBe(stats.paths);
        expect(new Set(rows.map((r) => r.categoryPath)).size, 'distinct paths').toBe(rows.length);
        for (const r of rows) {
          expect(prefixesOf(r.categoryPath), `source of ${r.categoryPath}`).toContain(r.sourcePath);
          expect(r.sharePct, `share of ${r.categoryPath}`).toBeGreaterThanOrEqual(0);
          expect(r.sharePct, `share of ${r.categoryPath}`).toBeLessThanOrEqual(100);
          expect(r.votes, `votes of ${r.categoryPath}`).toBeGreaterThanOrEqual(1);
          // A path that decided itself below the department level had the threshold.
          if (r.sourcePath === r.categoryPath && prefixesOf(r.categoryPath).length > 1) expect(r.votes, `votes of ${r.categoryPath}`).toBeGreaterThanOrEqual(MIN_VOTES);
        }
        // Coverage weighted by the products the page can show (spec §2: 86 % decided by their own path, under 1 % without a code).
        const weights = await client.query<{ category_path: string; n: number }>(
          "SELECT category_path, count(*)::int AS n FROM asin_products WHERE in_scope AND enrichment_status IN ('active', 'no_price') AND category_path IS NOT NULL GROUP BY 1",
        );
        const byPath = new Map(rows.map((r) => [r.categoryPath, r] as const));
        let total = 0;
        let direct = 0;
        let uncoded = 0;
        for (const w of weights.rows) {
          total += w.n;
          const r = byPath.get(w.category_path);
          if (!r) uncoded += w.n;
          else if (r.sourcePath === r.categoryPath) direct += w.n;
        }
        console.log(`[baCrosswalk] sellable products with a path: ${total}; decided by their own path ${((100 * direct) / total).toFixed(1)}%; without a code ${((100 * uncoded) / total).toFixed(2)}%`);
        expect(direct / total, 'share of sellable products decided by their own path').toBeGreaterThanOrEqual(0.8);
        expect(uncoded / total, 'share of sellable products without a code').toBeLessThan(0.01);
        // Two known paths (spec §2).
        const toilet = byPath.get(TOILET_PAPER);
        console.log(`[baCrosswalk] toilet paper: ${JSON.stringify(toilet)}`);
        expect(toilet?.code, 'the toilet paper path').toBe('Health & Personal Care');
        const pet = rows.filter((r) => r.categoryPath === 'Pet Supplies' || r.categoryPath.startsWith('Pet Supplies › '));
        const petProducts = pet.filter((r) => r.code === 'Pet Products').length;
        console.log(`[baCrosswalk] Pet Supplies: ${petProducts} of ${pet.length} paths map to Pet Products`);
        expect(pet.length, 'Pet Supplies paths').toBeGreaterThan(0);
        expect(petProducts / pet.length, 'Pet Supplies paths mapped to Pet Products').toBeGreaterThanOrEqual(0.8);
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'the two statements plan on the partition and the catalog (plans printed, not executed)',
    async () => {
      await inReadOnlyTransaction(async () => {
        const votes = votesSql(week);
        const votesPlan = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN (FORMAT TEXT) ${votes.text}`, votes.values);
        const votesLines = votesPlan.rows.map((r) => r['QUERY PLAN']);
        console.log(`[baCrosswalk] votes plan:\n${votesLines.slice(0, 16).join('\n')}`);
        expect(votesLines.join('\n')).toContain(`keyword_weekly_metrics_${week.slice(0, 4)}`);
        expect(votesLines.join('\n')).toContain('asin_products');
        const pathsPlan = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN (FORMAT TEXT) ${CATALOG_PATHS_SQL}`);
        const pathsLines = pathsPlan.rows.map((r) => r['QUERY PLAN']);
        console.log(`[baCrosswalk] paths plan:\n${pathsLines.slice(0, 8).join('\n')}`);
        expect(pathsLines.join('\n')).toContain('asin_products');
      });
    },
    TEST_TIMEOUT_MS,
  );
});
```

- [ ] **Step 3: Lint and type-check (never run)**

Run: `pnpm exec eslint tests/integration/productsQueries.test.ts tests/integration/baCrosswalk.test.ts` — Expected: clean.
Run: `pnpm typecheck` — Expected: clean.
Run: `pnpm vitest run tests/integration/productsQueries.test.ts tests/integration/baCrosswalk.test.ts` — Expected: both files report every test skipped (`RUN_INTEGRATION` unset; vitest may exit 1 with "No test files found" when nothing runs: that is the gate working, not a failure).

- [ ] **Step 4: Commit**

```bash
git add tests/integration/productsQueries.test.ts tests/integration/baCrosswalk.test.ts
git commit -m "test(integration): the broad cases read the crosswalk; computeCrosswalk checked read-only against production

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Ship (owner-gated, each step on the owner's explicit go)

Not a subagent task: the controller runs it with the owner, in this order (spec §13). Two untracked apply scripts are written at step 1 and step 6 with the content below (never committed). Record every step in the Results table at the end of this task.

- [ ] **Step 1: Apply 0053 (before anything deploys)**

`node --env-file=.env.local --import tsx scripts/checkActiveJobs.ts` (quiet: 0 runs, 0 imports mid-phase), then write the untracked `scripts/applyMigration0053.ts`:

```ts
// scripts/applyMigration0053.ts (UNTRACKED — run only on the owner's go)
/**
 * Applies db/migrations/0053_ba_category_crosswalk.sql in one short transaction: the table is new and
 * empty, so a plain CREATE INDEX is instant (no CONCURRENTLY needed). Idempotent (IF NOT EXISTS).
 * Run: APPLY_0053=yes node --env-file=.env.local --import tsx scripts/applyMigration0053.ts
 * Expect: "3 statements", three "ok:" lines, "committed", "assertions passed".
 */
import { readFileSync } from 'node:fs';
import { Client } from 'pg';

if (process.env.APPLY_0053 !== 'yes') { console.error('Refusing to run: set APPLY_0053=yes'); process.exit(1); }
if (!process.env.DATABASE_URL) { console.error('Refusing to run: DATABASE_URL is not set'); process.exit(1); }
const code = (e: unknown) => (e as { code?: string })?.code ?? (e instanceof Error ? e.name : 'unknown');

(async () => {
  const sqlText = readFileSync('db/migrations/0053_ba_category_crosswalk.sql', 'utf8');
  const statements = sqlText.split(/-->\s*statement-breakpoint/).map((s) => s.replace(/^\s*--.*$/gm, '').trim().replace(/;\s*$/, '')).filter((s) => s.length > 0);
  if (statements.length !== 3) throw new Error(`split_mismatch: ${statements.length} statements`);
  console.log(`Applying 0053_ba_category_crosswalk.sql (${statements.length} statements)`);
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
    throw e;
  }
  try {
    const cols = await c.query<{ n: number }>("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'ba_category_crosswalk'");
    const idx = await c.query<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE tablename = 'ba_category_crosswalk' ORDER BY 1");
    const names = idx.rows.map((r) => r.indexname);
    if (cols.rows[0].n !== 7) throw new Error(`column_count: ${cols.rows[0].n}`);
    if (!names.includes('ba_category_crosswalk_code_idx') || !names.includes('ba_category_crosswalk_pkey')) throw new Error(`indexes: ${names.join(',')}`);
    const rows = await c.query<{ n: number }>('SELECT count(*)::int AS n FROM ba_category_crosswalk');
    console.log(`assertions passed (7 columns; indexes ${names.join(', ')}; ${rows.rows[0].n} rows)`);
  } finally {
    await c.end();
  }
})().catch((e) => { console.error('failed:', code(e)); process.exit(1); });
```

Run: `APPLY_0053=yes node --env-file=.env.local --import tsx scripts/applyMigration0053.ts`. The live site is untouched (nothing reads the table yet).

- [ ] **Step 2: The one-off first build, with the local code**

`BA_CROSSWALK_WEEK=2026-10-10 node --env-file=.env.local --import tsx scripts/buildBaCrosswalk.ts` (use the Explorer week at the time; minutes, the first timing of the kwm form). Note the stats line, the time and the eight largest codes in the Results table. Spot-check from a read-only query that `Health & Household › Household Supplies › Tissues, Toilet Paper & Sprays › Toilet Paper` maps to `Health & Personal Care` and that `share_pct < 70` lists the mixed paths (spec §5.2).

- [ ] **Step 3: Integration, on the owner's go**

`RUN_INTEGRATION=1 pnpm vitest run tests/integration/productsQueries.test.ts --disableConsoleIntercept -t "mismatched department"` first for the coldest index reading, then the whole file (read the printed plans: the largest code must plan on `ba_category_crosswalk_code_idx`, the smallest on `asin_products_category_path_idx`; every statement under 30 s; step 2's build has warmed the catalog heap by then, so the risky cases are judged by the printed EXPLAIN ANALYZE blocks hit + read and the sort-index node's rows, not by the clock; recalibrate the 400,000-access bound from the printed numbers if it trips), then `RUN_INTEGRATION=1 pnpm vitest run tests/integration/baCrosswalk.test.ts --disableConsoleIntercept` (the compute case re-runs the votes read: minutes; its timeout is 31 minutes, and a cancelled run leaves nothing behind, it is read-only), then `RUN_INTEGRATION=1 pnpm vitest run tests/integration/topAsinsBuild.test.ts --disableConsoleIntercept` (the pair-table build with eight columns against the live schema, 0052's column still present). A slow cold case is a spec follow-up (§6's `= ANY(paths)` fallback), not a blocker, if the other cases are fast.

- [ ] **Step 4: Push and deploys**

`node --env-file=.env.local --import tsx scripts/checkActiveJobs.ts` → bare `git push origin main` (its own Bash call) → watch with `gh api repos/raw5045/AmazonAnalytics/commits/<sha>/status --jq '"overall: \(.state)", (.statuses[] | "\(.context): \(.state) @ \(.updated_at)")'` until `Vercel`, `amazon-analytics-worker - AmazonAnalytics` and `amazon-analytics-worker - keepa-importer` are success (Vercel may need an empty-commit re-trigger on the owner's go).

- [ ] **Step 5: Smoke (the owner signed in as admin; Claude drives the built-in browser for the page part on the owner's go)**

Page: `/products?broad=Pet+Products` (pet products on top; the select shows the codes, the new hint); `Pet Products` + the department `Pet Supplies`; a code + a leaf pick; `?broad=Nope` → "Nope" selected, zero rows; the ASIN page of B0FFPF97RV shows "Broad category: Health & Personal Care"; B0GHMZXX8Y shows "Beauty"; Reset; the Explorer unchanged. Tools (the owner, in a fresh Claude chat): a `broadCategory` search; a typo returns the codes; `get_product_details` shows one `broadCategory`; one Ask AI question using the filter. The code list is cached an hour: a code list that still looks old within an hour of step 2 is the cache, not a bug.

- [ ] **Step 6: Apply 0054 (only after step 4's three deploys are green; no import and no backfill run in flight; a rollback to the arc-9 code afterwards needs 0052 re-applied first)**

Write the untracked `scripts/applyMigration0054.ts`:

```ts
// scripts/applyMigration0054.ts (UNTRACKED — run only on the owner's go, AFTER the deploy that stops reading the column is green)
/**
 * Applies db/migrations/0054_drop_top_asins_broad_category.sql: two DROP COLUMN IF EXISTS in one short
 * transaction under a 5 s lock_timeout, retried up to ten times (a page read or a build holding the
 * pair table makes it wait). DROP COLUMN takes the partial index with it. Idempotent.
 * Run: APPLY_0054=yes node --env-file=.env.local --import tsx scripts/applyMigration0054.ts
 * Expect: "2 statements", two "ok:" lines, "committed", "assertions passed".
 */
import { readFileSync } from 'node:fs';
import { Client } from 'pg';

if (process.env.APPLY_0054 !== 'yes') { console.error('Refusing to run: set APPLY_0054=yes'); process.exit(1); }
if (!process.env.DATABASE_URL) { console.error('Refusing to run: DATABASE_URL is not set'); process.exit(1); }
const code = (e: unknown) => (e as { code?: string })?.code ?? (e instanceof Error ? e.name : 'unknown');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const sqlText = readFileSync('db/migrations/0054_drop_top_asins_broad_category.sql', 'utf8');
  const statements = sqlText.split(/-->\s*statement-breakpoint/).map((s) => s.replace(/^\s*--.*$/gm, '').trim().replace(/;\s*$/, '')).filter((s) => s.length > 0);
  if (statements.length !== 2) throw new Error(`split_mismatch: ${statements.length} statements`);
  console.log(`Applying 0054_drop_top_asins_broad_category.sql (${statements.length} statements)`);
  const c = new Client({ connectionString: process.env.DATABASE_URL, statement_timeout: 120_000 });
  c.on('error', () => undefined);
  await c.connect();
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        await c.query('BEGIN');
        await c.query("SET LOCAL lock_timeout = '5s'");
        for (const s of statements) { await c.query(s); console.log(`ok: ${s}`); }
        await c.query('COMMIT');
        console.log('committed');
        break;
      } catch (e) {
        await c.query('ROLLBACK').catch(() => undefined);
        if (code(e) !== '55P03' || attempt >= 10) throw e;
        console.log(`lock busy (attempt ${attempt}), retrying in 10 s`);
        await sleep(10_000);
      }
    }
    const left = await c.query<{ table_name: string }>("SELECT table_name FROM information_schema.columns WHERE column_name = 'broad_category' AND table_name IN ('keyword_top_asins', 'keyword_top_asins_prev')");
    if (left.rows.length > 0) throw new Error(`column_left: ${left.rows.map((r) => r.table_name).join(',')}`);
    const idx = await c.query<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE indexname LIKE '%broad_category%'");
    if (idx.rows.length > 0) throw new Error(`index_left: ${idx.rows.map((r) => r.indexname).join(',')}`);
    console.log('assertions passed (no broad_category column or index on the pair tables)');
  } finally {
    await c.end();
  }
})().catch((e) => { console.error('failed:', code(e)); process.exit(1); });
```

Run: `APPLY_0054=yes node --env-file=.env.local --import tsx scripts/applyMigration0054.ts`.

- [ ] **Step 7: Results, docs, memory**

Fill the Results table below (one docs commit per step is fine), update the arc memory, and at the next import (week ending 2026-10-17, run 2026-10-20) check `import_phase_timings` for `ba_crosswalk_build` and that `SELECT max(week_end_date) FROM ba_category_crosswalk` advanced.

#### Results

| Step | Date | Outcome | Notes |
|---|---|---|---|
| 0053 applied | | | |
| One-off build | | | |
| Integration (products) | | | |
| Integration (crosswalk) | | | |
| Integration (pair-table build) | | | |
| Push + deploys | | | |
| Page smoke | | | |
| Tools smoke | | | |
| 0054 applied | | | |
| First import with the phase | | | |

---

## Landed shape (deviations from the task texts above; the code is the reference)

- **Task 1:** the nits round (d0fc508) replaced the test's substring DDL pins with a whitespace-collapsed exact match of the CREATE TABLE and an exact index statement, pinned every mirror column's `[type, notNull, hasDefault]`, and reworded the migration header/COMMENT and the mirror JSDoc to "at most one row per path in the catalog (none for a path newer than the last build, or whose department has no votes)" and "once by hand through scripts/buildBaCrosswalk.ts"; the Task 1 blocks above show the pre-nits text.
- **Task 2:** the plan's test "a department under the threshold still decides…" listed the two rows in the wrong order (the module sorts catalog paths, so `Pet Supplies › Cats` comes before `Pet Supplies › Dogs › Toys`); the implementer fixed the test's expectation, not the module, and the block above now shows the corrected order. The spec review's mutation run queued three test-strength items for the nits round (a tie checked in both insertion orders, the `products > 0` guard exercised where it counts, the purity test fed unsorted paths). The nits round (65f9e52) then changed the rule on the quality review's observation: a path's own products decide first when they reach `MIN_VOTES`, the subtree walk only backs it off (spec §5.2 amendment); the `minVotes` parameter was dropped; tests added for sibling sums at the parent, order-independence with a tie, the vote guard (incl. NaN), half rounding, and two own-first cases; the Task 2 blocks above show the pre-nits module.
- **Task 3:** Step 4 said 13 tests; the file has 14. With `BA_CROSSWALK_WEEK` unset the script defaults to the Explorer week, which during and right after an import is still the previous week (the phase runs before the summary refresh), so Task 9's one-off and any by-hand run pass the week explicitly. Reviews: the votes read's "31–40 s" was measured on the pair table's slot-1 rows, not the kwm partition the SQL reads (expect tens of seconds warm, minutes cold; Task 9 records the real time); the write chunks the INSERT by `WRITE_CHUNK` (10,000) inside the one transaction; `CrosswalkStats` has no `secs`; the script uses `Pool({ max: 1 })` + `connect()` like `buildTopAsinsWeek.ts`. The nits round (the reviews of Tasks 3 and 4): both reads in one REPEATABLE READ READ ONLY transaction with `SET LOCAL statement_timeout = '1800s'` (the pool option does not bind through Neon's pooler); the write takes `LOCK TABLE … IN SHARE ROW EXCLUSIVE MODE`, refuses an older week (`ba_crosswalk_older_than_built`, same week allowed) under the lock, DELETEs and re-inserts (readers never wait, never see an empty table) under its own `SET LOCAL` limits (1800 s / 120 s), then `VACUUM (ANALYZE)` best-effort; `COLLATE "C"` on the mode's tie-break; `assertDedicated` in both steps; the script keeps the pool option (non-binding, as the siblings), prints the missing-meta and older-week hints, survives a failed top-codes summary, and its header warns about the lagging default week and an in-flight import; 21 tests. Later touches: a failing ROLLBACK on the read path pinned (22 tests); the header points at the admin status chip instead of an untracked script; `VACUUM (ANALYZE, TRUNCATE false)` so the vacuum never takes a page-trim lock (c0d8cd1).
- **Task 4:** beyond the task text the implementer extended two older connect-failure chains with the fourth client (otherwise the new phase's connect returned `undefined` and failed soft inside those tests), gave the new describe the sibling's `mockEnqueueWeek` default, and updated the two pool-count comments. Queued for its nits round: a test pinning the crosswalk pool's options like the sibling's, and a human label for `ba_crosswalk_build` in `app/admin/ImportStatusChip.tsx` (`humanPhase()` fell back to the raw name). The reviews decided the older-week question: the phase gets the siblings' expected-skip branch for `ba_crosswalk_older_than_built` (nits round), so a gap-fill or replacement import of an older week never regresses the live crosswalk. The nits round (31615c9, aad0e57) added the skip branch and its test, the other-code failure test, the pool-shape pin, a `POOLS` constant for the count sites, a `warn` spy in `spyConsole`, the 'Broad categories' label in `app/admin/ImportStatusChip.tsx` and its test row, and prettier on the test file with `--end-of-line auto` (the plain form would convert the file to LF).
- **Task 6:** the plan's file list missed `tests/integration/productsQueries.test.ts` (`pnpm typecheck` covers tests): the follow-up d5b633d dropped its `productBroadCategoriesSql` import and the two cases Task 8 rewrites (anchors after the old line 515 shifted by up to 69 lines; its header bullet runs to line 35, not 26). Also: `catalog.test.ts`'s version pins sit at lines 229 and 231; the products.test message echoes `Pets` (the code that test passes); `tools.test.ts:82` pinned the old search phrase too; `loadProduct.test.ts` lost `CODES_TEXT` and its call counts followed; `catalog.ts:16`'s version history gained "; 6: …"; stale prose fixed in `loadProduct.ts`'s header, `products.ts:39/:115`, `products.test.ts`, the `page.tsx`/`StreamedProductSections.tsx` headers; the Task 5 review's additions (`page.test.tsx` fixtures, `filterParams.ts:21/:40`) landed here. The nits rounds (124dcff, 0bf4d3d) reworded the guide rule and the filter description for a model reader (the valid-codes clause, "on products it is the product's own category", "top-3 clicked product for", the null case naming the product, "the Brand Analytics report" once), reordered the two inCatalog-false texts, fixed the example codes ('Pet Products', not a Keepa department) and the arc-9 citations, kept the code on the never-fetched card fixture on purpose with null assertions, gave the facts join its own test, pinned a delisted row keeping its code, and added negative pins against the retired multi-code wording. The crosswalk learns from category #1 only, so the product code list is a subset of the Explorer's (~102): record the real `codes=` at the first build.
- **Task 7:** the nits round (d253269) made `buildWeek.ts`, `backfill.ts` and `keywordTopAsins.ts` byte-identical to arc 7 (cca065f); 0054's header now names the old build's INSERT as a writer (fail-soft in the forbidden window), the lock wait behind an in-flight reader or build (the apply script's 5 s retries), "AFTER the deploy is green on web and worker" and the rollback rule (0052 re-applied first); the integration test's `generatedNames` is arc 7's one-liner; the slot pin is a regex; the backfill test asserts the two renames exactly.
- **Task 8 (brief additions):** two more product cases — a mismatched department (Pet Products in Tools & Home Improvement: the planner multiplies the two selectivities as if independent and may walk a sort index across the catalog) and the code with the MOST products per path among codes with 50+ paths (few large paths: a path-driven plan reads all their products before sorting), beside the existing fewest-products-per-path case; the `= ANY(paths)` fallback (intersected with the department's paths in TypeScript) if any cold case passes 30 s. Landed (b42851d): eight product cases (most paths; the code list; the facts join; fewest paths; Pet Products in Pet Supplies; most paths per sellable product; Pet Products in Tools & Home Improvement; most products per path), `broadSearch` with a scope parameter and a crosswalk-based row check, `mostCommon` gone, no pair-table wording left; `baCrosswalk.test.ts` calls `computeCrosswalk` outside the read-only wrapper. The review rounds (5f8f6cf, 602c140) then moved the whole broad block to right after the owner's-search case (the department and leaf cases' picks scan the catalog), ordered it cold-first (most paths; the code list; the facts join; fewest paths; the mismatched department; Pet Products in Pet Supplies; the code with a leaf pick; most paths per sellable product; most products per path), added the code-with-leaf case §12 asked for (the plan had dropped it; the matched-department cases for the largest and smallest codes stay dropped, the mismatched one being the risky shape), checked departments through the path index, moved the largest code's product count after the cold cases, and gave the crosswalk test its run-order and cancellation warnings and a product-weighted Pet Supplies share. The quality round (22433f5, 79790cf) then: the compute case's test timeout sits above the server's own 1800 s limit (31 min); the EXPLAIN case runs first and prints whole plans; the mismatched-department case carries a cache-independent verdict (the EXPLAIN ANALYZE re-run's buffer accesses, hit + read, under 400,000: measured 2026-10-14, a sold-index walk across the catalog costs 780,000+ accesses, a department-driven plan over Tools & Home Improvement's 63,590 rows about 65,000–130,000), because in the documented run every broad case follows step 2's build, whose catalog read warms the heap; the matched-department case for the code with the most paths is back (the department picked from the crosswalk alone), reversing the plan's drop of it, since the planner's independence assumption makes it the other risky shape; the code-list case sits above the most-paths case; the leaf case is labelled warm; a vacuous facts-join pass (path present, unmapped) is logged; the sample reuses the owner's-search row; the compute case logs the mixed paths (`sharePct < 70`) and their product weight for §14's override decision. Ten broad cases, 22 + 2 in the two files.
- **Task 5:** beyond the task text two stale comments in `listCategories.ts` were corrected ("or crosswalk"; the ORDER BY sentence); `keywordTopAsins` stays imported in `searchProducts.test.ts` (the keyword-count lateral still reads the pair table). `lib/products/filterParams.ts` lines 21 and 40 still describe the per-row code: Task 6 fixes those two comments. The nits round (b77ab71) rewrote the search header (the crosswalk index is a plain index), named both plan shapes in the predicate's comment, pinned the `x` alias's columns from the statement text (a `x.cod` typo now fails nine tests), and reworded the list comments for the DELETE rebuild.

## Self-review (done while writing)

**Spec coverage.** §1–§3 (the design) → Tasks 2, 3, 5, 6. §4.1 → Task 1; §4.2 → Task 7 (the file) and Task 9 step 6 (the apply); §4.3 (the order) → Task 9 steps 1, 4, 6 and the conventions note. §5.1 (the SQL) → Task 3 `votesSql`/`CATALOG_PATHS_SQL`; §5.2 (assignment, MIN_VOTES, mixed paths, ties) → Task 2; §5.3 (stats and the log line) → Tasks 3 and 4; §5.4 (the phase) → Task 4; §5.5 (the script, `BA_CROSSWALK_WEEK`, dry run) → Task 3. §6 (the predicate and its fallback) → Task 5 and Task 8's cases; §7 (the list, the empty-list message) → Tasks 5 and 6; §8 (the hint) → Task 5; §9 (the facts join, the card) → Task 6; §10 (the tool contract, `GUIDE_VERSION` 6, the rule) → Task 6; §11 (coded errors, fail-soft, log-safe) → Tasks 3, 4; §12 (tests) → every task plus Task 8; §13 (shipping) → Task 9; §14 (follow-ups) → nothing, by design.

**Placeholder scan.** No TBD/TODO; every code step shows its code; the only "grep and fix" instructions name the pattern to grep and what to change (Task 6 step 5, Task 7 step 4).

**Type consistency.** `CrosswalkVote { path, code, products }`, `CrosswalkRow { categoryPath, code, sourcePath, votes, sharePct }`, `CrosswalkStats { week, paths, direct, backedOff, uncoded, trainingProducts, codes }` are used with those names in Tasks 2, 3, 4 and 8; `votesSql(week)`, `CATALOG_PATHS_SQL`, `insertSql(rows, week)`, `writeCrosswalk(client, rows, week)`, `computeCrosswalk(client, week)`, `buildCrosswalk(client, week)`, `WRITE_CHUNK`, `BaCrosswalkError` match between Task 3 and its callers; `ProductFacts.broadCategory: string | null` is the shape every consumer in Task 6 and the integration case in Task 8 reads; `BROAD_CATEGORY_LIST_SQL` keeps its export name for the cache key and the integration test.
