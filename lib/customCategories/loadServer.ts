import 'server-only';
import { and, eq, desc } from 'drizzle-orm';
import { db } from '@/db/client';
import { customCategories } from '@/db/schema';
import { isValidUuid } from './validation';

export interface CustomCategoryDTO {
  id: string;
  name: string;
  leafPaths: string[];
  createdAt: string;
  updatedAt: string;
}

/** Map a custom_categories row → the API DTO. Shared by the loader + the routes. */
export function rowToDTO(r: typeof customCategories.$inferSelect): CustomCategoryDTO {
  return {
    id: r.id,
    name: r.name,
    leafPaths: (r.leafPaths as string[]) ?? [],
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export async function listCustomCategoriesForUser(userId: string): Promise<CustomCategoryDTO[]> {
  const rows = await db
    .select()
    .from(customCategories)
    .where(eq(customCategories.userId, userId))
    .orderBy(desc(customCategories.createdAt));
  return rows.map(rowToDTO);
}

/** One category by id, scoped to the owner; null when missing, foreign or malformed (never leaks existence). */
export async function loadCustomCategoryForUser(userId: string, id: string): Promise<CustomCategoryDTO | null> {
  if (!isValidUuid(id)) return null;
  const [row] = await db
    .select()
    .from(customCategories)
    .where(and(eq(customCategories.id, id), eq(customCategories.userId, userId)))
    .limit(1);
  return row ? rowToDTO(row) : null;
}
