import { createHash } from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { and, eq, inArray, ilike } from 'drizzle-orm';
import { db } from '@/db/client';
import { customCategories } from '@/db/schema';
import { env } from '@/lib/env';
import { PATH_SEP } from '@/lib/categoryBuilder/buildTree';
import { escapeLike } from '@/lib/explorer/matchPattern';
import type { CategoryCandidate, Filters, ResolvedScope } from './contracts';
import { ResearchError } from './errors';

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
  /** Sorted by path. */
  entries: CatalogEntry[];
  byPath: Map<string, CatalogEntry>;
}

/** Pure: facet leaves → leaves + every parent prefix. */
export function buildCategoryCatalog(snapshotVersion: string, facets: Array<{ categoryPath: string; allCount: number }>): CategoryCatalog {
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
  const entries = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
  return { snapshotVersion, entries, byPath };
}

const notAvailable = () => new ResearchError('CATEGORY_NOT_AVAILABLE', 'That category is not available in the current dataset. Resolve categories again and pick from the returned candidates.');

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

/** Pure, deterministic candidate ranking with offset paging. An unknown parentPath is CATEGORY_NOT_AVAILABLE. */
export function rankCandidates(
  catalog: CategoryCatalog,
  opts: { query: string; parentPath: string | null; offset: number; limit: number },
): { candidates: CategoryCandidate[]; total: number } {
  const q = opts.query.trim().toLowerCase();
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
  scored.sort((a, b) => a.score - b.score || a.entry.path.localeCompare(b.entry.path));
  const page = scored.slice(opts.offset, opts.offset + opts.limit);
  return { candidates: page.map((s) => toTaxonomyCandidate(s.entry)), total: scored.length };
}

export interface CustomRow { id: string; leafPaths: string[] }

/** Pure: validated selections + explicit leaf paths → the deduplicated, sorted leaf set (parent §10). */
export function expandSelections(
  catalog: CategoryCatalog,
  categories: Filters['categories'],
  customRows: CustomRow[],
  maxLeaves: number,
): { leaves: string[]; scope: ResolvedScope } {
  const leaves = new Set<string>();
  for (const sel of categories.selections) {
    if (sel.kind === 'taxonomy') {
      const entry = catalog.byPath.get(sel.path);
      if (!entry) throw notAvailable();
      if (sel.includeDescendants) {
        if (entry.terminal) leaves.add(sel.path);
        const prefix = sel.path + PATH_SEP;
        for (const e of catalog.entries) if (e.terminal && e.path.startsWith(prefix)) leaves.add(e.path);
      } else {
        if (!entry.terminal) throw new ResearchError('CATEGORY_NOT_AVAILABLE', `"${sel.path}" is a parent category. Set includeDescendants to true or choose a terminal path.`);
        leaves.add(sel.path);
      }
    } else {
      const row = customRows.find((r) => r.id === sel.id);
      if (!row || row.leafPaths.length === 0) throw notAvailable();
      for (const p of row.leafPaths) leaves.add(p);
    }
  }
  for (const p of categories.leafPaths) {
    const entry = catalog.byPath.get(p);
    if (!entry || !entry.terminal) throw notAvailable();
    leaves.add(p);
  }
  const sorted = [...leaves].sort((a, b) => a.localeCompare(b));
  if (sorted.length > maxLeaves) {
    throw new ResearchError('INVALID_FILTERS', `The category scope expands to ${sorted.length} leaf categories; the limit is ${maxLeaves}. Choose a narrower branch.`, {
      details: [{ path: 'filters.categories', message: 'scope_too_large' }],
    });
  }
  const leafSetHash = sorted.length === 0 ? null : createHash('sha256').update(sorted.join('\n')).digest('hex').slice(0, 16);
  return {
    leaves: sorted,
    scope: { selections: categories.selections, expandedLeafCount: sorted.length, leafSetHash, previewPaths: sorted.slice(0, 20), previewComplete: sorted.length <= 20 },
  };
}

// ---- loaders (60 s cache keyed by snapshot; custom rows are always the caller's own) ----

const CATALOG_TTL_MS = 60_000;
let cached: { at: number; catalog: CategoryCatalog } | null = null;

export async function loadCategoryCatalog(now = Date.now()): Promise<CategoryCatalog> {
  if (cached && now - cached.at < CATALOG_TTL_MS) return cached.catalog;
  const sql = neon(env.DATABASE_URL);
  const meta = (await sql`SELECT snapshot_version::text AS sv FROM keyword_current_summary_meta WHERE singleton = true`) as Array<{ sv: string | null }>;
  const sv = meta[0]?.sv;
  if (!sv) throw new ResearchError('DATA_UNAVAILABLE', 'The keyword dataset is being refreshed; try again in a few minutes.', { retryable: true, retryAfterSeconds: 120 });
  if (cached && cached.catalog.snapshotVersion === sv) {
    cached = { at: now, catalog: cached.catalog };
    return cached.catalog;
  }
  const rows = (await sql`
    SELECT category_path, all_count
    FROM keyword_current_summary_leaf_category_facets
    WHERE snapshot_version = ${sv}::uuid
  `) as Array<{ category_path: string; all_count: number }>;
  const catalog = buildCategoryCatalog(sv, rows.map((r) => ({ categoryPath: r.category_path, allCount: r.all_count })));
  cached = { at: now, catalog };
  return catalog;
}

export async function loadCustomRows(userId: string, ids: string[]): Promise<CustomRow[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ id: customCategories.id, leafPaths: customCategories.leafPaths })
    .from(customCategories)
    .where(and(eq(customCategories.userId, userId), inArray(customCategories.id, ids)));
  return rows.map((r) => ({ id: r.id, leafPaths: (r.leafPaths as string[]) ?? [] }));
}

export async function listCustomCandidates(userId: string, query: string): Promise<CategoryCandidate[]> {
  const q = query.trim();
  const rows = await db
    .select({ id: customCategories.id, name: customCategories.name, leafPaths: customCategories.leafPaths })
    .from(customCategories)
    .where(q === '' ? eq(customCategories.userId, userId) : and(eq(customCategories.userId, userId), ilike(customCategories.name, `%${escapeLike(q)}%`)))
    .orderBy(customCategories.name);
  return rows.map((r) => ({
    kind: 'custom' as const,
    label: r.name,
    path: null,
    id: r.id,
    terminal: true,
    descendantLeafCount: null,
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

/** Search-time resolution: revalidate every reference for THIS user and expand (never a silent skip). */
export async function resolveScope(userId: string, categories: Filters['categories'], maxLeaves: number, deps: CategoryDeps): Promise<{ leaves: string[]; scope: ResolvedScope; snapshotVersion: string }> {
  const catalog = await deps.loadCatalog();
  const customIds = categories.selections.filter((s) => s.kind === 'custom').map((s) => s.id);
  const customRows = await deps.loadCustomRows(userId, customIds);
  return { ...expandSelections(catalog, categories, customRows, maxLeaves), snapshotVersion: catalog.snapshotVersion };
}
