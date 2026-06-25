import type { Metadata } from 'next';
import { loadRootDepartments } from '@/lib/categoryBuilder/loadTree';
import { getCurrentUser } from '@/lib/auth/getCurrentUser';
import { listCustomCategoriesForUser } from '@/lib/customCategories/loadServer';
import { CategoryBuilderClient } from './CategoryBuilderClient';
import { PerfPanel } from '@/app/(app)/PerfPanel';
import { startHandlerTimer } from '@/lib/perf/handlerTimer';

export const metadata: Metadata = { title: 'Category Builder' };

export default async function CategoryBuilderPage() {
  const timer = startHandlerTimer();
  const user = await getCurrentUser();
  timer.mark('auth');
  const [rootLevel, categories] = await Promise.all([
    loadRootDepartments(),
    user ? listCustomCategoriesForUser(user.id) : Promise.resolve([]),
  ]);
  timer.mark('roots + categories');

  return (
    <div className="p-6">
      <h1 className="text-lg font-semibold text-gray-900 mb-4">Category Builder</h1>
      <PerfPanel
        admin={user?.role === 'admin'}
        data={{ totalMs: timer.totalMs(), steps: timer.steps }}
      />
      <CategoryBuilderClient
        rootLevel={rootLevel}
        initialCategories={categories}
        signedIn={Boolean(user)}
      />
    </div>
  );
}
