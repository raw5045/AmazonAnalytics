# Category Covering Index Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Category-scoped filtered explorer queries become index-only in their filtering phase — cold ≈ warm, 30–60s → <2s (spec: `docs/superpowers/specs/2026-08-23-category-covering-index-design.md`).

**Architecture:** A covering index `(week, category_path, rank) INCLUDE (severity, avg_reviews, word_count, search_term_id)` on both swap twins + a stored `word_count` column populated by the weekly refresh, consumed by a new two-stage query shape in `buildExplorerQuery` (inner index-only filter/sort/limit → outer PK join for display columns), used only when a coverage gate says every active sort+filter is covered.

**Tech Stack:** Postgres (Neon), raw-SQL migrations (hand-numbered, gated), Drizzle schema, Vitest canonical-string tests.

**Conventions (hard rules):**
- Commit trailer exactly: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- NEVER `git push`; NEVER run migrations/backfills — those are controller/owner-gated steps at the end.
- `git add` only named files. Work on `main` (owner-approved convention).
- Repo root `C:\Users\raw50\Amazon Keyword Analytics` (Git Bash: `/c/Users/raw50/"Amazon Keyword Analytics"`).

**Deploy-sequencing invariant (why code can be committed but MUST NOT be pushed):** the word-filter predicate flips from a computed expression to the `word_count` column in Task 4. Until migration 0046 is applied AND the backfill has filled the column, that predicate would return zero rows. The controller pushes only after apply + backfill + zero-NULL verification.

---

## File map

| File | Change | Task |
|---|---|---|
| `db/migrations/0046_category_covering_index.sql` | create | 1 |
| `scripts/applyMigration0046.ts` | create (gated) | 1 |
| `db/schema/keywordCurrentSummary.ts` | `wordCount` column + index breadcrumb | 1 |
| `scripts/backfillWordCount.ts` | create (gated, batched, VACUUM) | 2 |
| `inngest/functions/refreshSummary.ts` | INSERT column+expr; ANALYZE → VACUUM ANALYZE | 3 |
| `lib/explorer/buildQuery.ts` | predicate fragments refactor; word predicate flip; `categoryPathIsCovered`; covered two-stage path | 4, 5 |
| `lib/explorer/buildQuery.test.ts` | pins updated (word_count) + gate + covered-shape tests | 4, 5 |

Tasks 1→5 sequential (4 and 5 both touch buildQuery). Task 6 is controller-run gates.

---

### Task 1: Migration 0046 + apply script + schema

**Files:**
- Create: `db/migrations/0046_category_covering_index.sql`
- Create: `scripts/applyMigration0046.ts`
- Modify: `db/schema/keywordCurrentSummary.ts`

- [ ] **Step 1: Write the migration SQL**

`db/migrations/0046_category_covering_index.sql`:

```sql
-- 0046: category covering index + stored word_count
-- (spec docs/superpowers/specs/2026-08-23-category-covering-index-design.md)
--
-- word_count: words in search_term_normalized (spaces+1; single-spaced by
-- normalizeForMatch). NULL until the backfill (scripts/backfillWordCount.ts)
-- / the next weekly refresh populates it. The explorer word filter flips to
-- this column ONLY after the backfill verifies zero NULLs.
--
-- Covering index: makes category-scoped filtered queries index-only in
-- their filtering phase. Keys (week, path, rank) put each path's entries
-- rank-adjacent; INCLUDEs cover the always-on severity predicate, the
-- reviews/word range filters, and the id the outer query joins on.
-- Twin-table pattern (see 0044): the weekly refresh RENAME-swaps
-- keyword_current_summary <-> _stage, so BOTH need the index. The live
-- CREATE is CONCURRENTLY (no reader/writer block); _stage sits idle
-- between refreshes so a plain CREATE is fine.
--
-- NOTE for the apply script: CREATE INDEX CONCURRENTLY cannot run inside a
-- transaction — statements below are applied one at a time, NOT wrapped.

ALTER TABLE keyword_current_summary ADD COLUMN IF NOT EXISTS word_count smallint;
ALTER TABLE keyword_current_summary_stage ADD COLUMN IF NOT EXISTS word_count smallint;

CREATE INDEX CONCURRENTLY IF NOT EXISTS kcs_cat_cover_idx
  ON keyword_current_summary (current_week_end_date, top_clicked_category_path, current_rank)
  INCLUDE (fake_volume_severity_current, avg_reviews, word_count, search_term_id);

CREATE INDEX IF NOT EXISTS kcs_stage_cat_cover_idx
  ON keyword_current_summary_stage (current_week_end_date, top_clicked_category_path, current_rank)
  INCLUDE (fake_volume_severity_current, avg_reviews, word_count, search_term_id);
```

- [ ] **Step 2: Write the gated apply script**

`scripts/applyMigration0046.ts` — mirror `scripts/applyMigration0045.ts`'s shape (gate env var, read the .sql, execute, assert). Because of CONCURRENTLY, statements run individually:

```ts
/**
 * Gated apply for migration 0046 (owner-run):
 *   APPLY_0046=yes node --env-file=.env.local --import tsx scripts/applyMigration0046.ts
 * Statements run one at a time (CREATE INDEX CONCURRENTLY cannot be inside a
 * transaction). Asserts both columns + both indexes exist afterward.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { neon } from '@neondatabase/serverless';

async function main() {
  if (process.env.APPLY_0046 !== 'yes') {
    console.error('Refusing: set APPLY_0046=yes to apply migration 0046.');
    process.exit(1);
  }
  const sql = neon(process.env.DATABASE_URL!);
  const raw = readFileSync(join(process.cwd(), 'db', 'migrations', '0046_category_covering_index.sql'), 'utf8');
  const statements = raw
    .split(';')
    .map((s) => s.replace(/--[^\n]*/g, '').trim())
    .filter((s) => s.length > 0);
  for (const st of statements) {
    const label = st.slice(0, 72).replace(/\s+/g, ' ');
    const t0 = Date.now();
    await sql.query(st);
    console.log(`ok (${((Date.now() - t0) / 1000).toFixed(1)}s): ${label}…`);
  }

  const cols = (await sql`
    SELECT table_name FROM information_schema.columns
    WHERE column_name = 'word_count' AND table_name LIKE 'keyword_current_summary%'
  `) as Array<{ table_name: string }>;
  const idxs = (await sql`
    SELECT indexname FROM pg_indexes WHERE indexname IN ('kcs_cat_cover_idx', 'kcs_stage_cat_cover_idx')
  `) as Array<{ indexname: string }>;
  console.log('columns:', cols.map((c) => c.table_name).sort().join(', '));
  console.log('indexes:', idxs.map((i) => i.indexname).sort().join(', '));
  if (cols.length !== 2 || idxs.length !== 2) {
    console.error('ASSERTION FAILED: expected 2 columns + 2 indexes.');
    process.exit(1);
  }
  console.log('0046 applied and verified.');
}
main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 3: Schema update**

In `db/schema/keywordCurrentSummary.ts`, after the `topClickedCategoryPath` field:

```ts
    /**
     * Words in search_term_normalized (spaces+1 — single-spaced by
     * normalizeForMatch; hyphenated terms count as one). Populated by the
     * weekly refresh INSERT; backfilled once by scripts/backfillWordCount.ts
     * (migration 0046). Powers the explorer word-count filter + the
     * category covering index.
     */
    wordCount: smallint('word_count'),
```

(`smallint` is already imported in this file.) And extend the raw-SQL-index breadcrumb comment (the one referencing migration 0044) to also mention: `Migration 0046 adds kcs_cat_cover_idx (+ _stage twin) — a covering index with INCLUDE, raw SQL only (drizzle-kit can't emit INCLUDE).`

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit` — expect exit 0 (the new schema field is additive; nothing constructs full kcs rows in TS outside refresh SQL).

- [ ] **Step 5: Commit**

```bash
git add db/migrations/0046_category_covering_index.sql scripts/applyMigration0046.ts db/schema/keywordCurrentSummary.ts
git commit -m "feat(db): migration 0046 — word_count column + category covering index (unapplied)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Gated batched backfill script

**Files:**
- Create: `scripts/backfillWordCount.ts`

- [ ] **Step 1: Write the script**

```ts
/**
 * One-time gated backfill (owner-run, AFTER migration 0046):
 *   BACKFILL_WORD_COUNT=yes node --env-file=.env.local --import tsx scripts/backfillWordCount.ts
 *
 * Fills keyword_current_summary.word_count in batches (mass single UPDATE =
 * bloat/churn — the 2026-07 lesson), then VACUUM ANALYZE so (a) bloat is
 * reclaimed and (b) the visibility map is set — REQUIRED for the covering
 * index's index-only scans. Ends by asserting zero NULLs remain (the
 * word-filter predicate flip depends on it). The _stage table is NOT
 * backfilled — the next weekly refresh rebuilds it with word_count included.
 *
 * Batches walk the PK in order (keyset pagination — each batch's subquery is
 * an index-range read, never a rescan of already-updated rows), so total
 * work is O(N) regardless of batch count.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';

const BATCH = 50_000;

async function main() {
  if (process.env.BACKFILL_WORD_COUNT !== 'yes') {
    console.error('Refusing: set BACKFILL_WORD_COUNT=yes to run.');
    process.exit(1);
  }
  const sql = neon(process.env.DATABASE_URL!);

  let total = 0;
  let lastId = '00000000-0000-0000-0000-000000000000';
  for (;;) {
    const t0 = Date.now();
    const res = (await sql`
      WITH batch AS (
        SELECT search_term_id FROM keyword_current_summary
        WHERE search_term_id > ${lastId}::uuid
        ORDER BY search_term_id
        LIMIT ${BATCH}
      )
      UPDATE keyword_current_summary k
      SET word_count = (length(k.search_term_normalized) - length(replace(k.search_term_normalized, ' ', '')) + 1)::smallint
      FROM batch b
      WHERE k.search_term_id = b.search_term_id
        AND k.word_count IS NULL
        AND k.search_term_normalized IS NOT NULL
      RETURNING k.search_term_id
    `) as Array<{ search_term_id: string }>;
    // Advance the cursor by the batch's PK range even when nothing needed
    // updating (already-populated or normalized-NULL rows still advance it).
    const [cursor] = (await sql`
      SELECT MAX(search_term_id)::text AS last FROM (
        SELECT search_term_id FROM keyword_current_summary
        WHERE search_term_id > ${lastId}::uuid
        ORDER BY search_term_id LIMIT ${BATCH}
      ) b
    `) as Array<{ last: string | null }>;
    if (cursor.last === null) break;
    lastId = cursor.last;
    total += res.length;
    console.log(`batch to ${lastId.slice(0, 8)}…: ${res.length} updated in ${((Date.now() - t0) / 1000).toFixed(1)}s (total ${total.toLocaleString()})`);
  }
  console.log(`backfilled ${total.toLocaleString()} rows; VACUUM ANALYZE…`);

  const t1 = Date.now();
  await sql.query('VACUUM ANALYZE keyword_current_summary');
  console.log(`vacuum analyze done in ${((Date.now() - t1) / 1000).toFixed(0)}s`);

  const [nulls] = (await sql`
    SELECT COUNT(*)::int AS n FROM keyword_current_summary
    WHERE word_count IS NULL AND search_term_normalized IS NOT NULL
  `) as Array<{ n: number }>;
  const [nullNorm] = (await sql`
    SELECT COUNT(*)::int AS n FROM keyword_current_summary WHERE search_term_normalized IS NULL
  `) as Array<{ n: number }>;
  console.log(`remaining NULL word_count (with normalized): ${nulls.n} | rows lacking normalized text: ${nullNorm.n}`);
  if (nulls.n !== 0) {
    console.error('ASSERTION FAILED: NULL word_count rows remain — do NOT deploy the predicate flip.');
    process.exit(1);
  }
  console.log('backfill complete — safe to deploy the word-filter predicate flip.');
}
main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Typecheck** — `npx tsc --noEmit` (exit 0). Do NOT run the script.

- [ ] **Step 3: Commit**

```bash
git add scripts/backfillWordCount.ts
git commit -m "feat(db): gated batched word_count backfill (unrun)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Refresh integration (word_count + VACUUM)

**Files:**
- Modify: `inngest/functions/refreshSummary.ts` (INSERT column list ~line 317, SELECT ~line 403, ANALYZE block ~line 421–441)

- [ ] **Step 1: Add the column to the INSERT list**

In the `INSERT INTO keyword_current_summary_stage (...)` column list, change:

```
        search_term_normalized,
        updated_at
```
to:
```
        search_term_normalized,
        word_count,
        updated_at
```

- [ ] **Step 2: Add the expression to the SELECT**

Directly after the line `l.search_term_normalized,` (before `NOW()`):

```sql
        -- Words in the normalized term (spaces+1 — single-spaced upstream).
        -- Powers the explorer word filter + the 0046 covering index.
        (length(l.search_term_normalized) - length(replace(l.search_term_normalized, ' ', '')) + 1)::smallint AS word_count,
```

- [ ] **Step 3: ANALYZE → VACUUM ANALYZE**

Replace the step-4b block's query and update its comment. The existing:

```ts
    try {
      await client.query('ANALYZE keyword_current_summary_stage');
```

becomes:

```ts
    try {
      // VACUUM (not just ANALYZE): the bulk INSERT leaves every page without
      // visibility-map bits, and the 0046 covering index's index-only scans
      // silently degrade to per-row heap checks until VACUUM sets them
      // (EXPLAIN shows "Heap Fetches: <huge>"). VACUUM ANALYZE does stats +
      // VM in one pass; it cannot run inside a transaction, which is why
      // this sits after the COMMIT above. Fail-soft as before.
      await client.query('VACUUM ANALYZE keyword_current_summary_stage');
```

and the catch's warn message becomes `'[refreshSummary] VACUUM ANALYZE of stage table failed; relying on autovacuum:'`. Keep the original 4b explanatory comment block above it, appending one line: `-- 0046: upgraded to VACUUM ANALYZE for the covering index's visibility map.`

- [ ] **Step 4: Typecheck + refresh-adjacent tests**

Run: `npx tsc --noEmit` (exit 0), then `npx vitest run` — ALL pass (refresh SQL is string-built; no unit test pins the INSERT column list — if one does, fix it to the new truth).

- [ ] **Step 5: Commit**

```bash
git add inngest/functions/refreshSummary.ts
git commit -m "feat(refresh): populate word_count + VACUUM ANALYZE stage for index-only scans

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Predicate fragments + word-filter flip + coverage gate

**Files:**
- Modify: `lib/explorer/buildQuery.ts`
- Test: `lib/explorer/buildQuery.test.ts`

- [ ] **Step 1: Update the word-filter test pins to the new truth (failing first)**

In `lib/explorer/buildQuery.test.ts`, the `describe('word-count range filter')` block: replace every `${EXPR} >=` / `${EXPR} <=` expectation on PREDICATES with `kcs.word_count >=` / `kcs.word_count <=` pins, and the default-absence assertions with `not.toContain('kcs.word_count')`. Keep the `EXPR` constant and add ONE new test pinning that `wordCountExpr('kcs.')` still RETURNS the exact expression string (it remains the refresh/backfill source of truth):

```ts
  it('wordCountExpr stays byte-stable (refresh INSERT + backfill depend on it)', () => {
    expect(wordCountExpr('kcs.')).toBe(EXPR);
    expect(wordCountExpr('')).toBe(EXPR.replaceAll('kcs.', ''));
  });
```

(Import `wordCountExpr` in the test file's import list if not present.) Add gate tests:

```ts
describe('categoryPathIsCovered', () => {
  const withLeaf = { ...baseFilters, leafPaths: ['Health & Household › X'] };
  it('covered: rank sorts with severity/rank/reviews/word filters', () => {
    expect(categoryPathIsCovered(withLeaf)).toBe(true);
    expect(categoryPathIsCovered({ ...withLeaf, sort: 'rank_desc', rankMax: 1000, reviewsMax: 500, wordsMin: 3 })).toBe(true);
  });
  it('not covered: q, jumps, title filter, non-rank sorts, no leafPaths', () => {
    expect(categoryPathIsCovered(baseFilters)).toBe(false);
    expect(categoryPathIsCovered({ ...withLeaf, q: 'abc' })).toBe(false);
    expect(categoryPathIsCovered({ ...withLeaf, jump: '100k_to_50k' })).toBe(false);
    expect(categoryPathIsCovered({ ...withLeaf, titleMatchMode: 'any' })).toBe(false);
    expect(categoryPathIsCovered({ ...withLeaf, sort: 'imp' })).toBe(false);
    expect(categoryPathIsCovered({ ...withLeaf, sort: 'avg_reviews_desc' })).toBe(false);
  });
});
```

Run `npx vitest run lib/explorer/buildQuery.test.ts` — the changed pins + gate tests FAIL.

- [ ] **Step 2: Extract predicate fragment helpers**

In `buildQuery.ts`, above `pushKcsPredicates`, add module-private helpers so the covered path (Task 5) can compose the SAME fragments without drift:

```ts
type NextParam = (val: unknown) => string;

/** Severity fragment — null unless the filter narrows below all-3. */
function severityPredicate(filters: ExplorerFilters, next: NextParam): string | null {
  if (filters.severities.length === 0 || filters.severities.length >= 3) return null;
  const params = filters.severities.map((s) => next(s)).join(', ');
  return filters.severities.includes('none')
    ? `(kcs.fake_volume_severity_current IS NULL OR kcs.fake_volume_severity_current IN (${params}))`
    : `kcs.fake_volume_severity_current IN (${params})`;
}

/** rank/reviews/word bound fragments, in fixed clause order; [] when inactive. */
function rangeBoundPredicates(filters: ExplorerFilters, next: NextParam): string[] {
  const out: string[] = [];
  if (filters.rankMin !== null) out.push(`kcs.current_rank >= ${next(filters.rankMin)}`);
  if (filters.rankMax !== null) out.push(`kcs.current_rank <= ${next(filters.rankMax)}`);
  if (filters.reviewsMin !== null) out.push(`kcs.avg_reviews >= ${next(filters.reviewsMin)}`);
  if (filters.reviewsMax !== null) out.push(`kcs.avg_reviews <= ${next(filters.reviewsMax)}`);
  if (filters.wordsMin !== null) out.push(`kcs.word_count >= ${next(filters.wordsMin)}`);
  if (filters.wordsMax !== null) out.push(`kcs.word_count <= ${next(filters.wordsMax)}`);
  return out;
}

/** leafPaths IN fragment; null when no leaf filter. */
function leafPathPredicate(filters: ExplorerFilters, next: NextParam): string | null {
  if (filters.leafPaths.length === 0) return null;
  const ps = filters.leafPaths.map((c) => next(c)).join(', ');
  return `kcs.top_clicked_category_path IN (${ps})`;
}
```

Rewrite `pushKcsPredicates` to use them, PRESERVING today's exact clause order (week → rank bounds → reviews bounds → word bounds → jump → category → leafPaths → severity → title → vol-delta eligibility). CAUTION: today rank/reviews/word bounds sit BEFORE jump and leafPaths sits AFTER category, severity AFTER leafPaths — `rangeBoundPredicates` covers the first block; `leafPathPredicate` and `severityPredicate` slot into their current positions. The canonical-string tests are the referee: every pre-existing pin must still pass, EXCEPT the deliberately-flipped word pins.

- [ ] **Step 3: The word-filter flip**

Inside `rangeBoundPredicates` above, the word bounds already use `kcs.word_count` — that IS the flip (the old `wordCountExpr(...)` pushes are gone from `pushKcsPredicates` by this refactor). `wordCountExpr` stays exported with its doc comment amended: `Retained for the refresh INSERT + backfill script; the explorer predicate reads the stored kcs.word_count column since migration 0046.`

- [ ] **Step 4: The coverage gate**

Add (exported, near `sortUsesVolumeDelta`):

```ts
/**
 * True when the category-scoped covered path (0046 covering index) can serve
 * this filter set: leaf/custom category active, and every OTHER active sort
 * + filter is answerable from the index (keys week/path/rank; includes
 * severity/avg_reviews/word_count). Anything else → the classic paths.
 * Deliberately conservative: new filters/sorts default to NOT covered.
 */
export function categoryPathIsCovered(filters: ExplorerFilters): boolean {
  return (
    filters.leafPaths.length > 0
    && filters.q === null
    && filters.jump === null
    && filters.category === null
    && filters.titleMatchMode === null
    && (filters.sort === 'rank' || filters.sort === 'rank_desc')
  );
}
```

- [ ] **Step 5: Run tests**

`npx vitest run lib/explorer/buildQuery.test.ts` — ALL pass (old pins prove the refactor emitted byte-identical clauses; word pins prove the flip; gate tests pass). Then `npx tsc --noEmit`.

- [ ] **Step 6: Commit**

```bash
git add lib/explorer/buildQuery.ts lib/explorer/buildQuery.test.ts
git commit -m "feat(explorer): predicate fragments + word-filter flip to word_count + coverage gate

DEPLOY GATE: requires migration 0046 applied + backfill zero-NULL verified.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: The covered two-stage query path

**Files:**
- Modify: `lib/explorer/buildQuery.ts` (new branch inside `buildExplorerQuery`, before the q path)
- Test: `lib/explorer/buildQuery.test.ts`

- [ ] **Step 1: Write the failing canonical tests**

```ts
describe('covered category path (0046 covering index)', () => {
  const leaf = { ...baseFilters, leafPaths: ['Health & Household › X', 'Health & Household › Y'] };

  it('emits the two-stage shape: index-only inner, PK-join outer', () => {
    const { sql, countSql, args, countArgs } = buildExplorerQuery({ ...leaf, reviewsMax: 500, wordsMin: 3 }, '2026-08-15');
    const n = norm(sql);
    expect(n).toContain('FROM ( SELECT kcs.search_term_id, kcs.current_rank FROM keyword_current_summary kcs');
    expect(n).toContain('kcs.top_clicked_category_path IN ($2, $3)');
    expect(n).toContain('kcs.avg_reviews <= $');
    expect(n).toContain('kcs.word_count >= $');
    expect(n).toContain(') i JOIN keyword_current_summary kcs ON kcs.search_term_id = i.search_term_id');
    expect(n).toContain('JOIN search_terms st ON st.id = kcs.search_term_id');
    expect(n).toMatch(/ORDER BY kcs\.current_rank ASC[\s\S]*ORDER BY kcs\.current_rank ASC/); // inner + outer
    expect(norm(countSql)).toContain('SELECT 1 FROM keyword_current_summary kcs');
    expect(norm(countSql)).not.toContain('JOIN'); // count = inner where only
    expect(countArgs.length).toBeLessThan(args.length); // prefix invariant
  });

  it('inner selects ONLY covered columns (index-only requirement)', () => {
    const { sql } = buildExplorerQuery(leaf, '2026-08-15');
    const inner = norm(sql).split(') i JOIN')[0];
    for (const col of ['top_clicked_product_1_title_current', 'estimated_monthly_volume_current', 'improvement_1w']) {
      expect(inner).not.toContain(col);
    }
  });

  it('rank_desc flips both ORDER BYs', () => {
    const { sql } = buildExplorerQuery({ ...leaf, sort: 'rank_desc' }, '2026-08-15');
    expect(norm(sql)).toMatch(/ORDER BY kcs\.current_rank DESC[\s\S]*ORDER BY kcs\.current_rank DESC/);
  });

  it('non-covered combos fall back to the classic shapes unchanged', () => {
    for (const f of [
      { ...leaf, sort: 'imp' as const },
      { ...leaf, q: 'magnesium' },
      { ...leaf, jump: '100k_to_50k' as const },
      { ...baseFilters },
    ]) {
      const { sql } = buildExplorerQuery(f, '2026-08-15');
      expect(norm(sql)).not.toContain(') i JOIN keyword_current_summary');
    }
  });

  it('N+1 limit + offset ride the inner query', () => {
    const { sql, args } = buildExplorerQuery({ ...leaf, page: 3, perPage: 100 }, '2026-08-15');
    const inner = norm(sql).split(') i JOIN')[0];
    expect(inner).toMatch(/LIMIT \$\d+ OFFSET \$\d+/);
    expect(args).toContain(101); // perPage + 1
    expect(args).toContain(200); // (page-1)*perPage
  });
});
```

Run — all FAIL (shape doesn't exist).

- [ ] **Step 2: Implement the covered branch**

In `buildExplorerQuery`, directly BEFORE the `if (filters.q && filters.q.length >= 3) {` branch:

```ts
  // ---- covered category path (0046): category-scoped + fully-covered
  //      filter/sort set. The inner subquery is answerable entirely from
  //      kcs_cat_cover_idx (index-only: filter + sort + page over ≤ the
  //      category's entries), so cold performance ≈ warm. The outer joins
  //      kcs back by PK for the ~perPage display rows only, then
  //      search_terms for raw text. Counts run over the inner WHERE.
  if (categoryPathIsCovered(filters)) {
    const where: string[] = [];
    if (currentWeekEndDate) {
      where.push(`kcs.current_week_end_date = ${next(currentWeekEndDate)}::date`);
    }
    const leafP = leafPathPredicate(filters, next);
    if (leafP) where.push(leafP);
    where.push(...rangeBoundPredicates(filters, next));
    const sevP = severityPredicate(filters, next);
    if (sevP) where.push(sevP);
    const whereClause = `WHERE ${where.join('\n        AND ')}`;

    const dir = filters.sort === 'rank_desc' ? 'DESC' : 'ASC';
    const countArgs = [...args];
    const limitParam = next(filters.perPage + 1);
    const offsetParam = next((filters.page - 1) * filters.perPage);

    const sql = `
    SELECT
      ${kcsSelectFor(priorRankCol, improvementCol, filters.window)}
    FROM (
      SELECT kcs.search_term_id, kcs.current_rank
      FROM keyword_current_summary kcs
      ${whereClause}
      ORDER BY kcs.current_rank ${dir}
      LIMIT ${limitParam} OFFSET ${offsetParam}
    ) i
    JOIN keyword_current_summary kcs ON kcs.search_term_id = i.search_term_id
    JOIN search_terms st ON st.id = kcs.search_term_id
    ORDER BY kcs.current_rank ${dir}
  `.trim();

    const countSql = `
    SELECT COUNT(*)::int AS total
    FROM (
      SELECT 1
      FROM keyword_current_summary kcs
      ${whereClause}
      LIMIT ${COUNT_CAP + 1}
    ) sub
  `.trim();

    return { sql, args, countSql, countArgs };
  }
```

This requires hoisting the legacy path's select list into a helper both paths share (DRY; prevents display-column drift):

```ts
/** The full display select (legacy + covered outer): st raw + kcs columns. */
function kcsSelectFor(priorRankCol: string, improvementCol: string, window: WindowKey): string {
  return `
      kcs.search_term_id,
      st.search_term_raw,
      kcs.current_rank,
      kcs.${priorRankCol} AS prior_rank,
      kcs.${improvementCol} AS improvement,
      ${volumePriorExpr(window, 'kcs.')} AS volume_prior,
      ${volumeDeltaExpr(window, 'kcs.')} AS volume_delta,
      ${KCS_DISPLAY_COLS.map((c) => `kcs.${c}`).join(',\n      ')}
  `.trim();
}
```

and the legacy path's `const kcsSelect = …` block becomes `const kcsSelect = kcsSelectFor(priorRankCol, improvementCol, filters.window);` — the legacy SQL string itself must stay byte-identical (existing canonical pins are the referee).

- [ ] **Step 3: Run the full test file + typecheck**

`npx vitest run lib/explorer/buildQuery.test.ts` — ALL pass (new covered tests + every pre-existing pin, proving legacy/q paths byte-unchanged). `npx tsc --noEmit` exit 0. Then the FULL suite: `npx vitest run` — all pass (queryTotals guards unaffected: covered path changes rows SQL shape, not count semantics).

- [ ] **Step 4: Commit**

```bash
git add lib/explorer/buildQuery.ts lib/explorer/buildQuery.test.ts
git commit -m "feat(explorer): covered two-stage category path over the 0046 index

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Controller-run verification + owner-gated rollout

(Controller with prod access + owner gates — NOT a subagent.)

- [ ] 1. Full local verify: `npx tsc --noEmit && npx vitest run && npx next build`.
- [ ] 2. **OWNER GATE — apply migration 0046** (`APPLY_0046=yes …`); CONCURRENTLY build time reported.
- [ ] 3. **OWNER GATE — run the backfill** (`BACKFILL_WORD_COUNT=yes …`); zero-NULL assertion must pass.
- [ ] 4. Pre-push prod probe (throwaway script): EXPLAIN (ANALYZE, BUFFERS) the built covered SQL for the owner's real 206-leaf category × {no filters, 3+ words + ≤500 reviews, 1-word + ≤500 reviews}: assert **Index Only Scan using kcs_cat_cover_idx** with low Heap Fetches on the inner, cold-class latency **< 2s**; fallback combos (q / imp sort) show unchanged classic plans.
- [ ] 5. **OWNER GATE — push** (checkActiveJobs first), deploy watch, owner tries the previously-slow searches live.
- [ ] 6. Next weekly import follow-through: `import_phase_timings` refresh delta (index maintenance + VACUUM cost vs ~272-min baseline) + re-probe post-swap (visibility-map regression check). Report both to the owner.
