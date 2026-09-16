import type { SearchParamsLike } from '../parseFilters';
import type { ExplorerFilters } from '../types';
import { filtersToSearchParams } from '@/lib/savedViews/validation';

/**
 * URLSearchParams → the `SearchParamsLike` shape parseExplorerFilters expects
 * (Next hands pages the same shape: repeated keys become string arrays).
 */
export function searchParamsToLike(params: URLSearchParams): SearchParamsLike {
  const like: SearchParamsLike = {};
  for (const key of new Set(params.keys())) {
    const all = params.getAll(key);
    like[key] = all.length > 1 ? all : all[0];
  }
  return like;
}

/**
 * The effective explorer filters as a query string the export route parses
 * back with parseExplorerFilters — pagination dropped. The page computes this
 * from its already-resolved filters, so a `?view=<id>` bookmark exports the
 * saved view's filters without the route re-resolving saved views.
 */
export function filtersToQueryString(filters: ExplorerFilters): string {
  const like = filtersToSearchParams(filters as unknown as Record<string, unknown>);
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(like)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) v.forEach((vv) => params.append(k, vv));
    else params.set(k, v);
  }
  return params.toString();
}
