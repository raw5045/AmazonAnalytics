'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import type { WindowKey } from '@/lib/explorer/types';

const WINDOWS: Array<{ value: WindowKey; label: string }> = [
  { value: '1w', label: 'Week' },
  { value: '4w', label: 'Month' },
  { value: '13w', label: '3 Months' },
  { value: '26w', label: '6 Months' },
  { value: '52w', label: 'Year' },
];

/**
 * Tiny URL-driven window selector for /watchlist. Mirrors the explorer
 * sidebar's `window` filter but is the only filter on the watchlist
 * page (in-watchlist filtering is deferred per Plan 3.4.1).
 */
export function WindowSelector({ current }: { current: WindowKey }) {
  const router = useRouter();
  const sp = useSearchParams();
  const onChange = (next: WindowKey) => {
    const params = new URLSearchParams();
    // Preserve only the params that the watchlist page actually reads.
    // (page.tsx consumes `window` + `sort`; in-watchlist filtering for
    // `match_mode` is deferred.)
    const sort = sp?.get('sort');
    if (sort) params.set('sort', sort);
    if (next !== '1w') params.set('window', next);
    const qs = params.toString();
    router.push(qs ? `/watchlist?${qs}` : '/watchlist');
  };

  return (
    <label className="inline-flex items-center gap-2 text-sm">
      <span className="text-gray-600">Window:</span>
      <select
        value={current}
        onChange={(e) => onChange(e.target.value as WindowKey)}
        className="border border-gray-300 rounded px-2 py-1 text-sm bg-white"
      >
        {WINDOWS.map((w) => (
          <option key={w.value} value={w.value}>
            {w.label}
          </option>
        ))}
      </select>
    </label>
  );
}
