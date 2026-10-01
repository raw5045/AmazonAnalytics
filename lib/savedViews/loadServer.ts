/**
 * Server-side helpers for loading saved views during page.tsx render.
 * These are NOT for client/API use — they assume an authenticated
 * user context already established by the caller.
 */
import 'server-only';
import { eq, and, desc } from 'drizzle-orm';
import { db } from '@/db/client';
import { savedViews } from '@/db/schema';
import { isUuid } from '@/lib/db/uuid';
import { normalizeFiltersBlob } from '@/lib/savedViews/validation';
import type { SavedView } from './types';

/** A saved_views row → the typed SavedView the app and the MCP tools share (filters normalised from the stored blob). */
export function rowToSavedView(r: typeof savedViews.$inferSelect): SavedView {
  return { id: r.id, name: r.name, filters: normalizeFiltersBlob(r.filters), createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString() };
}

/**
 * Every one of the user's saved views, newest first — deliberately NOT capped at
 * MAX_VIEWS_PER_USER. The cap is enforced on create (lib/savedViews/commands.ts);
 * two creates in the same instant can both pass its count-then-insert check and
 * leave a sixth view, which must stay visible to the picker and to the MCP's
 * list_saved_views so it can be deleted (arc-3 final review, 2026-10-01). Stored
 * `filters` JSON is normalised so callers get a fully-populated typed object even
 * if the blob predates newer fields.
 */
export async function listSavedViewsForUser(userId: string): Promise<SavedView[]> {
  const rows = await db
    .select()
    .from(savedViews)
    .where(eq(savedViews.userId, userId))
    .orderBy(desc(savedViews.createdAt));

  return rows.map(rowToSavedView);
}

/**
 * Fetch a single view by id, scoped to the user. Returns null if not
 * found or not owned (we never leak existence — caller treats both
 * as the same "view not available" outcome).
 */
export async function loadSavedViewForUser(userId: string, viewId: string): Promise<SavedView | null> {
  if (!isUuid(viewId)) return null;
  const [row] = await db
    .select()
    .from(savedViews)
    .where(and(eq(savedViews.id, viewId), eq(savedViews.userId, userId)))
    .limit(1);
  if (!row) return null;
  return rowToSavedView(row);
}

