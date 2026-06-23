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

export async function listCustomCategoriesForUser(userId: string): Promise<CustomCategoryDTO[]> {
  const rows = await db
    .select()
    .from(customCategories)
    .where(eq(customCategories.userId, userId))
    .orderBy(desc(customCategories.createdAt));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    leafNames: (r.leafNames as string[]) ?? [],
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
}
