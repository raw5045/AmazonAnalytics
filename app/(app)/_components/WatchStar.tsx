'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * A small star button for use in table cells. Two visual states:
 *   ☆ unwatched   ★ watched
 *
 * Click toggles via POST or DELETE. Optimistic UI — flips instantly,
 * reverts on error.
 *
 * - On the explorer results table: clicking ☆ adds to watchlist.
 * - On the watchlist page: clicking ★ removes from watchlist. The parent
 *   removes the row from its local state on success (via onToggleSuccess).
 *
 * On failure — especially the 100-keyword cap (409) — it shows its own small
 * inline message anchored to the star, since the explorer results table is a
 * Server Component and can't pass a client error handler. A parent may still
 * pass onError to handle it differently (e.g. a future toast).
 */
export function WatchStar({
  keywordId,
  initialIsWatched,
  onToggleSuccess,
  onError,
}: {
  keywordId: string;
  initialIsWatched: boolean;
  /** Called after a successful toggle. Receives the new state. */
  onToggleSuccess?: (isNowWatched: boolean) => void;
  /** Called on API error (e.g. 409 cap). Receives the error response body. */
  onError?: (err: { error?: string; message?: string }) => void;
}) {
  const router = useRouter();
  const [isWatched, setIsWatched] = useState(initialIsWatched);
  const [inflight, setInflight] = useState(false);
  const [error, setError] = useState<{ message: string; isCap: boolean } | null>(null);
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (dismissTimer.current !== null) clearTimeout(dismissTimer.current);
    };
  }, []);

  function flashError(next: { message: string; isCap: boolean }) {
    setError(next);
    if (dismissTimer.current !== null) clearTimeout(dismissTimer.current);
    dismissTimer.current = setTimeout(() => {
      setError(null);
      dismissTimer.current = null;
    }, next.isCap ? 6000 : 4000);
  }

  const toggle = async (e: React.MouseEvent) => {
    e.stopPropagation();   // don't trigger row navigation
    e.preventDefault();
    if (inflight) return;

    const next = !isWatched;
    setIsWatched(next);    // optimistic
    setError(null);
    setInflight(true);
    try {
      const res = next
        ? await fetch('/api/watchlist/items', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ keywordId }),
          })
        : await fetch(`/api/watchlist/items/${keywordId}`, { method: 'DELETE' });

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
        setIsWatched(!next);  // revert
        onError?.(body);
        if (body.error === 'watchlist_at_cap') {
          flashError({
            message: body.message ?? 'Watchlist full (100). Remove one to add more.',
            isCap: true,
          });
        } else {
          flashError({ message: body.message ?? body.error ?? 'Could not save — try again', isCap: false });
        }
        return;
      }
      onToggleSuccess?.(next);
      // Refresh in background so the tab-nav count badge updates.
      router.refresh();
    } catch {
      setIsWatched(!next);
      flashError({ message: 'Network error — try again', isCap: false });
    } finally {
      setInflight(false);
    }
  };

  return (
    <span className="relative inline-block">
      <button
        type="button"
        onClick={toggle}
        aria-label={isWatched ? 'Remove from watchlist' : 'Add to watchlist'}
        title={isWatched ? 'Watching — click to remove' : 'Add to watchlist'}
        className={`text-base leading-none transition-colors ${
          isWatched
            ? 'text-yellow-500 hover:text-yellow-600'
            : 'text-gray-300 hover:text-yellow-500'
        } ${inflight ? 'opacity-60' : ''}`}
      >
        {isWatched ? '★' : '☆'}
      </button>
      {error && (
        <span
          role="status"
          className="absolute left-1/2 top-full z-20 mt-1 w-44 -translate-x-1/2 rounded border border-red-200 bg-white px-2 py-1 text-left text-xs font-normal text-red-700 shadow-md"
        >
          {error.message}
          {error.isCap && (
            <>
              {' '}
              <a href="/watchlist" className="underline" onClick={(e) => e.stopPropagation()}>
                Manage
              </a>
            </>
          )}
        </span>
      )}
    </span>
  );
}
