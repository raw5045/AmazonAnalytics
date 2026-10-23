// lib/products/replayQuery.ts
/**
 * Reads a recorded slow-search string (slow_queries.query_string; spec 2026-10-23 §5b) back into the search it describes,
 * for the replay in tests/integration/productsQueries.test.ts. Pure, so that replay and the unit tests run the same code.
 * A recorded string is the Products page's URL form (productFiltersToSearchParams), plus, from the search_products tool, a
 * `leaf` per taxonomy selection, one comma-joined `custom` and a `leafExact` per exact leaf path (toolQueryString in
 * lib/research/products.ts). A string the recorder cut (recordSlowProductSearch in ./slowQueries, past
 * QUERY_STRING_MAX_CHARS) ends with its ` ...[+N chars]` marker.
 */
import { pageCategoryScope, type ProductCategoryScope } from './categoryPredicate';
import { parseProductFilters, type ProductFilters, type SearchParamsLike } from './filters';

/** The marker the recorder appends to a string it cut; slowQueries.test.ts pins the two together. */
const CUT_MARKER = / \.\.\.\[\+\d+ chars\]$/;

/** A recorded string, read for a replay. */
export interface RecordedProductSearch {
  /** The page filters, parsed as the list page parses its URL. */
  filters: ProductFilters;
  /** The tool's exact leaf paths (leafExact, which the page has no form for), de-duplicated. */
  leafExact: string[];
  /** The recorder cut the string: its scope is partial, so the search cannot be reproduced. */
  cut: boolean;
}

/** A query string's parameters in the shape Next hands a page its searchParams, which parseProductFilters reads: a repeated key (leaf) becomes a list. */
function toSearchParamsLike(sp: URLSearchParams): SearchParamsLike {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of sp) {
    const seen = out[key];
    out[key] = seen === undefined ? value : Array.isArray(seen) ? [...seen, value] : [seen, value];
  }
  return out;
}

/**
 * The search a recorded string describes: its leafExact values taken out first, so the parser sees the page's own string,
 * and the rest parsed as the list page parses its URL (a bad value falls back to its default, as there). `cut` is read off
 * the raw string; a caller replays nothing when it is set.
 */
export function parseRecordedProductSearch(query: string): RecordedProductSearch {
  const params = new URLSearchParams(query);
  const leafExact = [...new Set(params.getAll('leafExact'))];
  params.delete('leafExact');
  return { filters: parseProductFilters(toSearchParamsLike(params)), leafExact, cut: CUT_MARKER.test(query) };
}

/**
 * The category scope a replay searches with: the page's (pageCategoryScope: the department, the leaf picks as subtrees, the
 * custom categories' stored paths exact; a fresh object), with the leafExact paths added to the exact ones and scoped when
 * any were given.
 */
export function scopeForReplay(filters: ProductFilters, customPaths: readonly string[], leafExact: readonly string[]): ProductCategoryScope {
  const page = pageCategoryScope(filters, customPaths);
  return { ...page, exactPaths: [...new Set([...customPaths, ...leafExact])], scoped: page.scoped || leafExact.length > 0 };
}
