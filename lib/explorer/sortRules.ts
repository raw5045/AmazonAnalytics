/**
 * Sort rules shared by the SQL builder (buildQuery.ts) and the filter
 * sidebar's hint copy. Pure functions over SortKey with no server imports, so
 * client components may import this module without pulling the query builder
 * into their bundle. buildQuery.ts re-exports them for its existing importers.
 */
import type { SortKey } from './types';

/**
 * True when `sort` applies the Δ-volume eligibility predicate (imp/decline).
 * Every sort that adds a predicate of its own also makes precomputed totals
 * (meta/facet) WRONG — see sortHidesRows, which runQuery's count
 * short-circuits consult.
 */
export function sortUsesVolumeDelta(sort: SortKey): boolean {
  return sort === 'imp' || sort === 'decline';
}

/**
 * The nullable kcs column a sort key orders by, when sorting by it EXCLUDES
 * rows without a value (`kcs.<col> IS NOT NULL`, pushed into the WHERE by
 * buildQuery.ts's pushKcsPredicates for rows AND counts); null for every
 * other sort.
 *
 * Why exclude: kcs_avg_price_idx / kcs_avg_reviews_idx (migration 0030;
 * 0041 twins) are plain ASC btrees. Postgres pathkey-matches a forward scan
 * as `ASC NULLS LAST` and a backward scan as `DESC NULLS FIRST` — never
 * `DESC NULLS LAST`, which is what these sorts used to ask for, so the
 * planner fell back to a Parallel Seq Scan + on-disk top-N sort over all of
 * kcs (avg_reviews_desc: 23.1 s cold / 2.7 s warm on production,
 * 2026-09-22, while the asc direction ran 0.3 s / 31 ms on the index).
 * With null keys excluded, NULLS placement can no longer change the result
 * set, so buildOrderBy emits a bare ASC/DESC the index serves in both
 * directions. Applied to BOTH directions so flipping the sort never changes
 * the population or the footer total. Same rule as the research tool
 * (lib/research/query.ts, 0e2f28f: "nulls are never ranked") and the
 * imp/decline eligibility predicate; the watchlist (fetchExplorerRowsByIds)
 * never hides rows and keeps NULLS LAST.
 */
export function sortNullKeyColumn(sort: SortKey): 'avg_price_cents' | 'avg_reviews' | null {
  switch (sort) {
    case 'avg_price_asc':
    case 'avg_price_desc':
      return 'avg_price_cents';
    case 'avg_reviews_asc':
    case 'avg_reviews_desc':
      return 'avg_reviews';
    default:
      return null;
  }
}

/**
 * True when the sort adds a WHERE predicate of its own (volume-delta
 * eligibility, or null-key exclusion) — rows are hidden under it, so every
 * precomputed total (meta/facet) overcounts and the sidebar must say so.
 * queryTotals' guards and FilterSidebar's sortHint consult this.
 */
export function sortHidesRows(sort: SortKey): boolean {
  return sortUsesVolumeDelta(sort) || sortNullKeyColumn(sort) !== null;
}
