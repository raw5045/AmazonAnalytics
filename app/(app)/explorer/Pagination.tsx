'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';
import { LoadingOverlay } from './LoadingOverlay';

/**
 * Prev / "Page N" / Next controls. Driven entirely by `hasNext` (from the
 * N+1 probe) so they render immediately — no total/count needed. The exact
 * "of M pages" label + jump-to render separately in the streamed ResultCount.
 */
export function PaginationControls({ page, hasNext }: { page: number; hasNext: boolean }) {
  const router = useRouter();
  const sp = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const prevAvailable = page > 1;
  if (!prevAvailable && !hasNext) return null; // single page

  const goTo = (target: number) => {
    const params = new URLSearchParams(sp?.toString());
    if (target === 1) params.delete('page');
    else params.set('page', String(target));
    startTransition(() => router.replace(`/explorer?${params.toString()}`, { scroll: true }));
  };

  return (
    <>
      <LoadingOverlay show={isPending} />
      <nav className="mt-4 flex items-center gap-3 text-sm">
        <button
          type="button"
          onClick={() => prevAvailable && goTo(page - 1)}
          disabled={!prevAvailable}
          className="px-2 py-1 border rounded disabled:opacity-40 disabled:cursor-not-allowed hover:bg-gray-50"
        >
          ‹ Prev
        </button>
        <span className="text-gray-600">Page {page.toLocaleString()}</span>
        <button
          type="button"
          onClick={() => hasNext && goTo(page + 1)}
          disabled={!hasNext}
          className="px-2 py-1 border rounded disabled:opacity-40 disabled:cursor-not-allowed hover:bg-gray-50"
        >
          Next ›
        </button>
        {isPending && <span className="text-xs text-gray-400">Loading…</span>}
      </nav>
    </>
  );
}
