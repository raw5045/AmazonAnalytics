# Explorer Deferred-Count Pagination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/explorer` load fast and never hang under heavy (multi-leaf / custom-category) filters by removing the blocking per-page `COUNT(*)`: fetch rows with an N+1 "has-next" probe, and stream the exact total in afterward as an isolated, time-bounded background query.

**Architecture:** The rows query becomes the only thing the page blocks on — it fetches `perPage + 1` rows so `hasNext` is known without a count, and the Prev/Next controls render immediately. The exact total moves into a separate async server component rendered inside a `<Suspense>` boundary (mirroring the detail page's `WeeklyHistoryTable`), backed by a count that runs on the **TCP pool with a 45s `statement_timeout`** so it is cancellable and can never hang the page or the navigation. If the count times out, the footer degrades gracefully — pagination still works from `hasNext`.

**Tech Stack:** Next.js 16 App Router (server components + Suspense streaming), Neon Postgres, dual Drizzle driver (neon-http for rows, node-postgres TCP pool for the bounded count), Vitest.

**Scope notes:**
- Only the **legacy path** (`q === null`) changes. The **q-path** (`countFromRows`, `count(*) OVER ()`) already counts in a single pass and is left untouched.
- The precomputed-total short-circuits (default landing via meta, single-leaf via facet) still return an exact total immediately — those render the count inline with **no** Suspense flash. Only the heavy live-count case is deferred.
- **Out of scope (YAGNI for v1):** caching the computed total across pages/users. Noted as a follow-up. Each page that defers recomputes the count; it's bounded and non-blocking, which is enough to kill the bug.
- This change **supersedes** the temporary `EXPLORER_SKIP_COUNT_PAGE2` probe and removes it. The `[explorer]` log line is kept (it now logs `hasNext` + `deferredCount`) so we can verify the fix in prod, then removed in a later cleanup.

---

## File Structure

**Modified:**
- `lib/explorer/buildQuery.ts` — legacy rows query: `LIMIT perPage + 1` (N+1). countSql unchanged.
- `lib/explorer/buildQuery.test.ts` — update legacy-path LIMIT assertions; add N+1 + q-path-unchanged tests.
- `lib/explorer/runQuery.ts` — split: fast rows (compute `hasNext`, defer total) + new exported `countExplorerMatches` (TCP + `statement_timeout`). Result type gains `hasNext`; `total` becomes `number | null`. Remove `skipCountProbe`.
- `app/(app)/explorer/page.tsx` — await fast query; render controls + summary immediately; render total inline when known, else inside `<Suspense>`.
- `app/(app)/explorer/Pagination.tsx` — becomes `PaginationControls`: Prev / "Page N" / Next driven by `hasNext` (no total, no jump-to). Jump-to moves into the count component.

**Created:**
- `app/(app)/explorer/ResultCount.tsx` — `ResultCountDisplay` (pure presentational: "of N · page X of M" + `<JumpToPage>`), `DeferredResultCount` (async server component → `countExplorerMatches`), `ResultCountSkeleton` (fallback).
- `app/(app)/explorer/JumpToPage.tsx` — small client "jump to page" form extracted from the old Pagination (needs `totalPages`, so it lives with the count).

---

## Task 1: buildQuery — N+1 rows for the legacy path

**Files:**
- Modify: `lib/explorer/buildQuery.ts:174` (legacy `limitParam`)
- Test: `lib/explorer/buildQuery.test.ts`

- [ ] **Step 1: Update the failing tests first**

In `lib/explorer/buildQuery.test.ts`, the legacy-path (no `q`) pagination assertions must expect `perPage + 1`. Change these:

```ts
// "returns the top-100 keywords..." (was [..., 100, 0])
expect(args).toEqual(['none', 'warning', 101, 0]);

// describe('pagination'):
it('legacy page 1 with default per_page → LIMIT 101 (N+1) OFFSET 0', () => {
  const { args } = buildExplorerQuery(baseFilters);
  expect(args.slice(-2)).toEqual([101, 0]);
});
it('legacy page 3 per_page 100 → LIMIT 101 OFFSET 200', () => {
  const { args } = buildExplorerQuery({ ...baseFilters, page: 3 });
  expect(args.slice(-2)).toEqual([101, 200]);
});
it('legacy custom per_page → LIMIT perPage+1', () => {
  const { args } = buildExplorerQuery({ ...baseFilters, page: 1, perPage: 50 });
  expect(args.slice(-2)).toEqual([51, 0]);
});
it('q-path LIMIT is unchanged (exact perPage — window count handles totals)', () => {
  const { args } = buildExplorerQuery({ ...baseFilters, q: 'wireless', perPage: 50 });
  expect(args.slice(-2)).toEqual([50, 0]);
});
```

(The combined-filters test at the bottom uses `q: 'phone case'` → q-path → its `[50, 50]` assertion stays correct and unchanged.)

- [ ] **Step 2: Run the tests, verify they fail**

Run: `pnpm vitest run lib/explorer/buildQuery.test.ts`
Expected: FAIL on the legacy `[101, 0]` / `[101, 200]` / `[51, 0]` assertions (still emitting 100/50).

- [ ] **Step 3: Make the legacy rows query N+1**

In `lib/explorer/buildQuery.ts`, in the legacy path (after the `// ---- legacy path (q is null)` comment), change the limit param. Current:

```ts
  const countArgs = [...args];
  const limitParam = next(filters.perPage);
  const offsetParam = next((filters.page - 1) * filters.perPage);
```

to:

```ts
  const countArgs = [...args];
  // N+1: fetch one extra row so the runner can derive hasNext without a COUNT.
  // The runner slices back to perPage before returning. OFFSET stays perPage-based.
  const limitParam = next(filters.perPage + 1);
  const offsetParam = next((filters.page - 1) * filters.perPage);
```

Leave the q-path block (the `if (filters.q && filters.q.length >= 3)` branch) untouched.

- [ ] **Step 4: Run the tests, verify they pass**

Run: `pnpm vitest run lib/explorer/buildQuery.test.ts`
Expected: PASS (all, including the unchanged q-path assertions).

- [ ] **Step 5: Commit**

```bash
git add lib/explorer/buildQuery.ts lib/explorer/buildQuery.test.ts
git commit -m "feat(explorer): N+1 rows fetch on the legacy query path

Fetch perPage+1 rows so the runner can derive hasNext without a separate
COUNT(*). q-path unchanged (its count(*) OVER () already counts in one pass).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: runQuery — derive hasNext, defer the total, add bounded `countExplorerMatches`

**Files:**
- Modify: `lib/explorer/runQuery.ts`

- [ ] **Step 1: Update the result type**

In `lib/explorer/runQuery.ts`, change `ExplorerQueryResult`:

```ts
interface ExplorerQueryResult {
  rows: ExplorerRow[];
  /** True when there is at least one more page after this one (from the N+1 probe). */
  hasNext: boolean;
  /**
   * Exact match total when cheaply known (precomputed meta/facet, or the
   * q-path window count). `null` when the total is DEFERRED — the heavy
   * legacy live-count case — and must be fetched separately via
   * countExplorerMatches() inside a streamed boundary.
   */
  total: number | null;
  /** Only meaningful when total !== null. */
  totalIsCapped: boolean;
  broadTimedOut?: boolean;
  volumeFit: VolumeFitMeta | null;
  timings: {
    metaLookupMs: number;
    rowsMs: number;
    countMs: number;
    usedPredicate: boolean;
    countSource: 'live' | 'meta' | 'facet' | 'deferred';
  };
}
```

- [ ] **Step 2: Remove the probe, compute hasNext, defer the live count**

In the instrumentation wrapper, delete the `skipCountProbe` line and its `logBase` field. In `runExplorerQueryInner`, change the signature back to `(filters: ExplorerFilters)` and replace the rows/count execution + total-resolution blocks.

Replace the `else` branch of the `if (isBroad)` block (the legacy execution) with:

```ts
  } else {
    // Legacy path: fetch rows only (N+1). The live count is DEFERRED to a
    // separate streamed query (countExplorerMatches); we never block on it here.
    const rowsTimed = await sqlClient
      .query(sql, args)
      .then((r) => ({ result: r, ms: Date.now() - tRowsStart }));
    rawRows = rowsTimed.result as unknown as RawRow[];
    rowsMs = rowsTimed.ms;
  }
```

After the `rawRows` is set and BEFORE the `.map`, derive hasNext + slice for the legacy path:

```ts
  // hasNext: q-path knows the exact window total (computed below); legacy path
  // uses the N+1 probe — a full extra row means there's another page.
  let hasNext: boolean;
  if (built.countFromRows || isBroad) {
    hasNext = false; // set after total is resolved (q-path/broad), see below
  } else {
    hasNext = rawRows.length > filters.perPage;
    if (hasNext) rawRows = rawRows.slice(0, filters.perPage);
  }
```

Then replace the total-resolution block with:

```ts
  let total: number | null;
  let totalIsCapped: boolean;
  if (precomputedTotal !== null) {
    ({ total, totalIsCapped } = applyCountCap(precomputedTotal));
  } else if (built.countFromRows) {
    const windowTotal = extractWindowTotal(rawRows as Array<{ total?: number | string }>);
    if (windowTotal !== null) {
      ({ total, totalIsCapped } = applyCountCap(windowTotal));
    } else {
      // Empty page (OFFSET past the end) on the q-path: one fallback count.
      const tFallback = Date.now();
      const cr = await sqlClient.query(countSql, countArgs);
      countMs = Date.now() - tFallback;
      ({ total, totalIsCapped } = applyCountCap(extractCount(cr as unknown as Array<{ total: number | string }>)));
    }
    hasNext = total !== null && filters.page * filters.perPage < total;
    countSource = 'live';
  } else {
    // Legacy live-count case → DEFER. The streamed ResultCount fetches it.
    total = null;
    totalIsCapped = false;
    countSource = 'deferred';
  }
```

(Note: the broad path's `total` resolution is the same `countFromRows` branch since broad sets `countFromRows: true`; its `hasNext` falls out of `page*perPage < total`.)

Update the final `return` to include `hasNext` and the (possibly null) `total`. Update the success `console.log` in the wrapper to log `hasNext: result.hasNext` and `deferred: result.total === null` instead of the removed probe field.

- [ ] **Step 3: Add the bounded, isolated `countExplorerMatches`**

At the bottom of `lib/explorer/runQuery.ts`, add:

```ts
/**
 * Deferred, time-bounded match count for the heavy legacy path. Runs the
 * count on the TCP pool with SET LOCAL statement_timeout = 45s so it is
 * CANCELLABLE — it can never hang the page or the navigation. Returns null on
 * timeout (57014) or any error; the caller renders a graceful "many matches"
 * footer and pagination still works from hasNext.
 *
 * Rendered from a <Suspense> boundary, so its latency streams in independently
 * of the rows. Reuses the broad-search TCP pool (getBroadPool).
 */
export async function countExplorerMatches(
  filters: ExplorerFilters,
): Promise<{ total: number; totalIsCapped: boolean } | null> {
  const sqlClient = neon(env.DATABASE_URL);
  let currentWeekEndDate: string | undefined;
  try {
    const rows = (await sqlClient`
      SELECT current_week_end_date::text AS d
      FROM keyword_current_summary_meta WHERE singleton = true
    `) as Array<{ d: string | null }>;
    currentWeekEndDate = rows[0]?.d ?? undefined;
  } catch {
    // No predicate → the count still works, just without the planner hint.
  }
  const { countSql, countArgs } = buildExplorerQuery(filters, currentWeekEndDate);
  const client = await getBroadPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL statement_timeout = 45000');
    const r = await client.query(countSql, countArgs);
    await client.query('COMMIT');
    return applyCountCap(extractCount(r.rows as unknown as Array<{ total: number | string }>));
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* connection may be dead */ }
    // 57014 = statement_timeout. Any error → best-effort: no exact count.
    if ((e as { code?: string }).code !== '57014') {
      console.warn('[explorer count] failed:', (e as Error).message);
    }
    return null;
  } finally {
    client.release();
  }
}
```

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: errors ONLY in `app/(app)/explorer/page.tsx` and `Pagination.tsx` (they consume the old `total: number` shape). Those are fixed in Tasks 3–5. No errors inside `runQuery.ts` itself.

- [ ] **Step 5: Commit**

```bash
git add lib/explorer/runQuery.ts
git commit -m "feat(explorer): defer the live count; add bounded countExplorerMatches

Legacy path returns hasNext (from N+1) + total:null (deferred). New
countExplorerMatches runs the count on the TCP pool with a 45s
statement_timeout so it is cancellable and isolated; returns null on
timeout/error. Removes the EXPLORER_SKIP_COUNT_PAGE2 probe (superseded).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: PaginationControls — Prev / Next driven by hasNext

**Files:**
- Modify: `app/(app)/explorer/Pagination.tsx`
- Create: `app/(app)/explorer/JumpToPage.tsx`

- [ ] **Step 1: Extract JumpToPage (needs totalPages → lives with the count)**

Create `app/(app)/explorer/JumpToPage.tsx`:

```tsx
'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState, useTransition, type FormEvent } from 'react';

/** Jump-to-page form. Needs totalPages, so it renders inside the (deferred)
 *  ResultCount once the exact total is known. */
export function JumpToPage({ page, totalPages }: { page: number; totalPages: number }) {
  const router = useRouter();
  const sp = useSearchParams();
  const [, startTransition] = useTransition();
  const [jumpInput, setJumpInput] = useState(String(page));

  const submitJump = (e: FormEvent) => {
    e.preventDefault();
    const target = parseInt(jumpInput, 10);
    if (Number.isFinite(target) && target >= 1 && target <= totalPages) {
      const params = new URLSearchParams(sp?.toString());
      if (target === 1) params.delete('page');
      else params.set('page', String(target));
      startTransition(() => router.replace(`/explorer?${params.toString()}`, { scroll: true }));
    } else {
      setJumpInput(String(page));
    }
  };

  return (
    <form onSubmit={submitJump} className="flex items-center gap-1 ml-4">
      <label htmlFor="jump-page" className="text-xs text-gray-600">Jump to:</label>
      <input
        id="jump-page"
        type="number"
        min={1}
        max={totalPages}
        value={jumpInput}
        onChange={(e) => setJumpInput(e.target.value)}
        className="w-20 border rounded px-2 py-1 text-sm"
      />
    </form>
  );
}
```

- [ ] **Step 2: Rewrite Pagination.tsx as PaginationControls (hasNext-driven)**

Replace the contents of `app/(app)/explorer/Pagination.tsx`:

```tsx
'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';
import { LoadingOverlay } from './LoadingOverlay';

/**
 * Prev / "Page N" / Next controls. Driven entirely by `hasNext` (from the
 * N+1 probe) so they render immediately — no total/count needed. The exact
 * "of M pages" label + jump-to render separately in the streamed ResultCount.
 */
export function PaginationControls({ page, hasNext }: { page: number; hasNext: boolean }) {
  const router = useRouter();
  const sp = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const prevAvailable = page > 1;
  if (!prevAvailable && !hasNext) return null; // single page

  const goTo = (target: number) => {
    const params = new URLSearchParams(sp?.toString());
    if (target === 1) params.delete('page');
    else params.set('page', String(target));
    startTransition(() => router.replace(`/explorer?${params.toString()}`, { scroll: true }));
  };

  return (
    <>
      <LoadingOverlay show={isPending} />
      <nav className="mt-4 flex items-center gap-3 text-sm">
        <button
          type="button"
          onClick={() => prevAvailable && goTo(page - 1)}
          disabled={!prevAvailable}
          className="px-2 py-1 border rounded disabled:opacity-40 disabled:cursor-not-allowed hover:bg-gray-50"
        >
          ‹ Prev
        </button>
        <span className="text-gray-600">Page {page.toLocaleString()}</span>
        <button
          type="button"
          onClick={() => hasNext && goTo(page + 1)}
          disabled={!hasNext}
          className="px-2 py-1 border rounded disabled:opacity-40 disabled:cursor-not-allowed hover:bg-gray-50"
        >
          Next ›
        </button>
        {isPending && <span className="text-xs text-gray-400">Loading…</span>}
      </nav>
    </>
  );
}
```

- [ ] **Step 3: Typecheck (expect only page.tsx errors remain)**

Run: `pnpm typecheck`
Expected: remaining errors only in `page.tsx` (still importing `Pagination` / passing `total`). Fixed in Task 5.

- [ ] **Step 4: Commit**

```bash
git add app/(app)/explorer/Pagination.tsx app/(app)/explorer/JumpToPage.tsx
git commit -m "feat(explorer): PaginationControls driven by hasNext; extract JumpToPage

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: ResultCount — streamed total + graceful fallback

**Files:**
- Create: `app/(app)/explorer/ResultCount.tsx`

- [ ] **Step 1: Create the count components**

Create `app/(app)/explorer/ResultCount.tsx`:

```tsx
import { countExplorerMatches } from '@/lib/explorer/runQuery';
import type { ExplorerFilters } from '@/lib/explorer/types';
import { JumpToPage } from './JumpToPage';

/** Pure presentational total + page-of-pages + jump-to. Used inline when the
 *  total is cheaply known, and by DeferredResultCount once the count resolves. */
export function ResultCountDisplay({
  total, totalIsCapped, page, perPage,
}: { total: number; totalIsCapped: boolean; page: number; perPage: number }) {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const cap = totalIsCapped ? '+' : '';
  return (
    <span className="flex items-center text-sm text-gray-600">
      <span>
        {total.toLocaleString()}{cap} matches · page {page.toLocaleString()} of{' '}
        {totalPages.toLocaleString()}{cap}
      </span>
      {totalPages > 1 && <JumpToPage page={page} totalPages={totalPages} />}
    </span>
  );
}

/** Async server component: fetches the bounded count and streams it in. On
 *  timeout/error the count is null → graceful footer (pagination still works
 *  from the Prev/Next controls). */
export async function DeferredResultCount({
  filters, page, perPage,
}: { filters: ExplorerFilters; page: number; perPage: number }) {
  const result = await countExplorerMatches(filters);
  if (!result) {
    return (
      <span className="text-sm text-gray-500">
        Many matches — narrow the filters to see an exact count.
      </span>
    );
  }
  return (
    <ResultCountDisplay
      total={result.total}
      totalIsCapped={result.totalIsCapped}
      page={page}
      perPage={perPage}
    />
  );
}

/** Suspense fallback shown while the count resolves. */
export function ResultCountSkeleton() {
  return <span className="text-sm text-gray-400 animate-pulse">counting matches…</span>;
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: no NEW errors from this file (page.tsx errors still pending Task 5).

- [ ] **Step 3: Commit**

```bash
git add app/(app)/explorer/ResultCount.tsx
git commit -m "feat(explorer): streamed ResultCount (deferred total) + graceful fallback

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: page.tsx — wire fast rows + streamed count

**Files:**
- Modify: `app/(app)/explorer/page.tsx`

- [ ] **Step 1: Swap imports**

Replace `import { Pagination } from './Pagination';` with:

```tsx
import { Suspense } from 'react';
import { PaginationControls } from './Pagination';
import { ResultCountDisplay, DeferredResultCount, ResultCountSkeleton } from './ResultCount';
```

- [ ] **Step 2: Destructure the new result shape**

Change the destructure of `queryResult` and the derived labels. Replace:

```ts
  const { rows, total, totalIsCapped, volumeFit, broadTimedOut, timings: rqTimings } = queryResult;
  const categories = categoriesTimed.result;
  const handlerTotalMs = Date.now() - handlerStartedAt;

  const totalPages = Math.max(1, Math.ceil(total / filters.perPage));
  const totalLabel = totalIsCapped
    ? `${total.toLocaleString()}+`
    : total.toLocaleString();
```

with:

```ts
  const { rows, hasNext, total, totalIsCapped, volumeFit, broadTimedOut, timings: rqTimings } = queryResult;
  const categories = categoriesTimed.result;
  const handlerTotalMs = Date.now() - handlerStartedAt;

  // Lower bound shown immediately ("Showing 101–200"); the exact total + page
  // count stream in via <ResultCount> below.
  const firstRow = rows.length === 0 ? 0 : (filters.page - 1) * filters.perPage + 1;
  const lastRow = (filters.page - 1) * filters.perPage + rows.length;
```

- [ ] **Step 3: Replace the summary line + Pagination in the JSX**

In the non-`broadTimedOut` branch, replace the summary `<p>` block and the trailing `<Pagination ... />`. The summary becomes:

```tsx
            <div className="mb-4 flex items-center justify-between">
              <div className="text-sm text-gray-600">
                {rows.length === 0 ? (
                  'No results — try removing a filter.'
                ) : total !== null ? (
                  // Cheaply-known total (default landing / single leaf / q-path): inline, no flash.
                  <span className="flex items-center gap-1">
                    <span>Showing {firstRow.toLocaleString()}–{lastRow.toLocaleString()} of</span>
                    <ResultCountDisplay total={total} totalIsCapped={totalIsCapped} page={filters.page} perPage={filters.perPage} />
                  </span>
                ) : (
                  // Heavy live-count case: rows now, exact total streams in.
                  <span className="flex items-center gap-1">
                    <span>Showing {firstRow.toLocaleString()}–{lastRow.toLocaleString()} ·</span>
                    <Suspense fallback={<ResultCountSkeleton />}>
                      <DeferredResultCount filters={queryFilters} page={filters.page} perPage={filters.perPage} />
                    </Suspense>
                  </span>
                )}
              </div>
              {filtersAreCustomized(filters) && (
                <a href="/explorer" className="text-sm underline text-gray-600">Reset filters</a>
              )}
            </div>
```

Delete the separate `{totalIsCapped && (<p>…</p>)}` "Showing the first N…" block (the cap is now shown via the `+` in `ResultCountDisplay`).

Replace `<Pagination page={filters.page} perPage={filters.perPage} total={total} totalIsCapped={totalIsCapped} />` with:

```tsx
            <PaginationControls page={filters.page} hasNext={hasNext} />
```

- [ ] **Step 4: Widen the PerfStrip countSource type**

`page.tsx` passes `countSource: rqTimings.countSource` into `<PerfStrip>`. Add `'deferred'` to the `countSource` union in `PerfStrip.tsx`'s prop type (and any label map) so it typechecks. With the count deferred, `countMs` in the main handler timing will now read 0 for heavy filters — that's expected (the count's latency lives in the streamed component, not the handler).

- [ ] **Step 5: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: clean. (Renumber the commit step below to Step 6.)

- [ ] **Step 5: Commit**

```bash
git add "app/(app)/explorer/page.tsx"
git commit -m "feat(explorer): render rows + Prev/Next immediately, stream the total

Known totals (default landing / single leaf / q-path) render inline; the
heavy live-count streams in via <Suspense>. Removes the blocking per-page
COUNT(*) from the hot path.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Cleanup + full verification

**Files:**
- Modify: any consumer/test referencing the old `total: number` result shape.

- [ ] **Step 1: Find stragglers referencing the old shape**

Run: `pnpm exec grep -rn "EXPLORER_SKIP_COUNT_PAGE2\|from './Pagination'\|\.totalIsCapped\|Pagination\b" app lib tests` (or use the editor search). Confirm no `EXPLORER_SKIP_COUNT_PAGE2` references remain and no import of the old `Pagination` symbol survives.

- [ ] **Step 2: Run the full unit suite**

Run: `pnpm vitest run` (excludes integration unless `RUN_INTEGRATION=1`)
Expected: PASS. Fix any test asserting the old `total: number` / `Pagination` shape.

- [ ] **Step 3: Typecheck + lint clean**

Run: `pnpm typecheck && pnpm lint`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore(explorer): remove count probe + fix result-shape consumers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Manual E2E + prod verification

**Files:** none (verification).

- [ ] **Step 1: Local smoke (dev)**

Run `pnpm dev`, open `/explorer`. Verify: default landing shows the exact total inline (no flash); a multi-leaf custom category shows rows + Prev/Next immediately with a "counting matches…" placeholder that resolves to "N matches · page 1 of M"; **Next** advances and disables on the last page; jump-to appears once the count resolves.

- [ ] **Step 2: Deploy + reproduce the original bug**

Merge to main → Vercel deploys. Reproduce: 194-leaf custom category, under-200k / fewest-reviews, click **Next** to page 2, then again. Expected: page 2 rows appear quickly; the total streams in or degrades to "Many matches…"; **no revert, no hang**.

- [ ] **Step 3: Confirm via logs**

In Vercel logs, the `page:2` `[explorer]` line should now be `outcome:"ok"` with a small `rowsMs` and `deferred:true` (no blocking `countMs`). The count's own latency/timeout is isolated in `countExplorerMatches`.

- [ ] **Step 4: Follow-ups (note, do not implement here)**

- Cache the computed total (snapshot + filter keyed) so pages 2+ skip the recount.
- Remove the `[explorer]` instrumentation logging once the fix is confirmed stable.
- Optional covering index for the cold rows-query footprint (separate, DDL — needs explicit approval).

---

## Self-Review

- **Spec coverage:** N+1 rows (T1), hasNext + deferred total + bounded count (T2), immediate controls (T3), streamed count + graceful fallback (T4), page wiring (T5), cleanup (T6), verify (T7). All of the agreed Design B + deferred-count behavior is covered.
- **Placeholder scan:** none — every code step shows the actual change.
- **Type consistency:** `ExplorerQueryResult` gains `hasNext: boolean` and `total: number | null` (T2); consumers updated in T3/T5; `countExplorerMatches` returns `{ total; totalIsCapped } | null`; `ResultCountDisplay` takes a non-null `total`. `countSource` union extended with `'deferred'`.
- **Risk:** the only behavioral change to non-heavy paths is N+1 on the legacy rows query (one extra row fetched, sliced off) — covered by T1 tests. q-path and precomputed short-circuits keep exact inline totals. The deferred count is fully isolated (TCP + 45s timeout) so it cannot hang the page.
