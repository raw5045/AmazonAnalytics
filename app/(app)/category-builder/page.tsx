import type { Metadata } from 'next';
import { loadCategoryTree } from '@/lib/categoryBuilder/loadTree';
import { childrenAtPath } from '@/lib/categoryBuilder/treeNav';
import { getCurrentUser } from '@/lib/auth/getCurrentUser';
import { listCustomCategoriesForUser } from '@/lib/customCategories/loadServer';
import { CategoryBuilderClient } from './CategoryBuilderClient';

export const metadata: Metadata = { title: 'Category Builder' };

export default async function CategoryBuilderPage() {
  const user = await getCurrentUser();
  const [{ tree }, categories] = await Promise.all([
    loadCategoryTree(),
    user ? listCustomCategoriesForUser(user.id) : Promise.resolve([]),
  ]);
  return (
    <div className="p-6">
      <h1 className="text-lg font-semibold text-gray-900 mb-4">Category Builder</h1>
      <CategoryBuilderClient
        rootLevel={childrenAtPath(tree, [])}
        initialCategories={categories}
        signedIn={Boolean(user)}
      />
    </div>
  );
}
