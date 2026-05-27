/**
 * Validation helpers for the saved-views API.
 *
 * Filter values are validated by re-running them through
 * parseExplorerFilters — any malformed value silently falls back to
 * the default in that function, so we don't need separate schema
 * validation. Name validation is straightforward.
 */
import { parseExplorerFilters, type SearchParamsLike } from '@/lib/explorer/parseFilters';
import type { ExplorerFilters } from '@/lib/explorer/types';

export const MAX_VIEWS_PER_USER = 5;
export const MAX_NAME_LENGTH = 80;

export function validateName(raw: unknown): { ok: true; name: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') return { ok: false, error: 'name must be a string' };
  const name = raw.trim();
  if (name.length === 0) return { ok: false, error: 'name cannot be empty' };
  if (name.length > MAX_NAME_LENGTH) {
    return { ok: false, error: `name cannot exceed ${MAX_NAME_LENGTH} characters` };
  }
  return { ok: true, name };
}

/**
 * Run an incoming `filters` blob through parseExplorerFilters so any
 * malformed values are normalized to defaults. Returns a fresh
 * ExplorerFilters object (minus pagination, which we drop on save).
 *
 * Accepts either a SearchParamsLike-style object (string values) or a
 * mostly-typed ExplorerFilters object from the client.
 */
export function normalizeFilters(raw: unknown): ExplorerFilters {
  if (!raw || typeof raw !== 'object') {
    return parseExplorerFilters({});
  }
  // Convert structured ExplorerFilters → URL-param-shape, run through
  // parseExplorerFilters, then strip pagination. This applies the
  // exact same defaulting/validation logic the URL path uses.
  const params = filtersToSearchParams(raw as Record<string, unknown>);
  const parsed = parseExplorerFilters(params);
  return {
    ...parsed,
    page: 1,
    perPage: 100,
  };
}

/**
 * Convert a structured ExplorerFilters-like object back into the
 * URL-param shape that parseExplorerFilters expects. Mirrors what
 * FilterSidebar.pendingToParams does, in reverse.
 */
function filtersToSearchParams(f: Record<string, unknown>): SearchParamsLike {
  const p: SearchParamsLike = {};
  if (typeof f.window === 'string') p.window = f.window;
  if (typeof f.q === 'string' && f.q.length > 0) p.q = f.q;
  if (typeof f.rankMin === 'number') p.rank_min = String(f.rankMin);
  if (typeof f.rankMax === 'number') p.rank_max = String(f.rankMax);
  if (typeof f.jump === 'string') p.jump = f.jump;
  if (typeof f.jumpFrom === 'number') p.jump_from = String(f.jumpFrom);
  if (typeof f.jumpTo === 'number') p.jump_to = String(f.jumpTo);
  if (typeof f.category === 'string') p.category = f.category;
  if (Array.isArray(f.leafCategories) && f.leafCategories.length > 0) {
    p.leaf = (f.leafCategories as string[]).join(',');
  }
  if (Array.isArray(f.severities) && f.severities.length > 0) {
    p.severity = (f.severities as string[]).join(',');
  }
  if (Array.isArray(f.titleSlots) && f.titleSlots.length > 0) {
    p.titles = (f.titleSlots as number[]).join(',');
  }
  if (typeof f.titleMatchMode === 'string') p.title_match = f.titleMatchMode;
  if (typeof f.matchMode === 'string') p.match_mode = f.matchMode;
  if (typeof f.sort === 'string') p.sort = f.sort;
  return p;
}
