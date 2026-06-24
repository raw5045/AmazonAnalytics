'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState, useTransition, type FormEvent } from 'react';

/** Jump-to-page form. Needs totalPages, so it renders inside the (deferred)
 *  ResultCount once the exact total is known. */
export function JumpToPage({ page, totalPages }: { page: number; totalPages: number }) {
  const router = useRouter();
  const sp = useSearchParams();
  const [, startTransition] = useTransition();
  const [jumpInput, setJumpInput] = useState(String(page));

  const submitJump = (e: FormEvent) => {
    e.preventDefault();
    const target = parseInt(jumpInput, 10);
    if (Number.isFinite(target) && target >= 1 && target <= totalPages) {
      const params = new URLSearchParams(sp?.toString());
      if (target === 1) params.delete('page');
      else params.set('page', String(target));
      startTransition(() => router.replace(`/explorer?${params.toString()}`, { scroll: true }));
    } else {
      setJumpInput(String(page));
    }
  };

  return (
    <form onSubmit={submitJump} className="flex items-center gap-1 ml-4">
      <label htmlFor="jump-page" className="text-xs text-gray-600">Jump to:</label>
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
  );
}
