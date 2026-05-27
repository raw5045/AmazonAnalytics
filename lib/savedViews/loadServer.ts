/**
 * Server-side helpers for loading saved views during page.tsx render.
 * These are NOT for client/API use — they assume an authenticated
 * user context already established by the caller.
 */
import 'server-only';
import { eq, and, desc } from 'drizzle-orm';
import { db } from '@/db/client';
import { savedViews } from '@/db/schema';
import { parseExplorerFilters } from '@/lib/explorer/parseFilters';
import type { ExplorerFilters } from '@/lib/explorer/types';
import { MAX_VIEWS_PER_USER } from '@/lib/savedViews/validation';
import type { SavedView } from './types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Fetch all of the user's saved views (up to MAX_VIEWS_PER_USER),
 * newest first. Stored `filters` JSON is normalized through
 * parseExplorerFilters so callers get a fully-populated typed object
 * even if the stored JSON is missing newer fields.
 */
export async function listSavedViewsForUser(userId: string): Promise<SavedView[]> {
  const rows = await db
    .select()
    .from(savedViews)
    .where(eq(savedViews.userId, userId))
    .orderBy(desc(savedViews.createdAt))
    .limit(MAX_VIEWS_PER_USER);

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    filters: normalizeFiltersBlob(r.filters),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
}

/**
 * Fetch a single view by id, scoped to the user. Returns null if not
 * found or not owned (we never leak existence — caller treats both
 * as the same "view not available" outcome).
 */
export async function loadSavedViewForUser(userId: string, viewId: string): Promise<SavedView | null> {
  if (!UUID_RE.test(viewId)) return null;
  const [row] = await db
    .select()
    .from(savedViews)
    .where(and(eq(savedViews.id, viewId), eq(savedViews.userId, userId)))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    filters: normalizeFiltersBlob(row.filters),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Take a `filters` blob from the DB (jsonb) and return a fully-typed
 * ExplorerFilters with all defaults filled in. Routes the blob
 * through parseExplorerFilters indirectly via a shape transform so
 * any missing fields default cleanly.
 */
function normalizeFiltersBlob(blob: unknown): ExplorerFilters {
  if (!blob || typeof blob !== 'object') return parseExplorerFilters({});
  const f = blob as Record<string, unknown>;
  return {
    window: (f.window as ExplorerFilters['window']) ?? '1w',
    q: typeof f.q === 'string' ? f.q : null,
    rankMin: typeof f.rankMin === 'number' ? f.rankMin : null,
    rankMax: typeof f.rankMax === 'number' ? f.rankMax : null,
    jump: (f.jump as ExplorerFilters['jump']) ?? null,
    jumpFrom: typeof f.jumpFrom === 'number' ? f.jumpFrom : null,
    jumpTo: typeof f.jumpTo === 'number' ? f.jumpTo : null,
    category: typeof f.category === 'string' ? f.category : null,
    leafCategories: Array.isArray(f.leafCategories) ? (f.leafCategories as string[]) : [],
    severities: Array.isArray(f.severities) ? (f.severities as ExplorerFilters['severities']) : ['none', 'warning'],
    titleSlots: Array.isArray(f.titleSlots) ? (f.titleSlots as number[]) : [1, 2, 3],
    titleMatchMode: (f.titleMatchMode as ExplorerFilters['titleMatchMode']) ?? null,
    matchMode: (f.matchMode as ExplorerFilters['matchMode']) ?? 'loose',
    sort: (f.sort as ExplorerFilters['sort']) ?? 'rank',
    page: 1,
    perPage: 100,
  };
}
