'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';

/**
 * Top-level navigation: Explorer | Watchlist (N).
 *
 * Server-rendered text but client-side for usePathname() so the active
 * tab gets styled correctly without a full page reload after navigation.
 *
 * Remembers the most recent /explorer URL (including filter query
 * params) so switching to the Watchlist tab and back returns you to
 * the same filter state — instead of resetting to defaults. Stored in
 * localStorage, scoped per-browser.
 *
 * Detail-page URLs (/explorer/keyword/[id]) are intentionally NOT
 * remembered — clicking the Explorer tab from a detail page should
 * return to the keyword list, not back to the same detail page.
 */
const LAST_EXPLORER_URL_KEY = 'kw-analytics.last-explorer-url';

export function TabNav({ watchlistCount }: { watchlistCount: number }) {
  const pathname = usePathname() ?? '';
  const searchParams = useSearchParams();
  const isExplorer = pathname === '/explorer' || pathname.startsWith('/explorer/');
  const isWatchlist = pathname === '/watchlist' || pathname.startsWith('/watchlist/');
  const isCategoryBuilder = pathname === '/category-builder' || pathname.startsWith('/category-builder/');

  // Tracks the URL the Explorer tab should navigate to. Starts as the
  // bare /explorer (so SSR + first paint match), then useEffect updates
  // it from localStorage after mount. Brief race window where a click in
  // the first ~16ms after navigation could land on /explorer — fine.
  const [explorerHref, setExplorerHref] = useState<string>('/explorer');

  useEffect(() => {
    // On the keyword list page (/explorer, NOT /explorer/keyword/*),
    // record the current URL so we can return to it later.
    if (pathname === '/explorer') {
      const qs = searchParams?.toString() ?? '';
      const current = qs ? `/explorer?${qs}` : '/explorer';
      try { localStorage.setItem(LAST_EXPLORER_URL_KEY, current); } catch {}
      setExplorerHref(current);
      return;
    }
    // Anywhere else (/watchlist, /explorer/keyword/*) — pick up the
    // remembered URL so the Explorer tab restores the user's filters.
    try {
      const saved = localStorage.getItem(LAST_EXPLORER_URL_KEY);
      if (saved) setExplorerHref(saved);
    } catch {}
  }, [pathname, searchParams]);

  return (
    <nav className="flex items-center gap-6">
      <Link
        href={explorerHref}
        className={`text-base font-semibold whitespace-nowrap ${
          isExplorer ? 'text-gray-900' : 'text-gray-500 hover:text-gray-900'
        }`}
      >
        Explorer
      </Link>
      <Link
        href="/watchlist"
        className={`text-base font-semibold whitespace-nowrap ${
          isWatchlist ? 'text-gray-900' : 'text-gray-500 hover:text-gray-900'
        }`}
      >
        Watchlist {watchlistCount > 0 && (
          <span className={`ml-0.5 text-sm font-normal ${
            isWatchlist ? 'text-gray-600' : 'text-gray-400'
          }`}>
            ({watchlistCount})
          </span>
        )}
      </Link>
      <Link
        href="/category-builder"
        className={`text-base font-semibold whitespace-nowrap ${
          isCategoryBuilder ? 'text-gray-900' : 'text-gray-500 hover:text-gray-900'
        }`}
      >
        Category Builder
      </Link>
    </nav>
  );
}
