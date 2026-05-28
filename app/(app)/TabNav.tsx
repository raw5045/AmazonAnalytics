'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * Top-level navigation: Explorer | Watchlist (N).
 *
 * Server-rendered text but client-side for usePathname() so the active
 * tab gets styled correctly without a full page reload after navigation.
 */
export function TabNav({ watchlistCount }: { watchlistCount: number }) {
  const pathname = usePathname() ?? '';
  const isExplorer = pathname === '/explorer' || pathname.startsWith('/explorer/');
  const isWatchlist = pathname === '/watchlist' || pathname.startsWith('/watchlist/');

  return (
    <nav className="flex items-center gap-6">
      <Link
        href="/explorer"
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
    </nav>
  );
}
