/**
 * Pure total-resolution helpers for runExplorerQuery, split out so they
 * carry no env/neon import and can be unit-tested directly.
 */
import { COUNT_CAP, sortUsesVolumeDelta } from './buildQuery';
import { EXPLORER_DEFAULTS } from './parseFilters';
import type { ExplorerFilters, SeverityKey } from './types';

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

/**
 * Severity defaults match parseFilters.ts EXPLORER_DEFAULTS.severities.
 * The precomputed counts (default_severity_total, default_severity_count
 * on facets) only apply when severities match this exact set.
 */
function isDefaultSeverity(severities: SeverityKey[]): boolean {
  const def = [...EXPLORER_DEFAULTS.severities].sort();
  const cur = [...severities].sort();
  return def.length === cur.length && def.every((s, i) => s === cur[i]);
}

/** True when none of the Keepa-aggregate filters are set. */
function noKeepaFilters(f: ExplorerFilters): boolean {
  return f.leafPaths.length === 0;
}

/**
 * True when the filter set is "default landing": no narrowing filters
 * beyond the default severity, and the sort is not a volume-delta sort
 * (imp/decline bypass precomputed totals). Lets us skip the live
 * COUNT(*) and use the precomputed total on meta.
 */
export function canUseDefaultTotal(f: ExplorerFilters): boolean {
  // Volume-delta sorts filter rows by eligibility — precomputed totals overcount.
  return (
    !sortUsesVolumeDelta(f.sort)
    && f.q === null
    && f.rankMin === null
    && f.rankMax === null
    && f.reviewsMin === null
    && f.reviewsMax === null
    && f.wordsMin === null
    && f.wordsMax === null
    && f.jump === null
    && f.category === null
    && f.titleMatchMode === null
    && isDefaultSeverity(f.severities)
    && noKeepaFilters(f)
  );
}

/**
 * True when the filter set is "broad-category-only + default severity":
 * exactly one broad category filter, no other narrowing, and the sort is
 * not a volume-delta sort (imp/decline bypass precomputed totals). Lets
 * us use the per-category precomputed count from facets.
 */
export function canUseCategoryFacet(f: ExplorerFilters): boolean {
  // Volume-delta sorts filter rows by eligibility — precomputed totals overcount.
  return (
    !sortUsesVolumeDelta(f.sort)
    && f.q === null
    && f.rankMin === null
    && f.rankMax === null
    && f.reviewsMin === null
    && f.reviewsMax === null
    && f.wordsMin === null
    && f.wordsMax === null
    && f.jump === null
    && f.category !== null
    && f.titleMatchMode === null
    && isDefaultSeverity(f.severities)
    && noKeepaFilters(f)
  );
}

/**
 * True when the filter set is "single category-path-only + default
 * severity": exactly ONE category-path filter, no broad cat, no other
 * narrowing, and the sort is not a volume-delta sort (imp/decline bypass
 * precomputed totals). Lets us use the precomputed leaf-facet count.
 * Multi-path selections fall through to the live COUNT(*) path.
 */
export function canUseLeafCategoryFacet(f: ExplorerFilters): boolean {
  // Volume-delta sorts filter rows by eligibility — precomputed totals overcount.
  return (
    !sortUsesVolumeDelta(f.sort)
    && f.q === null
    && f.rankMin === null
    && f.rankMax === null
    && f.reviewsMin === null
    && f.reviewsMax === null
    && f.wordsMin === null
    && f.wordsMax === null
    && f.jump === null
    && f.category === null
    && f.leafPaths.length === 1
    && f.titleMatchMode === null
    && isDefaultSeverity(f.severities)
  );
}
