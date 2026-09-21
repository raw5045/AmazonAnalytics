import { createHash } from 'node:crypto';
import { withReadOnlyTx, type TxClient } from '@/lib/db/tcpPool';
import { PATH_SEP } from '@/lib/categoryBuilder/buildTree';
import { escapeLike } from '@/lib/explorer/matchPattern';
import type { CategoryCandidate, Filters, ResolvedScope } from './contracts';
import { ResearchError } from './errors';
import { researchLimits } from './limits';
import { getResearchPool } from './pool';

/**
 * Category catalog, candidate ranking, and scope expansion for the research MCP tools
 * (`resolve_categories` / `search_keywords`'s `filters.categories`).
 *
 * Contracts:
 * - The catalog IS the current snapshot's leaf category facets
 *   (`keyword_current_summary_leaf_category_facets`) plus every parent prefix implied by
 *   those leaf paths — exactly the searchable population, so no separate
 *   `asin_weekly_data` tree walk is needed and no resolved path can ever match zero rows.
 * - An empty `categories.selections` + empty `categories.leafPaths` means NO category
 *   scope (search every category) — never a failed lookup. Only a *non-empty* reference
 *   that fails to resolve is an error.
 * - Every unresolvable reference — an unknown taxonomy path, a parent path given without
 *   `includeDescendants`, an unknown/foreign/empty custom category id, or a custom
 *   category whose stored paths are all absent from the current catalog — throws
 *   `CATEGORY_NOT_AVAILABLE`. Never a silent skip: a silently dropped reference would
 *   quietly narrow the caller's search without telling them.
 * - A custom category's stored `leaf_paths` are intersected with the catalog's *terminal*
 *   paths before expansion. The weekly snapshot rotates independently of when a custom
 *   category was saved, so a stored path with no current facet row matches nothing in the
 *   downstream `top_clicked_category_path IN (...)` filter anyway — intersecting first
 *   keeps `expandedLeafCount`, the leaf cap, the preview, and the SQL IN-list all counting
 *   real, live leaves instead of stale ones.
 * - Every ordering in this module (catalog `entries`, ranking ties, the expanded `leaves`
 *   set and therefore `leafSetHash`) uses plain code-unit comparison, never
 *   `String.prototype.localeCompare`: localeCompare's default collation treats
 *   canonically-equivalent strings (e.g. the NFC and NFD forms of the same visual text) as
 *   equal, which would make ordering depend on the host's ICU data instead of being a
 *   pure, deterministic function of the input paths.
 */

/**
 * Plain code-unit ordering (`a < b ? -1 : a > b ? 1 : 0`) — see the module docstring above
 * for why this replaces `localeCompare` everywhere in this file.
 */
function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Hex characters kept from the sha256 leaf-set hash (64 → 16 = 8 bytes: plenty to catch an accidental cross-request scope mismatch without bloating the response). */
const LEAF_SET_HASH_HEX = 16;
/** Leaf paths shown inline in `ResolvedScope.previewPaths` before a caller must page/expand for the rest. */
const PREVIEW_PATHS = 20;

export interface CatalogEntry {
  path: string;
  /** A facet row exists for this exact path (keywords are filed directly under it). */
  terminal: boolean;
  keywordCount: number | null;
  /** Terminal paths strictly below this one. */
  descendantLeafCount: number;
}
export interface CategoryCatalog {
  snapshotVersion: string;
  /** The current snapshot's week-ending date (`keyword_current_summary_meta.current_week_end_date`), as YYYY-MM-DD. */
  datasetWeek: string;
  /**
   * Sorted by path (code-unit order — see the module docstring). This array, and every
   * entry in it, is frozen: the object is shared by every caller of the cached loader
   * (`loadCategoryCatalog`'s 60 s TTL cache hands the SAME instance to every concurrent
   * caller), so mutating it would corrupt every other in-flight request. Build a new
   * object instead of writing through these references.
   */
  entries: ReadonlyArray<Readonly<CatalogEntry>>;
  /**
   * Same shared, frozen-entry objects as `entries`, indexed by path for O(1) lookup.
   * `ReadonlyMap` here is a TYPE-LEVEL restriction only: `Object.freeze` on the CategoryCatalog
   * object does not reach a `Map`'s internal slots, so `.set`/`.delete`/`.clear` would still
   * work at runtime on this same instance if a caller cast past the type (unlike `entries`,
   * whose array and elements are genuinely frozen — see `buildCategoryCatalog`). Nothing in
   * this module writes to `byPath` after `buildCategoryCatalog` returns; callers must not either.
   */
  byPath: ReadonlyMap<string, Readonly<CatalogEntry>>;
}

/** Pure: facet leaves → leaves + every parent prefix. */
export function buildCategoryCatalog(meta: { snapshotVersion: string; datasetWeek: string }, facets: Array<{ categoryPath: string; allCount: number }>): CategoryCatalog {
  const byPath = new Map<string, CatalogEntry>();
  for (const f of facets) {
    const segs = f.categoryPath.split(PATH_SEP);
    for (let i = 1; i <= segs.length; i++) {
      const path = segs.slice(0, i).join(PATH_SEP);
      const entry = byPath.get(path) ?? { path, terminal: false, keywordCount: null, descendantLeafCount: 0 };
      if (i === segs.length) {
        entry.terminal = true;
        entry.keywordCount = f.allCount;
      } else {
        entry.descendantLeafCount += 1;
      }
      byPath.set(path, entry);
    }
  }
  // Freeze AFTER every mutation above is done. `entries`' elements are the SAME objects
  // held by `byPath` (not copies), so freezing them here also freezes what byPath.get()
  // returns — one pass covers both, per the frozen-catalog contract on CategoryCatalog.
  const entries: ReadonlyArray<Readonly<CatalogEntry>> = Object.freeze(
    [...byPath.values()].sort((a, b) => compareCodeUnits(a.path, b.path)).map((e) => Object.freeze(e)),
  );
  return Object.freeze({ snapshotVersion: meta.snapshotVersion, datasetWeek: meta.datasetWeek, entries, byPath });
}

const notAvailable = () => new ResearchError('CATEGORY_NOT_AVAILABLE', 'That category is not available in the current dataset. Resolve categories again and pick from the returned candidates.');

/**
 * Same error as `notAvailable()`, additionally pinpointing which `filters.categories.selections[i]`
 * / `filters.categories.leafPaths[i]` in the request was the offending one (`details`). The
 * top-level `.message` stays the same fixed, generic text for every custom-id case — never the id
 * itself — so an unknown, foreign, or empty custom category id remain indistinguishable (Q08).
 */
const notAvailableAt = (path: string) =>
  new ResearchError('CATEGORY_NOT_AVAILABLE', 'That category is not available in the current dataset. Resolve categories again and pick from the returned candidates.', {
    details: [{ path, message: 'not_available' }],
  });

function lastSegment(path: string): string {
  return path.slice(path.lastIndexOf(PATH_SEP) < 0 ? 0 : path.lastIndexOf(PATH_SEP) + PATH_SEP.length);
}

/** Lower is better; null = no match. Exact label, then label prefix, then label contains, then all tokens in label, then full path. */
function scoreEntry(entry: CatalogEntry, q: string): number | null {
  if (q === '') return 0;
  const label = lastSegment(entry.path).toLowerCase();
  const full = entry.path.toLowerCase();
  const tokens = q.split(/\s+/).filter(Boolean);
  if (label === q || full === q) return 0;
  if (label.startsWith(q)) return 1;
  if (label.includes(q)) return 2;
  if (tokens.length > 1 && tokens.every((t) => label.includes(t))) return 3;
  if (full.includes(q)) return 4;
  if (tokens.length > 1 && tokens.every((t) => full.includes(t))) return 5;
  return null;
}

export function toTaxonomyCandidate(entry: CatalogEntry): CategoryCandidate {
  return {
    kind: 'taxonomy',
    label: entry.path,
    path: entry.path,
    id: null,
    terminal: entry.terminal,
    descendantLeafCount: entry.descendantLeafCount,
    keywordCount: entry.keywordCount,
    selection: { kind: 'taxonomy', path: entry.path, includeDescendants: entry.descendantLeafCount > 0 },
  };
}

/**
 * Pure, deterministic candidate ranking with offset paging. An unknown parentPath is
 * CATEGORY_NOT_AVAILABLE. An empty query is only meaningful when browsing a given
 * parentPath (parent §10 forbids a full-taxonomy dump); resolveCategoriesInputSchema
 * already guards this at the API boundary, but this pure function enforces it too so no
 * other caller can bypass it.
 */
export function rankCandidates(
  catalog: CategoryCatalog,
  opts: { query: string; parentPath: string | null; offset: number; limit: number },
): { candidates: CategoryCandidate[]; total: number } {
  const trimmed = opts.query.trim();
  if (trimmed === '' && opts.parentPath === null) {
    throw new ResearchError('INVALID_FILTERS', 'an empty query is allowed only when browsing a parentPath', {
      details: [{ path: 'query', message: 'empty' }],
    });
  }
  const q = trimmed.toLowerCase();
  let pool = catalog.entries;
  if (opts.parentPath !== null) {
    if (!catalog.byPath.has(opts.parentPath)) throw notAvailable();
    const prefix = opts.parentPath + PATH_SEP;
    pool = pool.filter((e) => e.path.startsWith(prefix) && !e.path.slice(prefix.length).includes(PATH_SEP));
  }
  const scored: Array<{ entry: CatalogEntry; score: number }> = [];
  for (const entry of pool) {
    const score = scoreEntry(entry, q);
    if (score !== null) scored.push({ entry, score });
  }
  scored.sort((a, b) => a.score - b.score || compareCodeUnits(a.entry.path, b.entry.path));
  const page = scored.slice(opts.offset, opts.offset + opts.limit);
  return { candidates: page.map((s) => toTaxonomyCandidate(s.entry)), total: scored.length };
}

export interface CustomRow { id: string; leafPaths: string[] }

/**
 * Pure: validated selections + explicit leaf paths → the deduplicated, sorted leaf set
 * (parent §10). Every reference that fails to resolve throws `CATEGORY_NOT_AVAILABLE`
 * pinpointing its index in the request (see the module docstring and `notAvailableAt`).
 */
export function expandSelections(
  catalog: CategoryCatalog,
  categories: Filters['categories'],
  customRows: CustomRow[],
  maxLeaves: number,
): { leaves: string[]; scope: ResolvedScope } {
  const leaves = new Set<string>();
  for (let i = 0; i < categories.selections.length; i++) {
    const sel = categories.selections[i];
    const selPath = `filters.categories.selections[${i}]`;
    if (sel.kind === 'taxonomy') {
      const entry = catalog.byPath.get(sel.path);
      if (!entry) throw notAvailableAt(selPath);
      if (sel.includeDescendants) {
        if (entry.terminal) leaves.add(sel.path);
        const prefix = sel.path + PATH_SEP;
        for (const e of catalog.entries) if (e.terminal && e.path.startsWith(prefix)) leaves.add(e.path);
      } else {
        if (!entry.terminal) {
          // The path itself is public catalog data, so (unlike the custom-id cases below)
          // the message may keep quoting it.
          throw new ResearchError('CATEGORY_NOT_AVAILABLE', `"${sel.path}" is a parent category. Set includeDescendants to true or choose a terminal path.`, {
            details: [{ path: selPath, message: 'not_available' }],
          });
        }
        leaves.add(sel.path);
      }
    } else {
      const row = customRows.find((r) => r.id === sel.id);
      // Unknown, foreign (loadCustomRows already scopes rows to the caller's own userId, so
      // a foreign id is simply absent here, same as unknown), and empty (zero stored paths)
      // are deliberately indistinguishable (Q08): all three throw this same generic error.
      if (!row || row.leafPaths.length === 0) throw notAvailableAt(selPath);
      // Live paths only (module docstring): a stored path absent from the current catalog
      // matches nothing downstream anyway, so intersecting first keeps expandedLeafCount,
      // the leaf cap, the preview, and the SQL IN-list all counting real leaves.
      const live = row.leafPaths.filter((p) => catalog.byPath.get(p)?.terminal === true);
      if (live.length === 0) {
        throw new ResearchError('CATEGORY_NOT_AVAILABLE', 'None of the paths in that custom category have keywords in the current dataset.', {
          details: [{ path: selPath, message: 'not_available' }],
        });
      }
      for (const p of live) leaves.add(p);
    }
  }
  for (let i = 0; i < categories.leafPaths.length; i++) {
    const p = categories.leafPaths[i];
    const entry = catalog.byPath.get(p);
    if (!entry || !entry.terminal) throw notAvailableAt(`filters.categories.leafPaths[${i}]`);
    leaves.add(p);
  }
  const sorted = [...leaves].sort(compareCodeUnits);
  if (sorted.length > maxLeaves) {
    throw new ResearchError('INVALID_FILTERS', `The category scope expands to ${sorted.length} leaf categories; the limit is ${maxLeaves}. Choose a narrower branch.`, {
      details: [{ path: 'filters.categories', message: 'scope_too_large' }],
    });
  }
  const leafSetHash = sorted.length === 0 ? null : createHash('sha256').update(sorted.join('\n')).digest('hex').slice(0, LEAF_SET_HASH_HEX);
  return {
    leaves: sorted,
    scope: { selections: categories.selections, expandedLeafCount: sorted.length, leafSetHash, previewPaths: sorted.slice(0, PREVIEW_PATHS), previewComplete: sorted.length <= PREVIEW_PATHS },
  };
}

// ---- loaders (60 s cache keyed by snapshot; custom rows are always the caller's own) ----
// Every loader runs through the dedicated research pool under categorySqlTimeoutMs
// (amendment §3.3/§3.6): withReadOnlyTx resolves to 'timeout' on overrun, which every
// loader below turns into QUERY_TIMEOUT.

/** Runs `fn` inside a read-only transaction under the category deadline; 'timeout' on overrun. Injectable for tests. */
export type CategoryTxRunner = <T>(fn: (tx: TxClient) => Promise<T>) => Promise<T | 'timeout'>;
const defaultRunner: CategoryTxRunner = (fn) => withReadOnlyTx(getResearchPool(), researchLimits().categorySqlTimeoutMs, fn);

function timeoutError(): ResearchError {
  return new ResearchError('QUERY_TIMEOUT', 'Category lookup timed out; try again.', { retryable: true, retryAfterSeconds: 5 });
}

const CATALOG_TTL_MS = 60_000;
let cached: { at: number; catalog: CategoryCatalog } | null = null;

/** Test-only: clears the process-level catalog memo so the next loadCategoryCatalog() call re-queries. */
export function resetCategoryCatalogCacheForTests(): void {
  cached = null;
}

interface CatalogRow {
  sv: string | null;
  week: string | null;
  category_path: string | null;
  all_count: number | null;
}

/**
 * Meta + facets in ONE statement (amendment §3.3) so both come from the same snapshot — two
 * separate requests (the pre-fix-round shape) could straddle a weekly swap and cache an
 * empty catalog for the full 60 s TTL.
 *
 * Facets for a snapshot are rewritten IN PLACE, not immutable per version:
 * `worker/kcsKeepaSyncJobs.ts` Phase 3 does
 * `DELETE FROM keyword_current_summary_leaf_category_facets WHERE snapshot_version = $1` and
 * re-INSERTs under the SAME snapshot_version after every Keepa enrichment run. So past the TTL,
 * this always rebuilds from the rows the statement just returned — even when `snapshot_version`
 * is unchanged from what's cached — instead of reusing the old catalog object; a corrected
 * top_clicked_category_path from that run is picked up within one TTL window instead of being
 * masked by a same-version cache hit. Building from ~11k facets is a few ms, so the unconditional
 * rebuild costs nothing measurable.
 *
 * No meta row at all (the kill switch: the meta table truncated) always throws DATA_UNAVAILABLE.
 * A meta row whose LEFT JOIN found no facets (`category_path IS NULL`) is ambiguous between two
 * very different situations and is handled accordingly:
 *   - Genuinely no facets ever built for this snapshot_version (or nothing cached yet) —
 *     DATA_UNAVAILABLE, same as before.
 *   - The Keepa sync's DELETE→INSERT window (Phase 3 above): the meta row's snapshot_version
 *     hasn't changed, but its facets are momentarily gone mid-rebuild. If a catalog for that
 *     EXACT snapshot_version is already cached, this keeps serving it (refreshing `at`, no
 *     query-log noise) through the gap instead of surfacing a transient outage for what is, from
 *     the caller's perspective, a no-op refresh. A cached catalog for a DIFFERENT snapshot
 *     version is never served stale — that still throws DATA_UNAVAILABLE.
 */
export async function loadCategoryCatalog(now = Date.now(), run: CategoryTxRunner = defaultRunner): Promise<CategoryCatalog> {
  if (cached && now - cached.at < CATALOG_TTL_MS) return cached.catalog;
  const result = await run(async (tx) => {
    const { rows } = await tx.query<CatalogRow>(`
      SELECT m.snapshot_version::text AS sv, m.current_week_end_date::text AS week, f.category_path, f.all_count
      FROM keyword_current_summary_meta m
      LEFT JOIN keyword_current_summary_leaf_category_facets f ON f.snapshot_version = m.snapshot_version
      WHERE m.singleton = true
    `);
    return rows;
  });
  if (result === 'timeout') throw timeoutError();
  const first = result[0];
  if (!first || !first.sv) {
    throw new ResearchError('DATA_UNAVAILABLE', 'The keyword dataset is being refreshed; try again in a few minutes.', { retryable: true, retryAfterSeconds: 120 });
  }
  if (first.category_path === null) {
    // Zero facets for this exact snapshot_version. Keep serving an already-cached catalog for
    // the SAME version through the Keepa sync's DELETE→INSERT window; anything else (nothing
    // cached, or cached under a different version) is a genuine DATA_UNAVAILABLE.
    if (cached && cached.catalog.snapshotVersion === first.sv) {
      cached = { at: now, catalog: cached.catalog };
      return cached.catalog;
    }
    throw new ResearchError('DATA_UNAVAILABLE', 'The keyword dataset is being refreshed; try again in a few minutes.', { retryable: true, retryAfterSeconds: 120 });
  }
  const sv = first.sv;
  const facets = result
    .filter((r): r is CatalogRow & { category_path: string; all_count: number } => r.category_path !== null && r.all_count !== null)
    .map((r) => ({ categoryPath: r.category_path, allCount: r.all_count }));
  const catalog = buildCategoryCatalog({ snapshotVersion: sv, datasetWeek: first.week ?? '' }, facets);
  cached = { at: now, catalog };
  return catalog;
}

export async function loadCustomRows(userId: string, ids: string[], run: CategoryTxRunner = defaultRunner): Promise<CustomRow[]> {
  if (ids.length === 0) return [];
  const result = await run(async (tx) => {
    const { rows } = await tx.query<{ id: string; leaf_paths: unknown }>(
      'SELECT id, leaf_paths FROM custom_categories WHERE user_id = $1 AND id = ANY($2::uuid[])',
      [userId, ids],
    );
    return rows;
  });
  if (result === 'timeout') throw timeoutError();
  return result.map((r) => ({
    id: r.id,
    leafPaths: Array.isArray(r.leaf_paths) ? r.leaf_paths.filter((p): p is string => typeof p === 'string') : [],
  }));
}

export async function listCustomCandidates(userId: string, query: string, run: CategoryTxRunner = defaultRunner): Promise<CategoryCandidate[]> {
  const q = query.trim();
  const params: unknown[] = [userId];
  let sql = `SELECT id, name, CASE WHEN jsonb_typeof(leaf_paths) = 'array' THEN jsonb_array_length(leaf_paths) ELSE 0 END::int AS leaf_count FROM custom_categories WHERE user_id = $1`;
  if (q !== '') {
    params.push(`%${escapeLike(q)}%`);
    sql += ` AND name ILIKE $${params.length}`;
  }
  sql += ' ORDER BY name, id';
  const result = await run(async (tx) => {
    const { rows } = await tx.query<{ id: string; name: string; leaf_count: number }>(sql, params);
    return rows;
  });
  if (result === 'timeout') throw timeoutError();
  return result.map((r) => ({
    kind: 'custom' as const,
    label: r.name,
    path: null,
    id: r.id,
    terminal: true,
    descendantLeafCount: r.leaf_count,
    keywordCount: null,
    selection: { kind: 'custom' as const, id: r.id },
  }));
}

export interface CategoryDeps {
  loadCatalog: () => Promise<CategoryCatalog>;
  loadCustomRows: (userId: string, ids: string[]) => Promise<CustomRow[]>;
  listCustom: (userId: string, query: string) => Promise<CategoryCandidate[]>;
}
export const defaultCategoryDeps: CategoryDeps = { loadCatalog: () => loadCategoryCatalog(), loadCustomRows, listCustom: listCustomCandidates };

/**
 * Search-time resolution: revalidate every reference for THIS user and expand (never a
 * silent skip). `snapshotVersion`/`datasetWeek` here are the CATALOG's values — current as
 * of its last refresh, at most CATALOG_TTL_MS (60 s) stale — used for resolve_categories'
 * own provenance. The search transaction (lib/research/search.ts) stamps its own from the
 * snapshot it actually queried; the two are allowed to disagree by up to that same 60 s
 * window across a weekly swap.
 */
export async function resolveScope(
  userId: string,
  categories: Filters['categories'],
  maxLeaves: number,
  deps: CategoryDeps,
): Promise<{ leaves: string[]; scope: ResolvedScope; snapshotVersion: string; datasetWeek: string }> {
  const catalog = await deps.loadCatalog();
  const customIds = categories.selections.filter((s) => s.kind === 'custom').map((s) => s.id);
  const customRows = await deps.loadCustomRows(userId, customIds);
  return { ...expandSelections(catalog, categories, customRows, maxLeaves), snapshotVersion: catalog.snapshotVersion, datasetWeek: catalog.datasetWeek };
}
