import 'server-only';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { customCategories } from '@/db/schema';

/** Pure: union base leaf names with each row's leafNames, deduped + sorted. */
export function mergeCustomLeaves(base: string[], rows: Array<{ leafNames: string[] }>): string[] {
  const set = new Set(base);
  for (const r of rows) for (const n of r.leafNames) set.add(n);
  return [...set].sort((a, b) => a.localeCompare(b));
}

/**
 * Expand selected custom-category IDs (for one user) into leaf names and union
 * with `baseLeaves`. Unknown/deleted IDs are silently skipped (graceful).
 */
export async function expandCustomCategories(
  userId: string,
  ids: string[],
  baseLeaves: string[],
): Promise<string[]> {
  if (ids.length === 0) return baseLeaves;
  const rows = await db
    .select({ leafNames: customCategories.leafNames })
    .from(customCategories)
    .where(and(eq(customCategories.userId, userId), inArray(customCategories.id, ids)));
  return mergeCustomLeaves(baseLeaves, rows.map((r) => ({ leafNames: (r.leafNames as string[]) ?? [] })));
}
