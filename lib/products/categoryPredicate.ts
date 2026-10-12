// lib/products/categoryPredicate.ts
/**
 * The category filter of a product search (spec 2026-10-12 §3, §4.1): one predicate over
 * asin_products.category_path, built from a ProductCategoryScope. Two producers make scopes — the
 * page (pageCategoryScope: URL filters + the custom categories expanded by the page) and the tools
 * (lib/research/products.ts: department + the categories object, validated). Pure: no I/O.
 *
 * Every path form is indexable by asin_products_category_path_idx (text_pattern_ops): with the
 * prefix bound as a plan-time constant (the custom plans neon's HTTP queries get), the planner
 * rewrites starts_with into an index range, so a subtree can be a BitmapOr of two index scans and
 * `= ANY(array)` a single index scan rather than one per path (measured 2026-10-10 up to 2,000
 * paths, spec §2/§10). A very large department or path list may legitimately send the planner to
 * the sort index instead; both plans are correct.
 */
import { PATH_SEP } from '@/lib/categoryBuilder/buildTree';
import type { ProductFilters } from './filterParams';

export interface ProductCategoryScope {
  /** A Keepa root department, matched as a subtree; null for all departments. */
  dept: string | null;
  /** Each matches the path and its descendants (the page's leaf picks; the tools' taxonomy selections that include descendants). */
  subtreePaths: readonly string[];
  /** Each matches exactly (custom categories' stored paths; the tools' leafPaths and taxonomy selections with includeDescendants false). */
  exactPaths: readonly string[];
  /** A leaf or custom selection was requested; with no paths left, the group is FALSE instead of absent. */
  scoped: boolean;
}

export const EMPTY_CATEGORY_SCOPE: Readonly<ProductCategoryScope> = Object.freeze({ dept: null, subtreePaths: Object.freeze([]), exactPaths: Object.freeze([]), scoped: false });

/** Records the value and returns its positional placeholder — the injection guarantee rests on this contract. */
type Bind = (v: unknown) => string;
const unique = (paths: readonly string[]): string[] => [...new Set(paths)];

/** The page's scope: leaf picks as subtrees, the expanded custom paths exact; scoped when either was asked for (even if the ids expanded to nothing). */
export function pageCategoryScope(f: Pick<ProductFilters, 'dept' | 'leafPaths' | 'customCategoryIds'>, customPaths: readonly string[]): ProductCategoryScope {
  return { dept: f.dept, subtreePaths: unique(f.leafPaths), exactPaths: unique(customPaths), scoped: f.leafPaths.length > 0 || f.customCategoryIds.length > 0 };
}

/** `path` itself or anything under it. Two binds: the path, then the path with the separator appended. */
const subtree = (path: string, bind: Bind): string => `(a.category_path = ${bind(path)}::text OR starts_with(a.category_path, ${bind(path + PATH_SEP)}::text))`;

/**
 * The WHERE fragment (over alias `a`), or null when the scope sets nothing. Department AND (subtrees OR
 * exact array); a scoped selection with no paths is FALSE. Binds in order of appearance: department,
 * subtree paths, then the exact-path array as one text[] parameter.
 */
export function categoryPredicate(scope: ProductCategoryScope, bind: Bind): string | null {
  const terms: string[] = [];
  if (scope.dept !== null) terms.push(subtree(scope.dept, bind));
  const group = scope.subtreePaths.map((p) => subtree(p, bind));
  if (scope.exactPaths.length > 0) group.push(`a.category_path = ANY(${bind(scope.exactPaths)}::text[])`);
  if (group.length === 1) terms.push(group[0]);
  else if (group.length > 1) terms.push(`(${group.join(' OR ')})`);
  else if (scope.scoped) terms.push('FALSE');
  return terms.length === 0 ? null : terms.join(' AND ');
}
