# Avg-Reviews Range Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an inclusive min/max filter on `kcs.avg_reviews` to the explorer so review-count bounds compose with every sort and filter (spec: `docs/superpowers/specs/2026-07-20-avg-reviews-filter-design.md`).

**Architecture:** Mechanical clone of the existing `rankMin`/`rankMax` filter through the full stack: URL params → `parseFilters` → `pushKcsPredicates` (one shared WHERE builder feeds both query paths, rows + counts) → count-guard opt-outs → sidebar card → saved-views serialize/parse. No schema changes; `kcs_avg_reviews_idx` already exists in prod.

**Tech Stack:** Next.js 16 (App Router), TypeScript, raw-SQL query builder, Vitest, Neon Postgres.

**Conventions (hard rules):**
- Commit trailer exactly: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- NEVER `git push` — the controller handles pushes after owner authorization.
- `git add` only the named files — never `-A` or `.` (untracked scratch scripts must stay untracked).
- Run commands from the repo root `C:\Users\raw50\Amazon Keyword Analytics` (Windows; Git Bash paths like `/c/Users/raw50/...` work in the Bash tool).
- Work happens directly on `main` (owner-approved session convention).

**Critical cross-cutting invariant — zero is a valid bound.** `reviewsMax: 0` means "keywords whose top-3 products average zero reviews" and must behave as an ACTIVE filter. Every check must be `!== null` (or `typeof === 'number'`), never truthiness. Several steps below pin this with tests.

---

## File map

| File | Change |
|---|---|
| `lib/explorer/types.ts` | `ExplorerFilters` + `reviewsMin`/`reviewsMax` |
| `lib/explorer/parseFilters.ts` | defaults, `parseNonNegativeInt`, parse + return |
| `lib/explorer/parseFilters.test.ts` | new tests + extend full-object expectation |
| `lib/savedViews/validation.ts` | `normalizeFiltersBlob` reads (Task 1); `filtersToSearchParams` writes (Task 4) |
| `lib/savedViews/validation.test.ts` | round-trip + legacy-blob tests |
| `lib/explorer/buildQuery.ts` | two predicates in `pushKcsPredicates` |
| `lib/explorer/buildQuery.test.ts` | predicate pins + fix full-literal fixture |
| `lib/explorer/queryTotals.ts` | 3 guards opt out |
| `lib/explorer/queryTotals.test.ts` | guard tests |
| `app/(app)/explorer/FilterSidebar.tsx` | pending state + params + new card |
| `app/(app)/explorer/page.tsx` | `filtersAreCustomized` additions |

Tasks run in order 1→6. Tasks 1–4 are lib-level TDD; Task 5 is UI; Task 6 is verification + owner-gated ship.

---

### Task 1: Types + parser + type-ripple

Adding two required fields to `ExplorerFilters` breaks every full-object literal of that type. This task adds the fields, the parser support, and every type-satisfying edit so the repo typechecks green at the end. (Both `baseFilters` test fixtures spread `EXPLORER_DEFAULTS`, so they self-heal once the defaults gain the fields.)

**Files:**
- Modify: `lib/explorer/types.ts:50-51` (after `rankMax`)
- Modify: `lib/explorer/parseFilters.ts` (defaults ~line 25, helper ~line 112, parse ~line 187, return ~line 204)
- Modify: `lib/savedViews/validation.ts:80-81` (`normalizeFiltersBlob` — type-satisfying read)
- Modify: `lib/explorer/buildQuery.test.ts:344` (full `ExplorerFilters` literal — add fields)
- Test: `lib/explorer/parseFilters.test.ts`

- [ ] **Step 1: Write the failing tests**

In `lib/explorer/parseFilters.test.ts`, add a new describe block at the end of the file:

```ts
describe('avg-reviews range params', () => {
  it('parses reviews_min and reviews_max', () => {
    const f = parseExplorerFilters({ reviews_min: '100', reviews_max: '500' });
    expect(f.reviewsMin).toBe(100);
    expect(f.reviewsMax).toBe(500);
  });

  it('accepts 0 as a bound (zero-review niches)', () => {
    const f = parseExplorerFilters({ reviews_max: '0' });
    expect(f.reviewsMin).toBeNull();
    expect(f.reviewsMax).toBe(0);
  });

  it('defaults to null and rejects garbage', () => {
    expect(parseExplorerFilters({}).reviewsMin).toBeNull();
    expect(parseExplorerFilters({}).reviewsMax).toBeNull();
    const bad = parseExplorerFilters({ reviews_min: '-3', reviews_max: 'abc' });
    expect(bad.reviewsMin).toBeNull();
    expect(bad.reviewsMax).toBeNull();
  });
});
```

Also extend the existing `parses every valid param` test (lines 17–54): add `reviews_min: '250', reviews_max: '900',` to the input object and `reviewsMin: 250, reviewsMax: 900,` to the expected object (place both right after the rank fields). This test uses a full-object `toEqual`, so it fails to compile/match until the feature lands — that's expected.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/explorer/parseFilters.test.ts`
Expected: FAIL — TypeScript/property errors (`reviewsMin` does not exist) or mismatched objects.

- [ ] **Step 3: Implement**

`lib/explorer/types.ts` — inside `ExplorerFilters`, directly after `rankMax: number | null;`:

```ts
  /**
   * Inclusive avg-reviews bounds over the top-3 clicked ASINs
   * (kcs.avg_reviews). When either bound is set, rows with NULL
   * avg_reviews (unenriched top-3) are excluded — unknown ≠ low.
   * 0 is a legal bound (max 0 = zero-review niches).
   */
  reviewsMin: number | null;
  reviewsMax: number | null;
```

`lib/explorer/parseFilters.ts` — in `EXPLORER_DEFAULTS`, after `rankMax: null,`:

```ts
  reviewsMin: null,
  reviewsMax: null,
```

Directly after the `parsePositiveInt` function:

```ts
/**
 * Like parsePositiveInt but admits 0 — used by the avg-reviews bounds,
 * where 0 is meaningful (reviews_max=0 = zero-review niches).
 */
function parseNonNegativeInt(value: string | undefined): number | null {
  if (!value) return null;
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}
```

(Note: `!value` is safe — the string `'0'` is truthy; only `undefined`/`''` short-circuit.)

In `parseExplorerFilters`, after the `rankMin`/`rankMax` lines:

```ts
  const reviewsMin = parseNonNegativeInt(getOne(searchParams.reviews_min));
  const reviewsMax = parseNonNegativeInt(getOne(searchParams.reviews_max));
```

And in the returned object, after `rankMax,`:

```ts
    reviewsMin,
    reviewsMax,
```

`lib/savedViews/validation.ts` — in `normalizeFiltersBlob`'s returned object, after the `rankMax` line (line 81):

```ts
    reviewsMin: typeof f.reviewsMin === 'number' ? f.reviewsMin : null,
    reviewsMax: typeof f.reviewsMax === 'number' ? f.reviewsMax : null,
```

`lib/explorer/buildQuery.test.ts` — the full literal at line 344 (`const filters: ExplorerFilters = {`): add `reviewsMin: null, reviewsMax: null,` after its `rankMax` entry.

- [ ] **Step 4: Run tests + typecheck to verify green**

Run: `npx vitest run lib/explorer/parseFilters.test.ts lib/savedViews/validation.test.ts lib/explorer/buildQuery.test.ts`
Expected: PASS (all).
Run: `npx tsc --noEmit`
Expected: exit 0. If other full-literal `ExplorerFilters` constructions surface, add the two null fields there too — do NOT loosen the type.

- [ ] **Step 5: Commit**

```bash
git add lib/explorer/types.ts lib/explorer/parseFilters.ts lib/explorer/parseFilters.test.ts lib/savedViews/validation.ts lib/explorer/buildQuery.test.ts
git commit -m "feat(explorer): reviewsMin/reviewsMax filter fields + parsing

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Query predicates in buildQuery

`pushKcsPredicates` (buildQuery.ts:268) is the single WHERE builder feeding both query paths (default + q/trigram CTE) and both rows + count SQL, binding args in clause order via `next()`. Two new conditional pushes go directly after the `rankMax` block (line 282–284) and before the `jump` block — keeping clause/arg order identical between rows and count SQL preserves the countArgs-prefix invariant documented on `BuiltExplorerQuery`.

**Files:**
- Modify: `lib/explorer/buildQuery.ts:284` (after the rankMax push)
- Test: `lib/explorer/buildQuery.test.ts`

- [ ] **Step 1: Write the failing tests**

Add a new describe block in `lib/explorer/buildQuery.test.ts` (file already defines `baseFilters` spread from `EXPLORER_DEFAULTS` and a `norm()` whitespace normalizer at the top):

```ts
describe('avg-reviews range filter', () => {
  it('pushes both bounds into rows and count SQL (default path)', () => {
    const { sql, countSql, args, countArgs } = buildExplorerQuery({ ...baseFilters, reviewsMin: 100, reviewsMax: 500 });
    expect(norm(sql)).toContain('kcs.avg_reviews >= $');
    expect(norm(sql)).toContain('kcs.avg_reviews <= $');
    expect(norm(countSql)).toContain('kcs.avg_reviews >= $');
    expect(norm(countSql)).toContain('kcs.avg_reviews <= $');
    expect(args).toContain(100);
    expect(args).toContain(500);
    expect(countArgs).toContain(100);
    expect(countArgs).toContain(500);
  });

  it('emits a lone bound independently', () => {
    const minOnly = buildExplorerQuery({ ...baseFilters, reviewsMin: 1000 });
    expect(norm(minOnly.sql)).toContain('kcs.avg_reviews >= $');
    expect(norm(minOnly.sql)).not.toContain('kcs.avg_reviews <= $');
  });

  it('treats reviewsMax: 0 as an active bound (not falsy-skipped)', () => {
    const { sql, args } = buildExplorerQuery({ ...baseFilters, reviewsMax: 0 });
    expect(norm(sql)).toContain('kcs.avg_reviews <= $');
    expect(args).toContain(0);
  });

  it('emits no reviews predicates by default', () => {
    const { sql, countSql } = buildExplorerQuery(baseFilters);
    expect(norm(sql)).not.toContain('avg_reviews >=');
    expect(norm(sql)).not.toContain('avg_reviews <=');
    expect(norm(countSql)).not.toContain('avg_reviews >=');
    expect(norm(countSql)).not.toContain('avg_reviews <=');
  });

  it('applies reviews predicates on the q path too', () => {
    const { sql, countSql } = buildExplorerQuery({ ...baseFilters, q: 'magnesium', reviewsMax: 500 });
    expect(norm(sql)).toContain('kcs.avg_reviews <= $');
    expect(norm(countSql)).toContain('kcs.avg_reviews <= $');
  });

  it('composes with the volume-delta sorts (reviews + eligibility both present)', () => {
    const { sql } = buildExplorerQuery({ ...baseFilters, sort: 'imp', reviewsMax: 500 });
    expect(norm(sql)).toContain('kcs.avg_reviews <= $');
    expect(norm(sql)).toContain('estimated_monthly_volume_current IS NOT NULL');
  });
});
```

(The default-path SELECT list and the avg-reviews SORT both reference bare `kcs.avg_reviews` without a comparison operator, so the `not.toContain('avg_reviews >=')` assertions are safe.)

- [ ] **Step 2: Run tests to verify the new block fails**

Run: `npx vitest run lib/explorer/buildQuery.test.ts`
Expected: the new describe block FAILS (predicates absent); all pre-existing tests PASS.

- [ ] **Step 3: Implement**

In `lib/explorer/buildQuery.ts`, inside `pushKcsPredicates`, directly after:

```ts
  if (filters.rankMax !== null) {
    where.push(`kcs.current_rank <= ${next(filters.rankMax)}`);
  }
```

add:

```ts
  if (filters.reviewsMin !== null) {
    where.push(`kcs.avg_reviews >= ${next(filters.reviewsMin)}`);
  }
  if (filters.reviewsMax !== null) {
    where.push(`kcs.avg_reviews <= ${next(filters.reviewsMax)}`);
  }
```

Also update the function's doc comment (line 261–267) so the predicate list mentions reviews: change `(current_week_end_date, rank, jump, category, leaf, severity, title-gap)` to `(current_week_end_date, rank, reviews, jump, category, leaf, severity, title-gap)`.

- [ ] **Step 4: Run tests to verify green**

Run: `npx vitest run lib/explorer/buildQuery.test.ts`
Expected: PASS (all, including the pre-existing canonical-string pins — the insertion must not disturb existing clause text).

- [ ] **Step 5: Commit**

```bash
git add lib/explorer/buildQuery.ts lib/explorer/buildQuery.test.ts
git commit -m "feat(explorer): avg_reviews range predicates in shared WHERE builder

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Count-guard opt-outs

The three guards in `lib/explorer/queryTotals.ts` short-circuit to precomputed totals when they believe no narrowing filters are active. A guard-blind reviews filter would display the unfiltered total over a filtered table.

**Files:**
- Modify: `lib/explorer/queryTotals.ts:56-112` (all three exported guards)
- Test: `lib/explorer/queryTotals.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `lib/explorer/queryTotals.test.ts` (file already defines `baseFilters` spread from `EXPLORER_DEFAULTS`):

```ts
describe('avg-reviews filter blocks precomputed totals', () => {
  it('canUseDefaultTotal is false when either reviews bound is set', () => {
    expect(canUseDefaultTotal({ ...baseFilters, reviewsMin: 100 })).toBe(false);
    expect(canUseDefaultTotal({ ...baseFilters, reviewsMax: 0 })).toBe(false);
  });

  it('canUseCategoryFacet is false when either reviews bound is set', () => {
    expect(canUseCategoryFacet({ ...baseFilters, category: 'Beauty', reviewsMax: 500 })).toBe(false);
    expect(canUseCategoryFacet({ ...baseFilters, category: 'Beauty', reviewsMin: 1 })).toBe(false);
  });

  it('canUseLeafCategoryFacet is false when either reviews bound is set', () => {
    expect(canUseLeafCategoryFacet({ ...baseFilters, leafPaths: ['Beauty › Face Moisturizers'], reviewsMin: 1 })).toBe(false);
    expect(canUseLeafCategoryFacet({ ...baseFilters, leafPaths: ['Beauty › Face Moisturizers'], reviewsMax: 500 })).toBe(false);
  });
});
```

(If the existing file doesn't import all three guards, extend its import from `./queryTotals`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/explorer/queryTotals.test.ts`
Expected: the new tests FAIL (guards return true today).

- [ ] **Step 3: Implement**

In each of `canUseDefaultTotal` (line ~56), `canUseCategoryFacet` (line ~77), and `canUseLeafCategoryFacet` (line ~99), add two conditions directly after the existing `&& f.rankMax === null` line:

```ts
    && f.reviewsMin === null
    && f.reviewsMax === null
```

- [ ] **Step 4: Run tests to verify green**

Run: `npx vitest run lib/explorer/queryTotals.test.ts`
Expected: PASS (new + all pre-existing guard truthiness tests).

- [ ] **Step 5: Commit**

```bash
git add lib/explorer/queryTotals.ts lib/explorer/queryTotals.test.ts
git commit -m "feat(explorer): reviews filter opts out of precomputed totals

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Saved-views serialization

`normalizeFilters` (the client-save path) round-trips a structured blob through `filtersToSearchParams` → `parseExplorerFilters`, so it needs the serialize half; `normalizeFiltersBlob` (the DB-hydrate path) already reads the fields since Task 1. This task adds the serialize lines + tests for both paths.

**Files:**
- Modify: `lib/savedViews/validation.ts:110-111` (`filtersToSearchParams`, after the `rank_max` line)
- Test: `lib/savedViews/validation.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `lib/savedViews/validation.test.ts` (import `normalizeFilters`, `normalizeFiltersBlob` from `./validation` and `EXPLORER_DEFAULTS` from `@/lib/explorer/parseFilters` if not already imported — match the file's existing import style):

```ts
describe('avg-reviews filter round-trip', () => {
  it('normalizeFilters preserves reviews bounds through the URL-param round-trip', () => {
    const out = normalizeFilters({ ...EXPLORER_DEFAULTS, reviewsMin: 100, reviewsMax: 500 });
    expect(out.reviewsMin).toBe(100);
    expect(out.reviewsMax).toBe(500);
  });

  it('round-trips a 0 bound (typeof-number check, not truthiness)', () => {
    const out = normalizeFilters({ ...EXPLORER_DEFAULTS, reviewsMax: 0 });
    expect(out.reviewsMax).toBe(0);
  });

  it('normalizeFiltersBlob reads stored bounds and defaults legacy blobs to null', () => {
    expect(normalizeFiltersBlob({ reviewsMin: 250 }).reviewsMin).toBe(250);
    const legacy = normalizeFiltersBlob({ window: '4w' });
    expect(legacy.reviewsMin).toBeNull();
    expect(legacy.reviewsMax).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify the round-trip tests fail**

Run: `npx vitest run lib/savedViews/validation.test.ts`
Expected: the two `normalizeFilters` tests FAIL (serialize drops the fields → parse defaults to null); the blob test PASSES already (Task 1) — that's fine, it pins the behavior.

- [ ] **Step 3: Implement**

In `lib/savedViews/validation.ts`, in `filtersToSearchParams`, directly after:

```ts
  if (typeof f.rankMax === 'number') p.rank_max = String(f.rankMax);
```

add:

```ts
  if (typeof f.reviewsMin === 'number') p.reviews_min = String(f.reviewsMin);
  if (typeof f.reviewsMax === 'number') p.reviews_max = String(f.reviewsMax);
```

- [ ] **Step 4: Run tests to verify green**

Run: `npx vitest run lib/savedViews/validation.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/savedViews/validation.ts lib/savedViews/validation.test.ts
git commit -m "feat(savedViews): serialize reviewsMin/reviewsMax

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Sidebar card + active-filter check

No component unit tests exist in this repo — verification is typecheck + the full suite + the controller's browser pass in Task 6.

**Files:**
- Modify: `app/(app)/explorer/FilterSidebar.tsx` (PendingFilters ~line 57, `filtersToPending` ~line 82, `pendingToParams` ~line 107, card JSX after line 302)
- Modify: `app/(app)/explorer/page.tsx:348` (`filtersAreCustomized`)

- [ ] **Step 1: Extend PendingFilters + mappers**

In `app/(app)/explorer/FilterSidebar.tsx`, inside the `PendingFilters` interface, directly after the `rankWorst: string;` field:

```ts
  /** Numeric strings; empty = unset. Inclusive avg-reviews range (top-3 ASINs). */
  reviewsMin: string;
  reviewsMax: string;
```

In `filtersToPending`, after `rankWorst: f.rankMax?.toString() ?? '',`:

```ts
    reviewsMin: f.reviewsMin?.toString() ?? '',
    reviewsMax: f.reviewsMax?.toString() ?? '',
```

(`0?.toString()` yields `'0'` — optional chaining only short-circuits null/undefined, so a 0 bound survives.)

In `pendingToParams`, after `if (p.rankWorst) params.set('rank_max', p.rankWorst);`:

```ts
  if (p.reviewsMin) params.set('reviews_min', p.reviewsMin);
  if (p.reviewsMax) params.set('reviews_max', p.reviewsMax);
```

(String truthiness is correct here: `'0'` is truthy, `''` = unset — same contract as the rank inputs.)

- [ ] **Step 2: Add the card JSX**

Directly after the closing `</FieldGroup>` of the "Rank range (1 = best)" card (line 302), insert:

```tsx
      <FieldGroup label="Avg reviews (top-3)">
        <div className="flex gap-2">
          <input
            type="number"
            min={0}
            value={pending.reviewsMin}
            onChange={(e) => set('reviewsMin', e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && apply()}
            placeholder="Min"
            className="filter-input flex-1"
            aria-label="Minimum average reviews"
          />
          <input
            type="number"
            min={0}
            value={pending.reviewsMax}
            onChange={(e) => set('reviewsMax', e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && apply()}
            placeholder="Max (e.g. 500)"
            className="filter-input flex-1"
            aria-label="Maximum average reviews"
          />
        </div>
        <p className="text-xs text-gray-500 mt-1">
          Mean review count of the top-3 clicked products. Excludes keywords without review data.
        </p>
      </FieldGroup>
```

(`set` and `apply` are the same helpers the rank inputs use; adding the fields to `PendingFilters` makes `set('reviewsMin', …)` typecheck.)

- [ ] **Step 3: Extend the active-filter check**

In `app/(app)/explorer/page.tsx`, in `filtersAreCustomized`, directly after `f.rankMax !== null ||`:

```ts
    f.reviewsMin !== null ||
    f.reviewsMax !== null ||
```

- [ ] **Step 4: Typecheck + full test suite**

Run: `npx tsc --noEmit`
Expected: exit 0.
Run: `npx vitest run`
Expected: all suites PASS.

- [ ] **Step 5: Commit**

```bash
git add "app/(app)/explorer/FilterSidebar.tsx" "app/(app)/explorer/page.tsx"
git commit -m "feat(explorer): avg-reviews range card in filter sidebar

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Verification + prod EXPLAIN probes + ship (owner-gated; controller-run)

This task is run by the controller (browser tooling + prod access + owner gates), not a fresh implementer.

- [ ] **Step 1: Full local verification**

Run: `npx tsc --noEmit && npx vitest run`
Expected: green. Then `npx next build` — expected: builds clean.

- [ ] **Step 2: Local browser pass (dev server)**

Start the dev server via the launch config and on `/explorer`:
1. Set Max 500 in the new card, Apply → URL gains `reviews_max=500`; every visible "Avg reviews" cell ≤ 500 (no blank cells); result count changes from the default total.
2. Set Min 100 + Max 500 → both params; cells within range.
3. Clear both → params gone; default total returns.
4. Combine with "Biggest improvement (search volume)" sort → filter + sort compose.
5. Save a view with the filter active → reload from the saved view → filter restored.
6. Watchlist page unaffected.

- [ ] **Step 3: Prod EXPLAIN probes (read-only)**

Create throwaway `scripts/probeReviewsFilter0720.ts` (stays untracked):

```ts
// Throwaway (2026-07-20): EXPLAIN probes for the avg-reviews filter.
// Real literals (generic-param probes hide planner traps — vol-sort arc lesson).
import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';
import { buildExplorerQuery } from '../lib/explorer/buildQuery';
import { parseExplorerFilters } from '../lib/explorer/parseFilters';
import type { SearchParamsLike } from '../lib/explorer/parseFilters';

function literalize(sql: string, args: unknown[]): string {
  let out = sql;
  for (let i = args.length; i >= 1; i--) {
    const a = args[i - 1];
    const lit = typeof a === 'number' ? String(a) : `'${String(a).replace(/'/g, "''")}'`;
    out = out.replaceAll(`$${i}`, lit);
  }
  return out;
}

async function main() {
  const sql = neon(process.env.DATABASE_URL!);
  const [meta] = (await sql`SELECT current_week_end_date::text AS wk FROM keyword_current_summary_meta`) as Array<{ wk: string }>;
  const week = meta.wk;
  console.log('probing against week', week);

  const cases: Array<[string, SearchParamsLike]> = [
    ['max500 + best rank (broadest)', { reviews_max: '500' }],
    ['max500 + broad dept path', { reviews_max: '500', leaf: 'Health & Household › Vitamins, Minerals & Supplements' }],
    ['max500 + vol-delta imp 4w', { reviews_max: '500', sort: 'imp', window: '4w' }],
  ];
  for (const [label, params] of cases) {
    const built = buildExplorerQuery(parseExplorerFilters(params), week);
    const q = literalize(built.sql, built.args);
    // Dynamic (non-template) query: if this neon version rejects plain-string
    // calls ("tagged-template only"), switch to sql.query(...) — same result shape.
    const plan = (await sql.query(`EXPLAIN (ANALYZE, BUFFERS) ${q}`)) as Array<Record<string, string>>;
    console.log(`\n=== ${label} ===`);
    for (const row of plan) console.log(Object.values(row)[0]);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
```

Run: `node --env-file=.env.local --import tsx scripts/probeReviewsFilter0720.ts`

Before running case 2, verify the leaf path literal exists (`SELECT ... LIMIT 1` on kcs or reuse a path seen in the explorer UI) — an empty-matching path would trivially pass. Acceptance: **no Seq Scan on keyword_current_summary** in any plan; execution times in line with existing filtered queries (warm ≲1.5 s; a cold first run may be slower — re-run to judge warm). If a probe goes pathological, stop and report — the spec's fallback discussion happens with the owner before ship.

- [ ] **Step 4: Ship checkpoint (owner gates — do not proceed without explicit authorization)**

1. Present verification results + probe plans to the owner.
2. Owner tries the filter (localhost or waits for deploy).
3. Before push: `node --env-file=.env.local --import tsx scripts/checkActiveJobs.ts` (push restarts the Railway worker).
4. Push ONLY on explicit owner authorization; then watch the deploy to green and confirm on keywordquarry.com.
