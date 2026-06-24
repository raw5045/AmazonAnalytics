/**
 * Tiny perf instrumentation strip rendered at the top of /explorer.
 *
 * Shows per-layer server-side timings so we can tell whether a slow
 * page load is dominated by:
 *   - the meta lookup (current_week_end_date)
 *   - the main rows query
 *   - the COUNT(*) bail-out
 *   - the categories DISTINCT scan (cached separately)
 *   - the rest of the server handler (render + serialization)
 *
 * Doesn't capture Vercel function cold-start cost (that happens
 * before the handler runs) — but together with the user's
 * perceived total page time, the gap between (handler total) and
 * (perceived total) is exactly the Vercel + Neon-compute cold-start
 * overhead. That gap is the deciding factor for whether app-level
 * caching can help.
 *
 * Renders as a small <details> bar — collapsed by default so it
 * doesn't clutter the page; expand for the breakdown.
 */
export interface PerfStripData {
  /** Server-handler total: from page entry to data ready. */
  handlerTotalMs: number;
  /** Meta-row lookup (current_week_end_date for the fast-path predicate). */
  metaLookupMs: number;
  /** Main paged SELECT. */
  rowsMs: number;
  /** Bail-out COUNT(*) capped at 10001 (0 when short-circuited via meta/facet). */
  countMs: number;
  /**
   * Wall-clock for the listCategories() call. Reads from
   * keyword_current_summary_category_facets (post migration 0021) —
   * a small PK lookup, usually <50ms.
   */
  categoriesMs: number;
  /** True if the fast-path predicate was applied (meta row found). */
  usedPredicate: boolean;
  /**
   * Where the COUNT came from. 'meta' = default-landing total
   * precomputed on meta. 'facet' = category-only count precomputed
   * on facets. 'live' = ran the bail-out COUNT(*). 'deferred' = count
   * was not run on the hot path; it streams in via <DeferredResultCount>
   * (so countMs reads 0 here).
   */
  countSource: 'live' | 'meta' | 'facet' | 'deferred';
  /** Categories cache heuristic — fast = cache hit, slow = miss. */
  categoriesCacheHint: 'fast' | 'slow';
}

export function PerfStrip({ data }: { data: PerfStripData }) {
  const countLabel = data.countSource === 'live'
    ? `count=${data.countMs}ms (live)`
    : `count=0ms (${data.countSource})`;

  const summary = [
    `total=${data.handlerTotalMs}ms`,
    `meta=${data.metaLookupMs}ms`,
    `rows=${data.rowsMs}ms`,
    countLabel,
    `categories=${data.categoriesMs}ms${data.categoriesCacheHint === 'fast' ? ' (cached)' : ' (cold)'}`,
    data.usedPredicate ? 'predicate=on' : 'predicate=off',
  ].join(' · ');

  const heavy = data.handlerTotalMs > 1000;

  return (
    <details className={`text-xs ${heavy ? 'text-red-700' : 'text-gray-500'} mb-2`}>
      <summary className="cursor-pointer select-none font-mono">
        perf · {summary}
      </summary>
      <div className="mt-2 ml-4 font-mono text-gray-600 space-y-0.5">
        <Row label="server handler total" value={data.handlerTotalMs} />
        <Row label="  ↳ meta lookup" value={data.metaLookupMs} />
        <Row label="  ↳ rows query" value={data.rowsMs} />
        <Row label="  ↳ count query" value={data.countMs} note={data.countSource} />
        <Row label="  ↳ listCategories" value={data.categoriesMs} note={data.categoriesCacheHint} />
        <Row
          label="  ↳ remainder (render + serialization + unsequenced overhead)"
          value={
            data.handlerTotalMs -
            Math.max(data.metaLookupMs + data.rowsMs, data.metaLookupMs + data.countMs) -
            data.categoriesMs
          }
        />
        <div className="mt-2 text-gray-500">
          fast-path predicate: <span className="text-gray-700">{data.usedPredicate ? 'on' : 'off'}</span>
          {' · '}
          Note: this is server-handler time only. Browser-perceived total also
          includes Vercel function cold-start, Neon compute warm-up, network,
          and rendering — usually 0.2-2s on cold, near-zero on warm.
        </div>
      </div>
    </details>
  );
}

function Row({ label, value, note }: { label: string; value: number; note?: string }) {
  return (
    <div className="flex">
      <span className="flex-1">{label}</span>
      <span className="tabular-nums">{value}ms</span>
      {note && <span className="ml-2 text-gray-400">({note})</span>}
    </div>
  );
}
