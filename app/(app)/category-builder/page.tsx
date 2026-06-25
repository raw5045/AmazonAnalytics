import type { Metadata } from 'next';
import { loadCategoryTree } from '@/lib/categoryBuilder/loadTree';
import { childrenAtPath } from '@/lib/categoryBuilder/treeNav';
import { getCurrentUser } from '@/lib/auth/getCurrentUser';
import { listCustomCategoriesForUser } from '@/lib/customCategories/loadServer';
import { CategoryBuilderClient } from './CategoryBuilderClient';

export const metadata: Metadata = { title: 'Category Builder' };

export default async function CategoryBuilderPage() {
  // TEMP perf instrumentation (cold-start diagnosis) — remove after measuring.
  const t0 = performance.now();
  const user = await getCurrentUser();
  const t1 = performance.now();
  const [{ tree }, categories] = await Promise.all([
    loadCategoryTree(),
    user ? listCustomCategoriesForUser(user.id) : Promise.resolve([]),
  ]);
  const t2 = performance.now();
  const rootLevel = childrenAtPath(tree, []);
  const t3 = performance.now();
  const perf =
    `auth ${(t1 - t0).toFixed(0)}ms · ` +
    `data ${(t2 - t1).toFixed(0)}ms · ` +
    `roots ${(t3 - t2).toFixed(0)}ms · ` +
    `total ${(t3 - t0).toFixed(0)}ms`;
  console.log(`[cb perf] page: ${perf}`);

  return (
    <div className="p-6">
      <h1 className="text-lg font-semibold text-gray-900 mb-4">Category Builder</h1>
      <p className="text-xs text-gray-400 mb-3 font-mono">⏱ {perf}</p>
      <CategoryBuilderClient
        rootLevel={rootLevel}
        initialCategories={categories}
        signedIn={Boolean(user)}
      />
    </div>
  );
}
