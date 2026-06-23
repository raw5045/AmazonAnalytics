import 'server-only';
import { eq, desc } from 'drizzle-orm';
import { db } from '@/db/client';
import { customCategories } from '@/db/schema';

export interface CustomCategoryDTO {
  id: string;
  name: string;
  leafNames: string[];
  createdAt: string;
  updatedAt: string;
}

/** Map a custom_categories row → the API DTO. Shared by the loader + the routes. */
export function rowToDTO(r: typeof customCategories.$inferSelect): CustomCategoryDTO {
  return {
    id: r.id,
    name: r.name,
    leafNames: (r.leafNames as string[]) ?? [],
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
