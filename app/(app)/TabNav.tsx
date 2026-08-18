'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { Suspense, use, useEffect, useState } from 'react';

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
 *
 * The watchlist badge count arrives as a promise and streams in via
 * <Suspense> (see WatchlistBadge) so it never blocks the nav render.
 */
const LAST_EXPLORER_URL_KEY = 'kw-analytics.last-explorer-url';

export function TabNav({ watchlistCountPromise }: { watchlistCountPromise: Promise<number> }) {
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

  // Navy-bar tabs (2026-07 reskin): active = white with an amber underline
  // pinned to the bar's bottom edge; inactive = slate, brightens on hover.
  const tabClass = (active: boolean) =>
    `relative flex h-full items-center whitespace-nowrap px-1 text-sm font-semibold ${
      active
        ? 'text-white after:absolute after:inset-x-0 after:bottom-0 after:h-[3px] after:rounded-t after:bg-amber-300'
        : 'text-slate-300 hover:text-white'
    }`;

  return (
    <nav className="flex h-full items-stretch gap-6">
      <Link href={explorerHref} className={tabClass(isExplorer)}>
        Explorer
      </Link>
      <Link href="/watchlist" className={tabClass(isWatchlist)}>
        Watchlist{' '}
        <Suspense fallback={null}>
          <WatchlistBadge countPromise={watchlistCountPromise} active={isWatchlist} />
        </Suspense>
      </Link>
      <Link href="/category-builder" className={tabClass(isCategoryBuilder)}>
        Category Builder
      </Link>
      {/* Lives in the marketing layout (/help) — never matches an app
          pathname, so it never shows the active underline. Intentional. */}
      <Link href="/help" className={tabClass(false)}>
        Tutorials
      </Link>
    </nav>
  );
}

/**
 * Streams in the watchlist count from a server-provided promise so the badge
 * never blocks the nav (or the page) on its COUNT(*). Rendered inside a
 * <Suspense fallback={null}> in the Watchlist link; hidden when the count is 0.
 */
function WatchlistBadge({ countPromise, active }: { countPromise: Promise<number>; active: boolean }) {
  const count = use(countPromise);
  if (count <= 0) return null;
  return (
    <span className={`ml-0.5 text-sm font-normal ${active ? 'text-slate-300' : 'text-slate-500'}`}>
      ({count})
    </span>
  );
}
