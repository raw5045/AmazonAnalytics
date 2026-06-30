import 'server-only';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { customCategories } from '@/db/schema';

/** Pure: union base paths with each row's leafPaths, deduped + sorted. */
export function mergeCustomPaths(base: string[], rows: Array<{ leafPaths: string[] }>): string[] {
  const set = new Set(base);
  for (const r of rows) for (const n of r.leafPaths) set.add(n);
  return [...set].sort((a, b) => a.localeCompare(b));
}

/**
 * Expand selected custom-category IDs (for one user) into full category paths
 * and union with `basePaths`. Unknown/deleted IDs are silently skipped.
 */
export async function expandCustomCategories(
  userId: string,
  ids: string[],
  basePaths: string[],
): Promise<string[]> {
  if (ids.length === 0) return basePaths;
  const rows = await db
    .select({ leafPaths: customCategories.leafPaths })
    .from(customCategories)
    .where(and(eq(customCategories.userId, userId), inArray(customCategories.id, ids)));
  return mergeCustomPaths(basePaths, rows.map((r) => ({ leafPaths: (r.leafPaths as string[]) ?? [] })));
}
