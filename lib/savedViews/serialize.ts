/**
 * Helpers for moving filters between three representations:
 *   1. ExplorerFilters (typed object)
 *   2. SearchParamsLike (URL-param shape, what Next.js gives us)
 *   3. URL string (what the user sees / saves)
 *
 * Also handles "merge a baseline (saved view) with URL overrides" for
 * the `?view=<uuid>` URL contract.
 */
import { parseExplorerFilters, type SearchParamsLike } from '@/lib/explorer/parseFilters';
import type { ExplorerFilters } from '@/lib/explorer/types';

/**
 * Convert a structured ExplorerFilters into a URL-param-shape object.
 * Symmetric with parseExplorerFilters: parseExplorerFilters(filtersToSearchParams(f))
 * round-trips a normalized filter object (with defaults filled in).
 *
 * Mirrors what FilterSidebar.pendingToParams writes to URL.
 */
export function filtersToSearchParams(f: ExplorerFilters): SearchParamsLike {
  const p: SearchParamsLike = {};
  if (f.window) p.window = f.window;
  if (f.q) p.q = f.q;
  if (f.rankMin !== null) p.rank_min = String(f.rankMin);
  if (f.rankMax !== null) p.rank_max = String(f.rankMax);
  if (f.jump) p.jump = f.jump;
  if (f.jumpFrom !== null) p.jump_from = String(f.jumpFrom);
  if (f.jumpTo !== null) p.jump_to = String(f.jumpTo);
  if (f.category) p.category = f.category;
  if (f.leafCategories.length > 0) p.leaf = f.leafCategories.join(',');
  if (f.severities.length > 0) p.severity = f.severities.join(',');
  if (f.titleSlots.length > 0) p.titles = f.titleSlots.join(',');
  if (f.titleMatchMode) p.title_match = f.titleMatchMode;
  if (f.matchMode) p.match_mode = f.matchMode;
  if (f.sort) p.sort = f.sort;
  return p;
}

/**
 * Merge a saved view's filters (baseline) with URL params (overrides).
 *
 * Strategy: serialize the view's filters to URL-param shape, then
 * overlay any URL params on top (URL wins per key). Run the combined
 * shape through parseExplorerFilters so defaulting + validation
 * happens uniformly.
 *
 * Known v1 limitation: omitting a URL param means "use baseline",
 * not "explicitly cleared". The FilterSidebar always emits the full
 * filter set explicitly when a view is loaded (see usage notes), so
 * users can clear a filter that was set in the baseline — the URL
 * will carry the empty value explicitly.
 */
export function mergeViewWithUrlParams(
  viewFilters: ExplorerFilters,
  urlParams: SearchParamsLike,
): ExplorerFilters {
  const baseline = filtersToSearchParams(viewFilters);
  // URL params overlay baseline. For string values present in both,
  // URL wins. Empty strings from URL (e.g., `?leaf=`) survive
  // (representing "cleared by user") because they're truthy keys in
  // the spread.
  const merged: SearchParamsLike = { ...baseline, ...urlParams };
  // Exclude the `view` tag itself — it's metadata, not a filter.
  delete merged.view;
  return parseExplorerFilters(merged);
}

/**
 * Construct a `/explorer?…` href that fully applies a saved view +
 * tags the URL with `view=<id>`. Used by the dropdown when the user
 * picks a view.
 */
export function buildViewHref(view: { id: string; filters: ExplorerFilters }): string {
  const sp = filtersToSearchParams(view.filters);
  const params = new URLSearchParams();
  params.set('view', view.id);
  for (const [k, v] of Object.entries(sp)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) v.forEach((x) => params.append(k, x));
    else params.set(k, v);
  }
  return `/explorer?${params.toString()}`;
}

/**
 * Deep-equality check for "are these two filter sets the same?"
 * Used to derive the `isModified` indicator on the saved-views
 * dropdown. Ignores pagination (page, perPage) which never count as
 * meaningful differences.
 */
export function filtersEqual(a: ExplorerFilters, b: ExplorerFilters): boolean {
  // Normalize via JSON, but sort array fields so order doesn't matter
  const norm = (f: ExplorerFilters) => ({
    window: f.window,
    q: f.q,
    rankMin: f.rankMin,
    rankMax: f.rankMax,
    jump: f.jump,
    jumpFrom: f.jumpFrom,
    jumpTo: f.jumpTo,
    category: f.category,
    leafCategories: [...f.leafCategories].sort(),
    severities: [...f.severities].sort(),
    titleSlots: [...f.titleSlots].sort(),
    titleMatchMode: f.titleMatchMode,
    matchMode: f.matchMode,
    sort: f.sort,
  });
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}
