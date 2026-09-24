'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { Suspense, use, useEffect, useSyncExternalStore } from 'react';

/**
 * Top-level navigation: Explorer | Watchlist (N) | Category Builder |
 * Connect AI (only when showConnectAi is true) | Tutorials.
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

// The remembered URL is read from localStorage via useSyncExternalStore
// instead of being copied into state from an effect (which the
// react-hooks/set-state-in-effect rule rejects). Every render re-reads
// the snapshot, and the only same-tab writer is this component's own
// effect below — its value is in place before the next render — so
// there is nothing to subscribe to and the subscription is a no-op.
// The server snapshot is null: the server render and the hydrating
// client render both show the bare /explorer, and React re-renders with
// the real value right after hydration.
const subscribeToNothing = () => () => {};
const getServerSnapshot = () => null;
function readLastExplorerUrl(): string | null {
  try {
    return localStorage.getItem(LAST_EXPLORER_URL_KEY);
  } catch {
    return null;
  }
}

export function TabNav({
  watchlistCountPromise,
  showConnectAi,
}: {
  watchlistCountPromise: Promise<number>;
  showConnectAi: boolean;
}) {
  const pathname = usePathname() ?? '';
  const searchParams = useSearchParams();
  const isExplorer = pathname === '/explorer' || pathname.startsWith('/explorer/');
  const isWatchlist = pathname === '/watchlist' || pathname.startsWith('/watchlist/');
  const isCategoryBuilder = pathname === '/category-builder' || pathname.startsWith('/category-builder/');
  const isConnectAi = pathname === '/connect-ai' || pathname.startsWith('/connect-ai/');

  // Where the Explorer tab points. On the keyword list page (/explorer,
  // NOT /explorer/keyword/*) that's the current URL, which the effect
  // below also records. Anywhere else (/watchlist, /explorer/keyword/*)
  // it's the remembered URL, so the tab restores the user's filters.
  const onExplorerList = pathname === '/explorer';
  const qs = searchParams?.toString() ?? '';
  const currentExplorerUrl = qs ? `/explorer?${qs}` : '/explorer';
  const lastExplorerUrl = useSyncExternalStore(subscribeToNothing, readLastExplorerUrl, getServerSnapshot);
  const explorerHref = onExplorerList ? currentExplorerUrl : lastExplorerUrl || '/explorer';

  useEffect(() => {
    if (!onExplorerList) return;
    try {
      localStorage.setItem(LAST_EXPLORER_URL_KEY, currentExplorerUrl);
    } catch {}
  }, [onExplorerList, currentExplorerUrl]);

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
      {showConnectAi && (
        <Link href="/connect-ai" className={tabClass(isConnectAi)}>
          Connect AI
        </Link>
      )}
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
