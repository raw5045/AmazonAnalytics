# Explorer Filter Performance + Loading Overlay — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `/explorer` "search term contains" (`q`) filter fast and flat across pages for every sort option, and show an obvious centered loading overlay on any filter/sort/pagination transition.

**Architecture:** When `q` is set, replace the rank-ordered nested-loop probe with a `MATERIALIZED` CTE that resolves trigram matches first, then joins `keyword_current_summary`, sorts, and slices — with the pagination total carried by `count(*) OVER ()` in the same pass (no separate count query). The no-`q` path is untouched. A pure-CSS `LoadingOverlay` is rendered from the existing `useTransition` `isPending` in the three controls that navigate.

**Tech Stack:** TypeScript, Next.js 16.2.3 (App Router), React 19, Postgres (Neon, `pg_trgm` GIN), neon-http driver, Drizzle, vitest + @testing-library/react. Spec: `docs/superpowers/specs/2026-06-19-explorer-filter-perf-design.md`.

**Branch:** `perf/explorer-filter-trigram` (spec already committed there).

**Commit trailer (every commit):**
```
Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
```

---

## File Structure

- `lib/explorer/types.ts` — add optional `countFromRows` to `BuiltExplorerQuery`.
- `lib/explorer/buildQuery.ts` — extract `pushKcsPredicates`; add the `q`-path CTE branch; add `Q_MATCH_MATERIALIZE_CAP`. The no-`q` path keeps identical output.
- `lib/explorer/buildQuery.test.ts` — rewrite the `q` tests for the CTE form; add new CTE/sort/compose tests.
- `lib/explorer/queryTotals.ts` *(new)* — pure helpers `applyCountCap`, `extractCount`, `extractWindowTotal` (no env import → unit-testable).
- `lib/explorer/queryTotals.test.ts` *(new)* — unit tests for those helpers.
- `lib/explorer/runQuery.ts` — branch on `countFromRows`: `q` total comes from the rows pass (window count), with an empty-page fallback; use the new helpers.
- `app/(app)/explorer/LoadingOverlay.tsx` *(new)* — the overlay component.
- `app/(app)/explorer/LoadingOverlay.test.tsx` *(new)* — render tests.
- `app/(app)/explorer/FilterSidebar.tsx`, `Pagination.tsx`, `SortableHeader.tsx` — render `<LoadingOverlay show={isPending} />` from existing local `useTransition`.

---

## Task 1: `buildExplorerQuery` — trigram-first CTE for the `q` path

**Files:**
- Modify: `lib/explorer/types.ts`
- Modify: `lib/explorer/buildQuery.ts`
- Test: `lib/explorer/buildQuery.test.ts`

- [ ] **Step 1: Update the `q`-dependent tests + add CTE tests (write the failing tests)**

In `lib/explorer/buildQuery.test.ts`, **replace** the `describe('search term substring (q)', …)` block with:

```ts
  describe('search term substring (q) — trigram-first CTE path', () => {
    it('builds a MATERIALIZED CTE with the trigram LIKE + cap, not a kcs WHERE LIKE', () => {
      const { sql, args, countArgs } = buildExplorerQuery({ ...baseFilters, q: 'wireless' });
      expect(norm(sql)).toContain('WITH matches AS MATERIALIZED');
      expect(norm(sql)).toContain('FROM search_terms WHERE search_term_normalized LIKE $1');
      expect(norm(sql)).toContain('LIMIT $2'); // the materialize cap
      expect(norm(sql)).toContain('JOIN matches m ON m.id = kcs.search_term_id');
      expect(norm(sql)).toContain('(count(*) OVER ())::int AS total');
      // q + cap are the first two args; '%wireless%' is the LIKE pattern
      expect(args[0]).toBe('%wireless%');
      expect(args[1]).toBe(50_000);
      expect(countArgs[0]).toBe('%wireless%');
    });

    it('lowercases the search pattern', () => {
      const { args } = buildExplorerQuery({ ...baseFilters, q: 'WiReLeSS' });
      expect(args[0]).toBe('%wireless%');
    });

    it('flags countFromRows so the runner reads the total from the rows pass', () => {
      const { countFromRows } = buildExplorerQuery({ ...baseFilters, q: 'wireless' });
      expect(countFromRows).toBe(true);
    });

    it('sorts the matched set by ANY sort column (e.g. avg_reviews_desc)', () => {
      const { sql } = buildExplorerQuery({ ...baseFilters, q: 'hair', sort: 'avg_reviews_desc' });
      expect(norm(sql)).toContain('WITH matches AS MATERIALIZED');
      expect(norm(sql)).toContain('ORDER BY kcs.avg_reviews DESC NULLS LAST');
    });

    it('composes other filters in the OUTER where, not the CTE', () => {
      const { sql } = buildExplorerQuery({ ...baseFilters, q: 'hair', rankMax: 1000, category: 'Electronics' });
      const cteEnd = norm(sql).indexOf(') SELECT');
      const cte = norm(sql).slice(0, cteEnd);
      const outer = norm(sql).slice(cteEnd);
      expect(cte).not.toContain('current_rank <=');
      expect(outer).toContain('kcs.current_rank <=');
      expect(outer).toContain('kcs.top_clicked_category_1_current =');
    });

    it('skips the CTE when q is null (legacy path)', () => {
      const { sql, countFromRows } = buildExplorerQuery({ ...baseFilters, q: null });
      expect(norm(sql)).not.toContain('WITH matches');
      expect(norm(sql)).toContain('JOIN search_terms st ON st.id = kcs.search_term_id');
      expect(countFromRows).toBeFalsy();
    });
  });
```

In the `describe('countSql vs sql', …)` block, **replace** the test `'countSql uses identical WHERE + the bail-out LIMIT, no ORDER BY / OFFSET'` and `'keeps the search_terms join in countSql when q is set (the LIKE needs st)'` with:

```ts
    it('non-q countSql uses the bail-out LIMIT, no ORDER BY / OFFSET', () => {
      const { countSql } = buildExplorerQuery({ ...baseFilters, rankMin: 1, rankMax: 50000 });
      expect(norm(countSql)).toContain('current_rank >=');
      expect(norm(countSql)).toContain('current_rank <=');
      expect(norm(countSql)).not.toContain('ORDER BY');
      expect(norm(countSql)).toContain('LIMIT 10001');
      expect(norm(countSql)).not.toContain('OFFSET');
    });

    it('q countSql is the empty-page fallback: CTE matched count, no bail-out LIMIT', () => {
      const { countSql } = buildExplorerQuery({ ...baseFilters, q: 'wireless', rankMax: 50000 });
      expect(norm(countSql)).toContain('WITH matches AS MATERIALIZED');
      expect(norm(countSql)).toContain('JOIN matches m ON m.id = kcs.search_term_id');
      expect(norm(countSql)).toContain('SELECT count(*)::int AS total');
      expect(norm(countSql)).not.toContain('LIMIT 10001');
      expect(norm(countSql)).not.toContain('ORDER BY');
    });
```

In `describe('combined filters', …) › 'handles all filters together'`, **replace** the final two assertions:

```ts
      expect(args.slice(-2)).toEqual([50, 50]);
      expect(args.length).toBe(countArgs.length + 2);
      // countSql LIMITs the bail-out subquery; that's the only LIMIT it has.
      expect(norm(countSql)).toContain('LIMIT 10001');
```

with:

```ts
      expect(args.slice(-2)).toEqual([50, 50]);
      expect(args.length).toBe(countArgs.length + 2);
      // q is set → CTE path: total from the rows window count, fallback countSql has no bail-out LIMIT.
      expect(norm(sql)).toContain('WITH matches AS MATERIALIZED');
      expect(norm(sql)).toContain('(count(*) OVER ())::int AS total');
      expect(norm(countSql)).not.toContain('LIMIT 10001');
```

- [ ] **Step 2: Run the tests, watch them fail**

Run: `pnpm test buildQuery`
Expected: FAIL — the new `q` tests expect `WITH matches AS MATERIALIZED`, which doesn't exist yet.

- [ ] **Step 3: Add `countFromRows` to the type**

In `lib/explorer/types.ts`, update `BuiltExplorerQuery`:

```ts
export interface BuiltExplorerQuery {
  sql: string;
  args: unknown[];
  countSql: string;
  countArgs: unknown[];
  /**
   * True for the `q` (substring) path: the paged SELECT carries the total
   * via `count(*) OVER () AS total`, so the runner reads the total from the
   * rows result instead of running countSql. countSql is then only the
   * empty-page fallback (OFFSET past the end → no row to carry the total).
   */
  countFromRows?: boolean;
}
```

- [ ] **Step 4: Implement the CTE path in `buildQuery.ts`**

In `lib/explorer/buildQuery.ts`:

(a) Add the cap constant next to `COUNT_CAP`:

```ts
/**
 * Max number of trigram matches the `q` path materializes + sorts. Below
 * this, results are exact and fully rank-correct (covers all realistic
 * searches — e.g. "hair" ≈ 35k matches). Above it (pathologically broad
 * 3-char substrings), we read the first N trigram matches and the total
 * shows "{COUNT_CAP}+" — a documented degradation that bounds worst-case
 * latency. See the explorer-filter-perf spec §3.3.
 */
export const Q_MATCH_MATERIALIZE_CAP = 50_000;
```

(b) Extract the kcs predicate builder (everything except `q`). Add this helper (it reuses `slotColumn`, `findJumpPreset`, and the `WINDOW_TO_*` maps already in the file):

```ts
/**
 * Push every kcs WHERE predicate (current_week_end_date, rank, jump,
 * category, leaf, severity, title-gap) onto a fresh clause list, binding
 * args via `next` in clause order. The `q` substring filter is NOT here —
 * it is path-specific (CTE for the q path; absent on the legacy path).
 */
function pushKcsPredicates(
  filters: ExplorerFilters,
  currentWeekEndDate: string | undefined,
  next: (val: unknown) => string,
): string[] {
  const where: string[] = [];
  const priorRankCol = WINDOW_TO_RANK_COLUMN[filters.window];

  if (currentWeekEndDate) {
    where.push(`kcs.current_week_end_date = ${next(currentWeekEndDate)}::date`);
  }
  if (filters.rankMin !== null) {
    where.push(`kcs.current_rank >= ${next(filters.rankMin)}`);
  }
  if (filters.rankMax !== null) {
    where.push(`kcs.current_rank <= ${next(filters.rankMax)}`);
  }
  if (filters.jump) {
    let from: number | null = null;
    let to: number | null = null;
    if (filters.jump === 'custom') {
      from = filters.jumpFrom;
      to = filters.jumpTo;
    } else {
      const found = findJumpPreset(filters.jump);
      if (found) { from = found.preset.from; to = found.preset.to; }
    }
    if (from !== null && to !== null) {
      if (filters.jumpMetric === 'volume') {
        const volCol = WINDOW_TO_VOLUME_COLUMN[filters.window];
        where.push(`kcs.${volCol} < ${next(from)} AND kcs.estimated_monthly_volume_current > ${next(to)}`);
      } else {
        where.push(`kcs.${priorRankCol} > ${next(from)} AND kcs.current_rank < ${next(to)}`);
      }
    }
  }
  if (filters.category) {
    where.push(`kcs.top_clicked_category_1_current = ${next(filters.category)}`);
  }
  if (filters.leafCategories.length > 0) {
    const ps = filters.leafCategories.map((c) => next(c)).join(', ');
    where.push(`kcs.top_clicked_leaf_category IN (${ps})`);
  }
  if (filters.severities.length > 0 && filters.severities.length < 3) {
    const params = filters.severities.map((s) => next(s)).join(', ');
    if (filters.severities.includes('none')) {
      where.push(`(kcs.fake_volume_severity_current IS NULL OR kcs.fake_volume_severity_current IN (${params}))`);
    } else {
      where.push(`kcs.fake_volume_severity_current IN (${params})`);
    }
  }
  if (filters.titleMatchMode && filters.titleSlots.length > 0) {
    const conditions = filters.titleSlots.map((slot) => `NOT ${slotColumn(slot, filters.matchMode)}`);
    const joiner = filters.titleMatchMode === 'all' ? ' AND ' : ' OR ';
    where.push(`(${conditions.join(joiner)})`);
  }
  return where;
}
```

(c) Replace the body of `buildExplorerQuery` (from the `const args` line through the final `return`) with:

```ts
  const args: unknown[] = [];
  const next = (val: unknown): string => {
    args.push(val);
    return `$${args.length}`;
  };

  const priorRankCol = WINDOW_TO_RANK_COLUMN[filters.window];
  const improvementCol = WINDOW_TO_IMPROVEMENT_COLUMN[filters.window];
  const orderBy = buildOrderBy(filters.sort, improvementCol, filters.matchMode);

  // kcs SELECT columns shared by both paths. The search_term_raw source
  // differs (st in the legacy join, m in the CTE), so it's templated.
  const kcsSelect = (rawSrc: string): string => `
      kcs.search_term_id,
      ${rawSrc}.search_term_raw,
      kcs.current_rank,
      kcs.${priorRankCol} AS prior_rank,
      kcs.${improvementCol} AS improvement,
      kcs.top_clicked_category_1_current,
      kcs.fake_volume_severity_current,
      kcs.keyword_title_match_count_current,
      kcs.keyword_in_title_1_current,
      kcs.keyword_in_title_2_current,
      kcs.keyword_in_title_3_current,
      kcs.keyword_title_match_count_loose_current,
      kcs.keyword_in_title_1_loose_current,
      kcs.keyword_in_title_2_loose_current,
      kcs.keyword_in_title_3_loose_current,
      kcs.top_clicked_product_1_asin_current,
      kcs.top_clicked_product_1_title_current,
      kcs.top_clicked_product_1_click_share_current,
      kcs.top_clicked_product_1_conversion_share_current,
      kcs.estimated_monthly_volume_current,
      kcs.avg_price_cents,
      kcs.avg_reviews,
      kcs.top_clicked_leaf_category
  `.trim();

  // ---- q (substring) path: trigram-first MATERIALIZED CTE ----
  if (filters.q && filters.q.length >= 3) {
    const qParam = next(`%${filters.q.toLowerCase()}%`);
    const capParam = next(Q_MATCH_MATERIALIZE_CAP);
    const where = pushKcsPredicates(filters, currentWeekEndDate, next);
    const whereClause = where.length > 0 ? `WHERE ${where.join('\n      AND ')}` : '';
    const countArgs = [...args];
    const limitParam = next(filters.perPage);
    const offsetParam = next((filters.page - 1) * filters.perPage);

    const sql = `
    WITH matches AS MATERIALIZED (
      SELECT id, search_term_raw
      FROM search_terms
      WHERE search_term_normalized LIKE ${qParam}
      LIMIT ${capParam}
    )
    SELECT
      ${kcsSelect('m')},
      (count(*) OVER ())::int AS total
    FROM keyword_current_summary kcs
    JOIN matches m ON m.id = kcs.search_term_id
    ${whereClause}
    ${orderBy}
    LIMIT ${limitParam} OFFSET ${offsetParam}
  `.trim();

    // Empty-page fallback only (OFFSET past the end → no row to carry the
    // window total). The runner calls this just when the rows result is
    // empty; normal pages get the total for free from the rows pass.
    const countSql = `
    SELECT count(*)::int AS total
    FROM (
      WITH matches AS MATERIALIZED (
        SELECT id
        FROM search_terms
        WHERE search_term_normalized LIKE ${qParam}
        LIMIT ${capParam}
      )
      SELECT 1
      FROM keyword_current_summary kcs
      JOIN matches m ON m.id = kcs.search_term_id
      ${whereClause}
    ) sub
  `.trim();

    return { sql, args, countSql, countArgs, countFromRows: true };
  }

  // ---- legacy path (q is null): identical output to before ----
  const where = pushKcsPredicates(filters, currentWeekEndDate, next);
  const whereClause = where.length > 0 ? `WHERE ${where.join('\n      AND ')}` : '';
  const countArgs = [...args];
  const limitParam = next(filters.perPage);
  const offsetParam = next((filters.page - 1) * filters.perPage);

  const sql = `
    SELECT
      ${kcsSelect('st')}
    FROM keyword_current_summary kcs
    JOIN search_terms st ON st.id = kcs.search_term_id
    ${whereClause}
    ${orderBy}
    LIMIT ${limitParam} OFFSET ${offsetParam}
  `.trim();

  const countJoin = whereClause.includes('st.')
    ? '\n      JOIN search_terms st ON st.id = kcs.search_term_id'
    : '';
  const countSql = `
    SELECT COUNT(*)::int AS total
    FROM (
      SELECT 1
      FROM keyword_current_summary kcs${countJoin}
      ${whereClause}
      LIMIT ${COUNT_CAP + 1}
    ) sub
  `.trim();

  return { sql, args, countSql, countArgs };
```

Remove the now-unused inline `selectList`/`where`/q-clause code this replaces. Keep `COUNT_CAP`, `buildOrderBy`, `slotColumn`, and the `WINDOW_TO_*` maps as-is.

- [ ] **Step 5: Run the full buildQuery suite, watch it pass**

Run: `pnpm test buildQuery`
Expected: PASS — both the no-`q` tests (output unchanged; the tests are whitespace-insensitive via `norm()` and assert exact `args`/`countArgs`) and the new CTE tests.

- [ ] **Step 6: Commit**

```bash
git add lib/explorer/buildQuery.ts lib/explorer/buildQuery.test.ts lib/explorer/types.ts
git commit -m "perf(explorer): trigram-first MATERIALIZED CTE for the q filter" -m "Resolves substring matches via the trigram index first, then joins kcs + sorts + slices, with the total from count() OVER() in the same pass. Flat across pages, every sort option, composes with all other filters. No-q path output unchanged." -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: `runExplorerQuery` — total from the window count

**Files:**
- Create: `lib/explorer/queryTotals.ts`
- Test: `lib/explorer/queryTotals.test.ts`
- Modify: `lib/explorer/runQuery.ts`

- [ ] **Step 1: Write the failing helper tests**

Create `lib/explorer/queryTotals.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { applyCountCap, extractCount, extractWindowTotal } from './queryTotals';
import { COUNT_CAP } from './buildQuery';

describe('applyCountCap', () => {
  it('passes through values at or below the cap', () => {
    expect(applyCountCap(0)).toEqual({ total: 0, totalIsCapped: false });
    expect(applyCountCap(COUNT_CAP)).toEqual({ total: COUNT_CAP, totalIsCapped: false });
  });
  it('caps values above the cap and flags it', () => {
    expect(applyCountCap(COUNT_CAP + 1)).toEqual({ total: COUNT_CAP, totalIsCapped: true });
    expect(applyCountCap(999_999)).toEqual({ total: COUNT_CAP, totalIsCapped: true });
  });
});

describe('extractCount', () => {
  it('reads total from the first row (number or bigint-string)', () => {
    expect(extractCount([{ total: 42 }])).toBe(42);
    expect(extractCount([{ total: '42' }])).toBe(42);
  });
  it('returns 0 for an empty result', () => {
    expect(extractCount([])).toBe(0);
  });
});

describe('extractWindowTotal', () => {
  it('returns the total from the first row', () => {
    expect(extractWindowTotal([{ total: 7 }, { total: 7 }])).toBe(7);
    expect(extractWindowTotal([{ total: '7' }])).toBe(7);
  });
  it('returns null for an empty page (no row carries the total)', () => {
    expect(extractWindowTotal([])).toBeNull();
  });
});
```

- [ ] **Step 2: Run, watch fail**

Run: `pnpm test queryTotals`
Expected: FAIL — `./queryTotals` does not exist.

- [ ] **Step 3: Implement the helpers**

Create `lib/explorer/queryTotals.ts`:

```ts
/**
 * Pure total-resolution helpers for runExplorerQuery, split out so they
 * carry no env/neon import and can be unit-tested directly.
 */
import { COUNT_CAP } from './buildQuery';

/** Apply the pagination display cap. */
export function applyCountCap(rawTotal: number): { total: number; totalIsCapped: boolean } {
  const totalIsCapped = rawTotal > COUNT_CAP;
  return { total: totalIsCapped ? COUNT_CAP : rawTotal, totalIsCapped };
}

/** Read `total` from a COUNT(*) result (bigint may arrive as a string). */
export function extractCount(rows: Array<{ total: number | string }>): number {
  if (!rows || rows.length === 0) return 0;
  const t = rows[0].total;
  return typeof t === 'string' ? parseInt(t, 10) : t;
}

/**
 * Read the window-function total carried on each row of the q-path rows
 * result. null when the page is empty (OFFSET past the end), signalling
 * the caller to run the fallback count.
 */
export function extractWindowTotal(rows: Array<{ total?: number | string }>): number | null {
  if (!rows || rows.length === 0) return null;
  const t = rows[0].total;
  if (t === undefined || t === null) return null;
  return typeof t === 'string' ? parseInt(t, 10) : t;
}
```

- [ ] **Step 4: Run, watch pass**

Run: `pnpm test queryTotals`
Expected: PASS.

- [ ] **Step 5: Wire the helpers into `runQuery.ts`**

In `lib/explorer/runQuery.ts`:

(a) Add the import near the top:

```ts
import { applyCountCap, extractCount, extractWindowTotal } from './queryTotals';
```

(b) Add an optional `total` to `RawRow` (the q path's window count rides on each row):

```ts
  avg_reviews: number | null;
  top_clicked_leaf_category: string | null;
  total?: number | string; // q-path window count: (count(*) OVER ())::int
}
```

(c) Capture `built`, then replace the count-execution + total-resolution block. Change:

```ts
  const { sql, args, countSql, countArgs } = buildExplorerQuery(filters, currentWeekEndDate);
```

to:

```ts
  const built = buildExplorerQuery(filters, currentWeekEndDate);
  const { sql, args, countSql, countArgs } = built;
```

Then **replace** the execution block — from `const tRowsStart = Date.now();` through the end of the `if (precomputedTotal !== null) … else …` total resolution, **including the existing `rawRows`/`rows` mapping in between** (the new block reproduces it, so don't leave the old copy) — with:

```ts
  // Rows always run. The live count runs in parallel ONLY for the legacy
  // path (no q, no precomputed short-circuit). The q path carries its total
  // on the rows via count(*) OVER (); a precomputed total skips counting.
  const tRowsStart = Date.now();
  const rowsPromise = sqlClient.query(sql, args).then((r) => ({ result: r, ms: Date.now() - tRowsStart }));

  const needsLiveCount = precomputedTotal === null && !built.countFromRows;
  const tCountStart = Date.now();
  const countPromise = needsLiveCount
    ? sqlClient.query(countSql, countArgs).then((r) => ({ result: r, ms: Date.now() - tCountStart }))
    : Promise.resolve({ result: null as unknown, ms: 0 });

  const [rowsTimed, countTimed] = await Promise.all([rowsPromise, countPromise]);
  const rawRows = rowsTimed.result as unknown as RawRow[];

  const rows: ExplorerRow[] = rawRows.map((r) => ({
    searchTermId: r.search_term_id,
    searchTermRaw: r.search_term_raw,
    currentRank: r.current_rank,
    priorRank: r.prior_rank,
    improvement: r.improvement,
    topClickedCategory1: r.top_clicked_category_1_current,
    fakeVolumeSeverity: r.fake_volume_severity_current,
    keywordTitleMatchCount: r.keyword_title_match_count_current,
    keywordInTitle1: r.keyword_in_title_1_current,
    keywordInTitle2: r.keyword_in_title_2_current,
    keywordInTitle3: r.keyword_in_title_3_current,
    keywordTitleMatchCountLoose: r.keyword_title_match_count_loose_current,
    keywordInTitle1Loose: r.keyword_in_title_1_loose_current,
    keywordInTitle2Loose: r.keyword_in_title_2_loose_current,
    keywordInTitle3Loose: r.keyword_in_title_3_loose_current,
    topClickedProduct1Asin: r.top_clicked_product_1_asin_current,
    topClickedProduct1Title: r.top_clicked_product_1_title_current,
    topClickedProduct1ClickShare: r.top_clicked_product_1_click_share_current,
    topClickedProduct1ConversionShare: r.top_clicked_product_1_conversion_share_current,
    estimatedMonthlyVolumeCurrent: parseBigint(r.estimated_monthly_volume_current),
    avgPriceCents: parseBigint(r.avg_price_cents),
    avgReviews: r.avg_reviews ?? null,
    topClickedLeafCategory: r.top_clicked_leaf_category ?? null,
  }));

  // Resolve the total + capping.
  let total: number;
  let totalIsCapped: boolean;
  let countMs = countTimed.ms;
  if (precomputedTotal !== null) {
    ({ total, totalIsCapped } = applyCountCap(precomputedTotal));
  } else if (built.countFromRows) {
    const windowTotal = extractWindowTotal(rawRows as Array<{ total?: number | string }>);
    if (windowTotal !== null) {
      ({ total, totalIsCapped } = applyCountCap(windowTotal));
    } else {
      // Empty page (OFFSET past the end): one fallback count.
      const tFallback = Date.now();
      const cr = await sqlClient.query(countSql, countArgs);
      countMs = Date.now() - tFallback;
      ({ total, totalIsCapped } = applyCountCap(extractCount(cr as unknown as Array<{ total: number | string }>)));
    }
  } else {
    ({ total, totalIsCapped } = applyCountCap(extractCount(countTimed.result as unknown as Array<{ total: number | string }>)));
  }
```

(d) Update the `timings.countMs` in the returned object to use the `countMs` variable above (it replaces `countTimed.ms`):

```ts
    timings: {
      metaLookupMs,
      rowsMs: rowsTimed.ms,
      countMs,
      usedPredicate: currentWeekEndDate !== undefined,
      countSource,
    },
```

> Note: `countSource` stays `'live'` for the q path (the total IS computed live, just folded into the rows pass), with `countMs = 0`. The PerfStrip renders `count=0ms (live)` — correct, no change needed there.

- [ ] **Step 6: Typecheck + run the explorer suite**

Run: `pnpm typecheck && pnpm test explorer`
Expected: PASS (buildQuery + queryTotals + any other `lib/explorer` tests). `runQuery` itself has no unit test (it hits the DB); it's covered by the manual perf check in Task 5.

- [ ] **Step 7: Commit**

```bash
git add lib/explorer/runQuery.ts lib/explorer/queryTotals.ts lib/explorer/queryTotals.test.ts
git commit -m "perf(explorer): q-path total from the rows window count" -m "runExplorerQuery reads the q-path total from count() OVER() on the rows result (no separate count query); legacy live count still runs in parallel. Pure cap/extract helpers split into queryTotals.ts + unit tested." -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: `LoadingOverlay` component

**Files:**
- Create: `app/(app)/explorer/LoadingOverlay.tsx`
- Test: `app/(app)/explorer/LoadingOverlay.test.tsx`

- [ ] **Step 1: Write the failing render tests**

Create `app/(app)/explorer/LoadingOverlay.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { LoadingOverlay } from './LoadingOverlay';

describe('LoadingOverlay', () => {
  it('renders nothing when show is false', () => {
    const { container } = render(<LoadingOverlay show={false} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders a status overlay with the Loading label when show is true', () => {
    const { container, getByText } = render(<LoadingOverlay show={true} />);
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    expect(getByText('Loading')).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run, watch fail**

Run: `pnpm test LoadingOverlay`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the component**

Create `app/(app)/explorer/LoadingOverlay.tsx`:

```tsx
'use client';

/**
 * Full-viewport centered loading overlay shown during in-place explorer
 * transitions (filter Apply, sort, pagination). Driven by the caller's
 * useTransition isPending. Pure-CSS spinner — a faint ring with a rotating
 * blue arc and "Loading" in the middle, over a dimmed backdrop.
 *
 * Complementary to loading.tsx (the route-level skeleton for hard/cold
 * loads); this covers soft router.replace transitions where the old page
 * stays mounted and would otherwise look frozen.
 */
export function LoadingOverlay({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-white/60"
    >
      <span className="sr-only">Loading</span>
      <div className="relative h-16 w-16" aria-hidden="true">
        <div className="absolute inset-0 rounded-full border-4 border-gray-200" />
        <div className="absolute inset-0 rounded-full border-4 border-transparent border-t-blue-600 animate-spin" />
        <span className="absolute inset-0 flex items-center justify-center text-xs font-medium text-gray-700">
          Loading
        </span>
      </div>
    </div>
  );
}
```

> `animate-spin` is a built-in Tailwind utility — no keyframes needed. The visible "Loading" label is inside the `aria-hidden` ring; the `sr-only` span gives screen readers a single clean announcement.

- [ ] **Step 4: Run, watch pass**

Run: `pnpm test LoadingOverlay`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "app/(app)/explorer/LoadingOverlay.tsx" "app/(app)/explorer/LoadingOverlay.test.tsx"
git commit -m "feat(explorer): centered LoadingOverlay spinner component" -m "Pure-CSS ring spinner over a dimmed backdrop, gated on a show prop. Driven by callers' useTransition isPending in the next task." -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Wire the overlay into the navigating controls

**Files:**
- Modify: `app/(app)/explorer/FilterSidebar.tsx`
- Modify: `app/(app)/explorer/Pagination.tsx`
- Modify: `app/(app)/explorer/SortableHeader.tsx`

Each already holds `const [isPending, startTransition] = useTransition();`. Render the shared overlay from that local `isPending`. Only one control is pending at a time, so a single overlay shows.

- [ ] **Step 1: FilterSidebar**

Add the import:

```ts
import { LoadingOverlay } from './LoadingOverlay';
```

Wrap the returned `<aside>…</aside>` in a fragment and render the overlay alongside it. Change `return (` `<aside …>` … `</aside>` `)` so it reads:

```tsx
  return (
    <>
      <LoadingOverlay show={isPending} />
      <aside className="w-72 border-r sticky top-24 self-start h-[calc(100vh-6rem)] flex flex-col">
        {/* …existing sidebar body unchanged… */}
      </aside>
    </>
  );
```

(The existing inline "Updating…" / "Applying…" labels stay — the overlay is the primary signal.)

- [ ] **Step 2: Pagination**

Add the import:

```ts
import { LoadingOverlay } from './LoadingOverlay';
```

Wrap the returned `<nav>…</nav>` in a fragment with the overlay:

```tsx
  return (
    <>
      <LoadingOverlay show={isPending} />
      <nav className="mt-4 flex items-center gap-3 text-sm">
        {/* …existing buttons + jump form unchanged… */}
      </nav>
    </>
  );
```

- [ ] **Step 3: SortableHeader**

Add the import:

```ts
import { LoadingOverlay } from './LoadingOverlay';
```

Render the overlay inside the returned `<th>`, after the `<button>` (fixed positioning takes it out of flow, so the table layout is unaffected):

```tsx
  return (
    <th className={`p-0 ${className}`} title={title}>
      <button
        type="button"
        onClick={handleClick}
        disabled={isPending}
        className={`w-full px-2 py-2 flex items-center gap-1 ${alignClass} cursor-pointer hover:bg-gray-100 transition-colors ${isPending ? 'opacity-60' : ''}`}
      >
        {align === 'right' && <ArrowIcon isAsc={isAsc} isDesc={isDesc} />}
        <span>{label}</span>
        {align !== 'right' && <ArrowIcon isAsc={isAsc} isDesc={isDesc} />}
      </button>
      <LoadingOverlay show={isPending} />
    </th>
  );
```

> Because `SortableHeader` is shared with `/watchlist`, that page gets the same overlay on column-sort with no extra wiring.

- [ ] **Step 4: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "app/(app)/explorer/FilterSidebar.tsx" "app/(app)/explorer/Pagination.tsx" "app/(app)/explorer/SortableHeader.tsx"
git commit -m "feat(explorer): show LoadingOverlay on filter/sort/pagination transitions" -m "Renders the centered spinner from each navigating control's useTransition isPending, so any filter Apply, sort, or page change gives an immediate 'working on it' signal. /watchlist inherits it via SortableHeader." -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Verify — perf, correctness, full suite

**Files:** none (verification + any small fixes)

- [ ] **Step 1: Full test suite + typecheck + lint**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all green.

- [ ] **Step 2: Perf re-check against the live DB — run the ACTUAL new SQL**

The existing `scripts/diagExplorerFilterPerf.ts` hardcodes the *old* rank-walk SQL, so it can't verify the fix. Create `scripts/verifyExplorerCtePlan.ts`, which builds the real query via `buildExplorerQuery` and times/EXPLAINs it:

```ts
import { config } from 'dotenv';
config({ path: '.env.local' });
import { Pool } from 'pg';
import { buildExplorerQuery } from '../lib/explorer/buildQuery';
import { EXPLORER_DEFAULTS } from '../lib/explorer/parseFilters';

async function main() {
  const word = process.argv[2] ?? 'hair';
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, keepAlive: true });
  const c = await pool.connect();
  const m = await c.query(`SELECT current_week_end_date::text AS d FROM keyword_current_summary_meta WHERE singleton = true`);
  const week: string = m.rows[0]?.d;
  const build = (page: number) => buildExplorerQuery({ ...EXPLORER_DEFAULTS, q: word, page }, week);

  for (const page of [1, 21]) {
    const { sql, args } = build(page);
    const t0 = Date.now();
    const r = await c.query(sql, args);
    const total = (r.rows[0] as { total?: number } | undefined)?.total ?? 'n/a';
    console.log(`"${word}" page ${page}: ${Date.now() - t0}ms  rows=${r.rowCount}  total=${total}`);
  }

  const { sql, args } = build(21);
  const ea = await c.query('EXPLAIN (ANALYZE, BUFFERS) ' + sql, args);
  console.log('\n' + (ea.rows as Array<Record<string, string>>).map((x) => x['QUERY PLAN']).join('\n'));

  c.release();
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
```

Run: `pnpm tsx scripts/verifyExplorerCtePlan.ts hair` (then try `protein`, `men`).
Expected: `page 1` and `page 21` are close to each other (flat — no OFFSET explosion); the plan shows `CTE matches` / a trigram bitmap feeding the join (not the 150k-row rank-walk); warm runs sub-second; `total` is populated from the window count. This script is a keeper (leave it untracked alongside the other `diag*`/`verify*` scripts, or commit it — implementer's choice).

- [ ] **Step 3: Manual UI smoke (dev server)**

Run: `pnpm dev`, open `/explorer`, and confirm:
1. Type `hair` in "Search term contains" → Apply → centered spinner shows, results return quickly, page 1 ≈ later pages.
2. Click **Next** a few times under the `hair` filter → fast + spinner each time; footer total stays consistent.
3. Change the **Sort** dropdown to "Most avg reviews" and Apply under `hair` → results re-sort, spinner shows.
4. Click a **column header** to sort → spinner shows.
5. Apply a non-`q` filter (e.g. a category) → spinner shows (proves overlay covers every filter, not just `q`).
6. Page total for a common word shows exact count (or "10,000+" when capped).

- [ ] **Step 4: Commit any fixes, then stop for review**

If steps 1–3 required fixes, commit them with the standard trailer. Otherwise nothing to commit. Do NOT push — hand back for review and the user authorizes the push to `main` / PR.

---

## Notes for the implementer

- **No DDL / no migration.** The trigram GIN index (`search_terms_normalized_trgm_idx`) already exists. Do not touch the schema.
- **Do not push.** Pushing to `main` requires explicit per-turn user authorization; finish on `perf/explorer-filter-trigram` and hand back.
- **Next 16 (per AGENTS.md):** the overlay uses React's `useTransition` only — no Next-version-sensitive API. If you reach for a router-pending hook, read `node_modules/next/dist/docs/` first.
- **Out of scope (spec §8):** next-page prefetch/caching and denormalization. Don't implement them here.
