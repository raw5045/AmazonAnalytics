'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Detail-page Watch toggle. Bigger + more discoverable than <WatchStar>.
 *
 * Unwatched:  [☆ Watch]
 * Watched:    [★ Watching]
 *
 * On 409 (cap reached), inline error appears below the button with
 * a link to /watchlist.
 */
export function WatchToggle({
  keywordId,
  initialIsWatched,
}: {
  keywordId: string;
  initialIsWatched: boolean;
}) {
  const router = useRouter();
  const [isWatched, setIsWatched] = useState(initialIsWatched);
  const [inflight, setInflight] = useState(false);
  const [error, setError] = useState<{ message: string; isCap: boolean } | null>(null);

  const toggle = async () => {
    if (inflight) return;
    const next = !isWatched;
    setIsWatched(next);   // optimistic
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
        const body = (await res.json().catch(() => ({}))) as {
          error?: string; message?: string;
        };
        setIsWatched(!next);
        if (body.error === 'watchlist_at_cap') {
          setError({
            message: body.message ?? "You've watched 100 keywords. Remove one to add more.",
            isCap: true,
          });
        } else {
          setError({ message: body.message ?? body.error ?? 'Could not save — try again', isCap: false });
        }
        return;
      }
      router.refresh();  // update tab-nav badge
    } catch {
      setIsWatched(!next);
      setError({ message: 'Network error — try again', isCap: false });
    } finally {
      setInflight(false);
    }
  };

  return (
    <div className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={toggle}
        disabled={inflight}
        aria-pressed={isWatched}
        // Styled for the detail page's navy title band (its only call site):
        // amber outline when idle, solid amber while watching.
        className={`inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-sm font-medium ${
          isWatched
            ? 'border-amber-300 bg-amber-300 text-[#0B1E3A] hover:bg-amber-200'
            : 'border-amber-300/60 bg-transparent text-amber-200 hover:border-amber-300 hover:text-amber-100'
        } ${inflight ? 'opacity-60 cursor-wait' : ''}`}
      >
        <span className={isWatched ? 'text-[#0B1E3A]' : 'text-amber-300'}>
          {isWatched ? '★' : '☆'}
        </span>
        {isWatched ? 'Watching' : 'Watch'}
      </button>
      {error && (
        <p className="text-xs text-red-300">
          {error.message}
          {error.isCap && (
            <>
              {' '}
              <a href="/watchlist" className="underline">Manage watchlist</a>
            </>
          )}
        </p>
      )}
    </div>
  );
}
