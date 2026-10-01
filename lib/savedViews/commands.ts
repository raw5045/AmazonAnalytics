/**
 * Shared saved-view commands (spec 2026-09-30 §6.1): the API routes and the MCP workspace
 * service both call these, so a cap, a message or a duplicate-name rule can never differ
 * between the app and the AI. Commands return results, never HTTP responses; the caller maps
 * `code` to a status (routes) or a ResearchError (workspace service). Every message is the
 * sentence the routes returned before this module existed, verbatim.
 */
import 'server-only';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { savedViews } from '@/db/schema';
import { isUniqueViolation } from '@/lib/db/pgErrorCode';
import { isUuid } from '@/lib/db/uuid';
import type { ExplorerFilters } from '@/lib/explorer/types';
import { MAX_VIEWS_PER_USER, normalizeFilters, validateName } from './validation';
import { rowToSavedView } from './loadServer';
import type { SavedView } from './types';

export type SavedViewCommandCode = 'invalid_id' | 'invalid_name' | 'nothing_to_update' | 'cap_reached' | 'duplicate_name' | 'not_found';
export type SavedViewResult<T> = ({ ok: true } & T) | { ok: false; code: SavedViewCommandCode; message: string };

const fail = (code: SavedViewCommandCode, message: string) => ({ ok: false as const, code, message });

export async function createSavedView(userId: string, input: { name: unknown; filters: unknown }): Promise<SavedViewResult<{ view: SavedView }>> {
  const nameResult = validateName(input.name);
  if (!nameResult.ok) return fail('invalid_name', nameResult.error);
  const filters = normalizeFilters(input.filters);
  // Cap. COUNT-then-insert is not atomic: two simultaneous creates from one user can both
  // pass and overshoot by one. Accepted (spec §8.7) — a soft cap; the user can prune.
  const [{ n }] = await db.select({ n: sql<number>`COUNT(*)::int` }).from(savedViews).where(eq(savedViews.userId, userId));
  if (n >= MAX_VIEWS_PER_USER) {
    return fail('cap_reached', `You've reached the ${MAX_VIEWS_PER_USER}-view limit. Delete a saved view to add a new one.`);
  }
  try {
    const [created] = await db.insert(savedViews).values({ userId, name: nameResult.name, filters }).returning();
    return { ok: true, view: rowToSavedView(created) };
  } catch (e) {
    if (isUniqueViolation(e)) {
      return fail('duplicate_name', `You already have a view named "${nameResult.name}". Choose a different name or update the existing one.`);
    }
    throw e;
  }
}

export async function updateSavedView(userId: string, id: string, input: { name?: unknown; filters?: unknown }): Promise<SavedViewResult<{ view: SavedView }>> {
  if (!isUuid(id)) return fail('invalid_id', 'invalid view id');
  const updates: { name?: string; filters?: ExplorerFilters; updatedAt: Date } = { updatedAt: new Date() };
  if (input.name !== undefined) {
    const nameResult = validateName(input.name);
    if (!nameResult.ok) return fail('invalid_name', nameResult.error);
    updates.name = nameResult.name;
  }
  if (input.filters !== undefined) updates.filters = normalizeFilters(input.filters);
  if (updates.name === undefined && updates.filters === undefined) return fail('nothing_to_update', 'nothing to update');
  try {
    // Owner-scoped: a foreign id updates nothing and reads as not found (never leaks existence).
    const [updated] = await db.update(savedViews).set(updates).where(and(eq(savedViews.id, id), eq(savedViews.userId, userId))).returning();
    if (!updated) return fail('not_found', 'view not found');
    return { ok: true, view: rowToSavedView(updated) };
  } catch (e) {
    if (isUniqueViolation(e)) return fail('duplicate_name', 'You already have a view with that name.');
    throw e;
  }
}

export async function deleteSavedView(userId: string, id: string): Promise<SavedViewResult<{ deleted: { id: string; name: string } }>> {
  if (!isUuid(id)) return fail('invalid_id', 'invalid view id');
  // Owner-scoped like the update: a foreign id deletes nothing and reads as not found.
  const [deleted] = await db
    .delete(savedViews)
    .where(and(eq(savedViews.id, id), eq(savedViews.userId, userId)))
    .returning({ id: savedViews.id, name: savedViews.name });
  if (!deleted) return fail('not_found', 'view not found');
  return { ok: true, deleted };
}
