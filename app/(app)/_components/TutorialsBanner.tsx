'use client';

import Link from 'next/link';
import { useState, useSyncExternalStore } from 'react';

const DISMISSED_KEY = 'kq.tutorials-banner-dismissed';

/**
 * One-time nudge under the app bar pointing new users at the /help video
 * tutorials. localStorage-gated per browser (no schema). The server snapshot
 * reports "dismissed", so nothing renders on the server or during hydration
 * and dismissed users never see a flash; the client snapshot takes over after
 * hydration.
 */
function subscribe(onChange: () => void) {
  window.addEventListener('storage', onChange);
  return () => window.removeEventListener('storage', onChange);
}

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) !== null;
  } catch {
    return true; // no usable storage (private mode etc.): stay hidden, as before
  }
}

export function TutorialsBanner() {
  const dismissedInStorage = useSyncExternalStore(subscribe, readDismissed, () => true);
  const [dismissedNow, setDismissedNow] = useState(false);

  if (dismissedInStorage || dismissedNow) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISSED_KEY, '1');
    } catch {}
    setDismissedNow(true);
  };

  return (
    <div className="flex items-center justify-between gap-4 border-b border-amber-200 bg-amber-50 px-6 py-2.5 text-sm text-gray-800">
      <p>
        New to KeywordQuarry? Seven short tutorials take you from first look to
        launch-ready keywords — about 30 minutes.{' '}
        <Link href="/help" className="font-semibold text-blue-700 underline hover:text-blue-800">
          Watch the tutorials →
        </Link>
      </p>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        className="shrink-0 rounded p-1 text-gray-500 hover:bg-amber-100 hover:text-gray-700"
      >
        ✕
      </button>
    </div>
  );
}
