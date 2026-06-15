/**
 * Server-side helpers for loading saved views during page.tsx render.
 * These are NOT for client/API use — they assume an authenticated
 * user context already established by the caller.
 */
import 'server-only';
import { eq, and, desc } from 'drizzle-orm';
import { db } from '@/db/client';
import { savedViews } from '@/db/schema';
import { MAX_VIEWS_PER_USER, normalizeFiltersBlob } from '@/lib/savedViews/validation';
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

