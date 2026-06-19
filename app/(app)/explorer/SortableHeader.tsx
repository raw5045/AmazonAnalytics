'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';
import type { SortKey } from '@/lib/explorer/types';
import { LoadingOverlay } from './LoadingOverlay';

/**
 * Clickable column header that toggles between two sort values.
 * Renders inside a regular <th>. Each sortable column shows a faint ↕
 * chevron at rest; the active column shows a solid ↑ or ↓ in blue.
 *
 * Clicking the header navigates to a new URL with the updated `sort`
 * param + page reset to 1, preserving all other filter params.
 *
 * Toggle logic:
 *   - If currentSort === ascKey  → next = descKey
 *   - If currentSort === descKey → next = ascKey
 *   - Otherwise (not sorting by this column) → next = firstClickKey
 *     (each column picks a sensible default first-click direction —
 *     e.g. clicking "Δ" first time wants Biggest improvement, not
 *     Biggest decline)
 */
export function SortableHeader({
  label,
  ascKey,
  descKey,
  firstClickKey,
  currentSort,
  align = 'left',
  title,
  className = '',
}: {
  label: string;
  ascKey: SortKey;
  descKey: SortKey;
  /** Sort key applied on first click (when no current sort matches this column). */
  firstClickKey: SortKey;
  currentSort: SortKey;
  align?: 'left' | 'right' | 'center';
  title?: string;
  className?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const isAsc = currentSort === ascKey;
  const isDesc = currentSort === descKey;
  const isActive = isAsc || isDesc;

  const handleClick = () => {
    const nextSort: SortKey = isAsc ? descKey : isDesc ? ascKey : firstClickKey;
    const params = new URLSearchParams(searchParams?.toString() ?? '');
    params.set('sort', nextSort);
    params.delete('page'); // changing sort with a deep page offset is confusing
    // Stay on the current page (/explorer or /watchlist) — usePathname()
    // returns string | null; fall back to /explorer if null.
    const basePath = pathname ?? '/explorer';
    startTransition(() => {
      router.replace(`${basePath}?${params.toString()}`, { scroll: false });
    });
  };

  // Layout: label + arrow icon. Arrow is to the right of the label
  // for left-aligned and center-aligned cells; to the LEFT of the
  // label for right-aligned cells (so the number column stays
  // visually right-aligned and the arrow doesn't push the text).
  const alignClass = align === 'right' ? 'justify-end' : align === 'center' ? 'justify-center' : 'justify-start';

  return (
    <th className={`p-0 ${className}`} title={title}>
      <button
        type="button"
        onClick={handleClick}
        disabled={isPending}
        className={`w-full px-2 py-2 flex items-center gap-1 ${alignClass} cursor-pointer hover:bg-gray-100 transition-colors ${isPending ? 'opacity-60' : ''}`}
      >
        {align === 'right' && <ArrowIcon isAsc={isAsc} isDesc={isDesc} />}
        <span>{label}</span>
        {align !== 'right' && <ArrowIcon isAsc={isAsc} isDesc={isDesc} />}
      </button>
      <LoadingOverlay show={isPending} />
    </th>
  );
}

function ArrowIcon({ isAsc, isDesc }: { isAsc: boolean; isDesc: boolean }) {
  if (isAsc) {
    return <span className="text-blue-700 font-bold" aria-label="Sorted ascending">↑</span>;
  }
  if (isDesc) {
    return <span className="text-blue-700 font-bold" aria-label="Sorted descending">↓</span>;
  }
  return <span className="text-gray-300" aria-label="Sortable">↕</span>;
}
