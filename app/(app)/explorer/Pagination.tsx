'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState, useTransition, type FormEvent } from 'react';

/**
 * Client component — Prev / Next links plus a jump-to-page input.
 * Uses router.replace (not push) so the back button doesn't fill up
 * with every pagination step.
 */
export function Pagination({
  page,
  perPage,
  total,
  totalIsCapped,
}: {
  page: number;
  perPage: number;
  total: number;
  totalIsCapped?: boolean;
}) {
  const router = useRouter();
  const sp = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const [jumpInput, setJumpInput] = useState(String(page));

  if (total <= perPage) return null;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const prevPage = page > 1 ? page - 1 : null;
  const nextPage = page < totalPages ? page + 1 : null;

  const goTo = (target: number) => {
    const params = new URLSearchParams(sp?.toString());
    if (target === 1) params.delete('page');
    else params.set('page', String(target));
    startTransition(() => {
      router.replace(`/explorer?${params.toString()}`, { scroll: true });
    });
  };

  const submitJump = (e: FormEvent) => {
    e.preventDefault();
    const target = parseInt(jumpInput, 10);
    if (Number.isFinite(target) && target >= 1 && target <= totalPages) {
      goTo(target);
    } else {
      setJumpInput(String(page));
    }
  };

  return (
    <nav className="mt-4 flex items-center gap-3 text-sm">
      <button
        type="button"
        onClick={() => prevPage !== null && goTo(prevPage)}
        disabled={prevPage === null}
        className="px-2 py-1 border rounded disabled:opacity-40 disabled:cursor-not-allowed hover:bg-gray-50"
      >
        ‹ Prev
      </button>
      <span className="text-gray-600">
        Page {page.toLocaleString()} of {totalPages.toLocaleString()}{totalIsCapped ? '+' : ''}
      </span>
      <button
        type="button"
        onClick={() => nextPage !== null && goTo(nextPage)}
        disabled={nextPage === null}
        className="px-2 py-1 border rounded disabled:opacity-40 disabled:cursor-not-allowed hover:bg-gray-50"
      >
        Next ›
      </button>
      <form onSubmit={submitJump} className="flex items-center gap-1 ml-4">
        <label htmlFor="jump-page" className="text-xs text-gray-600">
          Jump to:
        </label>
        <input
          id="jump-page"
          type="number"
          min={1}
          max={totalPages}
          value={jumpInput}
          onChange={(e) => setJumpInput(e.target.value)}
          className="w-20 border rounded px-2 py-1 text-sm"
        />
      </form>
      {isPending && <span className="text-xs text-gray-400">Loading…</span>}
    </nav>
  );
}
