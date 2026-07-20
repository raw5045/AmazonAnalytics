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
import { findJumpPreset } from '@/lib/explorer/jumpPresets';

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
 * Take a `filters` blob from the DB (jsonb) and return a fully-typed
 * ExplorerFilters with all defaults filled in. Reads stored fields
 * directly (no URL-param conversion), so `jumpMetric` is preserved
 * exactly — including for volume-preset jumps where the preset id is
 * self-describing (inferred via findJumpPreset as a cross-check).
 *
 * This is the server-side path used by loadServer.ts when hydrating a
 * saved view at page render time. It lives here (not in loadServer.ts)
 * so it can be unit-tested without the `server-only` import constraint.
 */
export function normalizeFiltersBlob(blob: unknown): ExplorerFilters {
  if (!blob || typeof blob !== 'object') return parseExplorerFilters({});
  const f = blob as Record<string, unknown>;
  const jump = (f.jump as ExplorerFilters['jump']) ?? null;
  // Infer jumpMetric from preset id when possible (so old blobs without
  // a stored jumpMetric still work after volume presets were added), then
  // fall back to the stored value, then default to 'rank'.
  let jumpMetric: ExplorerFilters['jumpMetric'] = 'rank';
  if (jump && jump !== 'custom') {
    const found = findJumpPreset(jump);
    if (found) jumpMetric = found.metric;
  } else if (f.jumpMetric === 'volume') {
    jumpMetric = 'volume';
  }
  return {
    window: (f.window as ExplorerFilters['window']) ?? '1w',
    q: typeof f.q === 'string' ? f.q : null,
    // Default to whole-word for views saved before qMode existed.
    qMode: f.qMode === 'broad' ? 'broad' : 'word',
    rankMin: typeof f.rankMin === 'number' ? f.rankMin : null,
    rankMax: typeof f.rankMax === 'number' ? f.rankMax : null,
    reviewsMin: typeof f.reviewsMin === 'number' ? f.reviewsMin : null,
    reviewsMax: typeof f.reviewsMax === 'number' ? f.reviewsMax : null,
    jump,
    jumpMetric,
    jumpFrom: typeof f.jumpFrom === 'number' ? f.jumpFrom : null,
    jumpTo: typeof f.jumpTo === 'number' ? f.jumpTo : null,
    category: typeof f.category === 'string' ? f.category : null,
    leafPaths: Array.isArray(f.leafPaths) ? (f.leafPaths as string[]) : [],
    customCategoryIds: Array.isArray(f.customCategoryIds) ? (f.customCategoryIds as string[]) : [],
    severities: Array.isArray(f.severities) ? (f.severities as ExplorerFilters['severities']) : ['none', 'warning'],
    titleSlots: Array.isArray(f.titleSlots) ? (f.titleSlots as number[]) : [1, 2, 3],
    titleMatchMode: (f.titleMatchMode as ExplorerFilters['titleMatchMode']) ?? null,
    matchMode: (f.matchMode as ExplorerFilters['matchMode']) ?? 'loose',
    sort: (f.sort as ExplorerFilters['sort']) ?? 'rank',
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
  if (f.qMode === 'broad') p.qmode = 'broad';
  if (typeof f.rankMin === 'number') p.rank_min = String(f.rankMin);
  if (typeof f.rankMax === 'number') p.rank_max = String(f.rankMax);
  if (typeof f.reviewsMin === 'number') p.reviews_min = String(f.reviewsMin);
  if (typeof f.reviewsMax === 'number') p.reviews_max = String(f.reviewsMax);
  if (typeof f.jump === 'string') p.jump = f.jump;
  if (f.jumpMetric === 'volume') p.jump_metric = 'volume';
  if (typeof f.jumpFrom === 'number') p.jump_from = String(f.jumpFrom);
  if (typeof f.jumpTo === 'number') p.jump_to = String(f.jumpTo);
  if (typeof f.category === 'string') p.category = f.category;
  if (Array.isArray(f.leafPaths) && f.leafPaths.length > 0) {
    p.leaf = f.leafPaths as string[]; // SearchParamsLike allows string[]; repeated-param shape
  }
  if (Array.isArray(f.customCategoryIds) && f.customCategoryIds.length > 0) {
    p.custom = (f.customCategoryIds as string[]).join(',');
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
