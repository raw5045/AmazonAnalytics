/**
 * Shared custom-category commands (spec 2026-09-30 §6.2): the API routes and the MCP workspace
 * service both call these. Results, never HTTP responses; every message is the sentence the
 * routes returned before this module existed, verbatim. Leaf modes (replace/add/remove) are
 * resolved by the workspace service before calling `updateCustomCategory` with the full list.
 */
import 'server-only';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { customCategories } from '@/db/schema';
import { rowToDTO, type CustomCategoryDTO } from './loadServer';
import { MAX_CUSTOM_CATEGORIES, MAX_LEAF_PATHS_PER_CATEGORY, isUniqueViolation, isValidUuid, normalizePaths, validateName } from './validation';

export type CustomCategoryCommandCode =
  | 'invalid_id' | 'invalid_name' | 'no_leaves' | 'too_many_leaves' | 'nothing_to_update' | 'cap_reached' | 'duplicate_name' | 'not_found';
export type CustomCategoryResult<T> = ({ ok: true } & T) | { ok: false; code: CustomCategoryCommandCode; message: string };

const fail = (code: CustomCategoryCommandCode, message: string) => ({ ok: false as const, code, message });
const tooManyLeaves = () => fail('too_many_leaves', `A category can include at most ${MAX_LEAF_PATHS_PER_CATEGORY.toLocaleString()} leaves.`);

export async function createCustomCategory(userId: string, input: { name: unknown; leafPaths: unknown }): Promise<CustomCategoryResult<{ category: CustomCategoryDTO }>> {
  const nameResult = validateName(input.name);
  if (!nameResult.ok) return fail('invalid_name', nameResult.error);
  const leafPaths = normalizePaths(input.leafPaths);
  if (leafPaths.length === 0) return fail('no_leaves', 'Add at least one leaf category before saving.');
  if (leafPaths.length > MAX_LEAF_PATHS_PER_CATEGORY) return tooManyLeaves();
  // Cap. COUNT-then-insert is not atomic (spec §8.7): a soft cap, accepted.
  const [{ n }] = await db.select({ n: sql<number>`COUNT(*)::int` }).from(customCategories).where(eq(customCategories.userId, userId));
  if (n >= MAX_CUSTOM_CATEGORIES) return fail('cap_reached', `You've reached the ${MAX_CUSTOM_CATEGORIES}-category limit. Delete one to add another.`);
  try {
    const [created] = await db.insert(customCategories).values({ userId, name: nameResult.name, leafPaths }).returning();
    return { ok: true, category: rowToDTO(created) };
  } catch (e) {
    if (isUniqueViolation(e)) return fail('duplicate_name', `You already have a category named "${nameResult.name}".`);
    throw e;
  }
}

export async function updateCustomCategory(userId: string, id: string, input: { name?: unknown; leafPaths?: unknown }): Promise<CustomCategoryResult<{ category: CustomCategoryDTO }>> {
  if (!isValidUuid(id)) return fail('invalid_id', 'invalid category id');
  const updates: { name?: string; leafPaths?: string[]; updatedAt: Date } = { updatedAt: new Date() };
  let name: string | undefined;
  if (input.name !== undefined) {
    const nameResult = validateName(input.name);
    if (!nameResult.ok) return fail('invalid_name', nameResult.error);
    name = nameResult.name;
    updates.name = name;
  }
  if (input.leafPaths !== undefined) {
    const leafPaths = normalizePaths(input.leafPaths);
    if (leafPaths.length === 0) return fail('no_leaves', 'A category needs at least one leaf.');
    if (leafPaths.length > MAX_LEAF_PATHS_PER_CATEGORY) return tooManyLeaves();
    updates.leafPaths = leafPaths;
  }
  if (updates.name === undefined && updates.leafPaths === undefined) return fail('nothing_to_update', 'nothing to update');
  try {
    const [updated] = await db.update(customCategories).set(updates).where(and(eq(customCategories.id, id), eq(customCategories.userId, userId))).returning();
    if (!updated) return fail('not_found', 'Not found');
    return { ok: true, category: rowToDTO(updated) };
  } catch (e) {
    if (isUniqueViolation(e)) return fail('duplicate_name', `You already have a category named "${name ?? ''}".`);
    throw e;
  }
}

export async function deleteCustomCategory(userId: string, id: string): Promise<CustomCategoryResult<{ deleted: { id: string; name: string; leafCount: number } }>> {
  if (!isValidUuid(id)) return fail('invalid_id', 'invalid category id');
  const [deleted] = await db
    .delete(customCategories)
    .where(and(eq(customCategories.id, id), eq(customCategories.userId, userId)))
    .returning({ id: customCategories.id, name: customCategories.name, leafPaths: customCategories.leafPaths });
  if (!deleted) return fail('not_found', 'Not found');
  return { ok: true, deleted: { id: deleted.id, name: deleted.name, leafCount: Array.isArray(deleted.leafPaths) ? deleted.leafPaths.length : 0 } };
}
