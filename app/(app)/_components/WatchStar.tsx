'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * A small star button for use in table cells. Two visual states:
 *   ☆ unwatched   ★ watched
 *
 * Click toggles via POST or DELETE. Optimistic UI — flips instantly,
 * reverts on error.
 *
 * - On the explorer results table: clicking ☆ adds to watchlist.
 * - On the watchlist page: clicking ★ removes from watchlist. The
 *   parent is expected to remove the row from its local state on
 *   success (passed via `onToggleSuccess`).
 *
 * When the user hits the 100-keyword cap, the parent should detect
 * the 409 by passing an onError callback or by handling its own
 * toast — this component only manages the visual flip.
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

  const toggle = async (e: React.MouseEvent) => {
    e.stopPropagation();   // don't trigger row navigation
    e.preventDefault();
    if (inflight) return;

    const next = !isWatched;
    setIsWatched(next);    // optimistic
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
        return;
      }
      onToggleSuccess?.(next);
      // Refresh in background so the tab-nav count badge updates.
      router.refresh();
    } catch {
      setIsWatched(!next);
    } finally {
      setInflight(false);
    }
  };

  return (
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
  );
}
