import type { Metadata } from 'next';
import { loadRootDepartments } from '@/lib/categoryBuilder/loadTree';
import { getCurrentUser } from '@/lib/auth/getCurrentUser';
import { listCustomCategoriesForUser } from '@/lib/customCategories/loadServer';
import { CategoryBuilderClient } from './CategoryBuilderClient';

export const metadata: Metadata = { title: 'Category Builder' };

export default async function CategoryBuilderPage() {
  // TEMP perf line (verifying the roots-only fix) — remove once confirmed.
  const t0 = performance.now();
  const user = await getCurrentUser();
  const t1 = performance.now();
  const [{ rootLevel }, categories] = await Promise.all([
    loadRootDepartments(),
    user ? listCustomCategoriesForUser(user.id) : Promise.resolve([]),
  ]);
  const t2 = performance.now();
  const perf =
    `auth ${(t1 - t0).toFixed(0)}ms · ` +
    `data ${(t2 - t1).toFixed(0)}ms · ` +
    `total ${(t2 - t0).toFixed(0)}ms`;
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
