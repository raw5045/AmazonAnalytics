# Explorer slow-filter UX retrospective — for second opinion

Context: this picks up after the explorer perf RFC. The earlier work
(predicate injection + facets + count short-circuits) cleanly fixed
the cold-open and the common "default landing" / "category-only" cases.

But complex filter combinations (anything beyond those two
short-circuit shapes) still hit a live COUNT(*) that takes 8-11 seconds
on cold Neon. Three attempts to fix the **UX** of that wait failed,
and we reverted. Looking for a sanity check on the diagnosis and
the proposed next-attempt shape.

## State of play (kept, working)

These all shipped and are working:

- `current_week_end_date` predicate injection from `keyword_current_summary_meta` → unlocked `kcs_rank_idx` for sorted output. Default rows query: 5320ms cold → 36ms warm.
- Migration 0021: `snapshot_version uuid`, `default_severity_total int` on meta + new `keyword_current_summary_category_facets` table.
- `refreshSummary` atomically populates facets + bumps snapshot_version inside the stage-and-swap transaction.
- `listCategories` reads from facets instead of `SELECT DISTINCT … FROM kcs` (5290ms cold → ~80ms).
- COUNT short-circuits in `runQuery`:
  - **Default landing** (no filters beyond default severity) → `defaultSeverityTotal` from meta (0ms).
  - **Category-only + default severity** → facet row by `(snapshot_version, category)` (0ms).
- Cold default-landing handler time: ~5290ms → ~480ms. Verified end-to-end.

## What remained slow

Filters outside the two short-circuit shapes — e.g., **`rank_max=100000` + `category=Health & Personal Care` + `title_match=all`** — still need a live `COUNT(*)` that, on cold Neon, takes **8–11 seconds**.

Production measurement of this exact filter:

```
server handler total:  1474ms
↳ meta lookup:           88ms
↳ rows query:          1385ms
↳ count query (live): 11028ms
↳ listCategories:        79ms
```

So the rows query was already fast (~1.5s warm-ish), but the count
dominated total request latency at 11s.

## What we tried (now reverted)

### Attempt E: drop `JOIN search_terms` in the COUNT subquery when `q` isn't set
- Pure SQL change. When no search-term-text filter is active, search_terms isn't referenced in the WHERE, so the JOIN was pure overhead (10001 PK lookups on search_terms, random reads on cold Neon).
- Low risk; covered by two new tests.
- Unclear whether this alone helped because we shipped it bundled with F.

### Attempt F: split runQuery into rows + count, Suspense-stream the count

```ts
// Page: kick off count, but don't await
const countPromise = runExplorerCount(filters);
const [rowsResult, categoriesTimed] = await Promise.all([
  runExplorerRows(filters),
  categoriesPromise,
]);

return (
  <>
    <ResultsTable rows={rowsResult.rows} />
    <Suspense fallback={<HeaderSkeleton />}>
      <ResultsHeader countPromise={countPromise} />
    </Suspense>
    <Suspense fallback={<PaginationSkeleton />}>
      <PaginationSection countPromise={countPromise} />
    </Suspense>
  </>
);
```

- Idea: table renders at 1.5s; pagination/header skeleton in place; the count fills in at 11s. User can interact with the table while waiting.
- `runExplorerCount` and `runExplorerRows` share a `cache()`-memoized `fetchMeta()` so they don't double-hit the meta table.

### Attempt: drop `useTransition` from the Apply button

```ts
// Before
const [isPending, startTransition] = useTransition();
const apply = () => {
  startTransition(() => {
    router.replace(qs ? `/explorer?${qs}` : '/explorer', { scroll: false });
  });
};

// After
const apply = () => {
  router.replace(qs ? `/explorer?${qs}` : '/explorer', { scroll: false });
};
```

- Rationale: React docs say transitions keep the *previous* UI rendered until the new render is fully ready, including nested Suspense. So our F-attempt Suspense fallbacks were being hidden behind the transition.
- Removed startTransition entirely. Expected `loading.tsx` (already exists for `/explorer`, with a thin blue progress bar) to fire instead.

## What the user reported

After all three changes shipped (E + F + transition-removal):

> "I couldn't tell when I clicked the button and there was no loading bar at the top either. Eventually after probably 5 seconds the screen changed to what I filtered for and this is what the stats said."

i.e.:
- No "Applying…" indicator (removed with useTransition)
- No `loading.tsx` top bar (didn't fire)
- Old default-filter table stayed visible for ~5 seconds
- Then everything appeared at once

Stats showed the new state was correct (count=11028ms, source=live), and the server handler total was 1474ms — so the rows path *did* complete at 1.5s — but the user perceived a single "wait, then jump" rather than streaming.

That's strictly worse than what we had before (which at least gave a button-level "Applying…" feedback during the 11-second wait).

## Why I think it didn't work — my hypotheses, ranked

1. **The Suspense fallbacks never flushed to the browser.** Reasoning: the page returned its top-level HTML at ~1.5s, but the browser still showed the old page for ~5s. If Suspense streaming were working, the browser would have replaced the old page at ~1.5s with the new shell + skeleton fallbacks. Either:
   - Next.js's same-route soft-navigation behavior doesn't replace the previous UI until the new render's top-level Promise resolves, OR
   - Vercel's serverless runtime is buffering the response somewhere between the Node handler and the browser, OR
   - The streaming chunks are flushing but the browser isn't painting them (HTML stream parsing in the browser usually needs explicit `</body>` or sufficient buffer to start painting).

2. **`loading.tsx` doesn't fire for same-segment query-param navigation.** Plausible per my reading of the Next.js docs — `loading.tsx` is triggered when the route segment changes, and `/explorer` → `/explorer?…` doesn't change the segment. If that's the rule, removing `useTransition` doesn't gain us a top progress bar. The current page just sits there until ready.

3. **The `useTransition` analysis was correct but incomplete.** Transitions do keep the previous UI; removing them should expose Suspense fallbacks. But if Next is *also* not flushing the partial HTML to the browser, both the transition AND Next are masking the new render. Removing one didn't unmask it.

I don't have hard evidence for any of these — the user described UX, not network-level behavior. To confirm, we'd need to inspect the browser's Network tab during an Apply: TTFB, chunk arrival times, and whether the response is `chunked` transfer encoding.

## What I'd try next if we revisit

Three candidates, ranked by how confident I am they'd work:

### Option G (high confidence) — client-side count fetch after hydration
- Page server-renders rows + a skeleton in the pagination footer.
- After the page hydrates on the client, a `useEffect` (or `useSWR` / React Query) fires a `GET /api/explorer/count?…` request.
- The footer fills in when that request resolves.
- Keeps `useTransition` on Apply for the button-level "Applying…" feedback.
- Doesn't depend on Suspense/transition semantics at all — pure separation of concerns.
- Cost: one new API route, one client component, ~1 hour.
- Trade-off: extra HTTP request on every page view (mostly fast because of the short-circuits).

### Option A (medium confidence, simpler) — skip COUNT for complex filters, show "Many results"
- Detect when filters fall outside the short-circuit shapes (no `defaultSeverityTotal` or facet match).
- Skip the live COUNT(*) entirely.
- Render `Showing 1–100 of many` or `Showing 1–100, many more →` in the footer.
- Pagination works structurally (we know there are >100 if exactly 100 rows came back; there's a next page if `rowsReturned === perPage`).
- Cost: trivial — short-circuit + footer UI update, ~30 min.
- Trade-off: no precise total for complex filters. May be totally fine — power users who apply 3+ filters often don't care about the exact count.

### Option H (low confidence, more work) — precompute additional facet combinations
- Materialize counts for `(category, severity, has_title_gap)` cross-product at refresh time.
- Becomes a small-ish table; the cross product hits combinatorial explosion fast.
- Hard to know which combinations to precompute without usage data.
- I'd skip this unless we see specific filter combinations dominating real traffic.

## My recommendation if we revisit

**Start with G** (client-side count). It sidesteps the streaming/transition rabbit hole entirely, gives the user table + Applying-button feedback within ~1.5s, and the count fills in async without blocking anything.

Fall back to **A** if G is too much engineering and "Many results" is acceptable UX.

Avoid retrying F (Suspense streaming for count) unless we have direct evidence — via Network tab inspection — that Suspense streaming chunks are reaching the browser progressively in this Vercel + Next 16 setup. The model assumption may not match what's actually happening.

## What could influence the eventual fix

The user mentioned upcoming features that might shape this:

- **Saved Views (Plan 3.4):** if a saved view captures a specific filter combination, we could precompute its count at refresh time, regardless of complexity. Saved views become naturally cheap.
- **Watchlists / alerts:** also benefit from precomputed counts for the watched filter shape.
- **Admin / settings page:** could surface a "responsiveness debug" view that shows the actual count timing per filter combination, helping us identify which complex filters are worth precomputing.

So an interim "skip COUNT for complex filters" might be the right move while saved views land — saved views naturally cover the most-used complex filters with cheap precomputed counts, leaving truly-ad-hoc filters as the only ones without a precise count, which is acceptable.

## Question for review

1. Does the diagnosis (Suspense streaming chunks not flushing to the browser in this setup) match your model of how App Router + Vercel behave?
2. Is Option G the right shape, or is there a server-side streaming approach we should retry first (with better instrumentation)?
3. Anything about same-route soft-navigation in Next.js 16 that we should be aware of? Specifically: does `loading.tsx` fire for query-param-only navigation, or only for route-segment changes?
