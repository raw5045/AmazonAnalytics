'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

const DISMISSED_KEY = 'kq.tutorials-banner-dismissed';

/**
 * One-time nudge under the app bar pointing new users at the /help video
 * tutorials. localStorage-gated per browser (no schema): renders nothing
 * on the server and until the mount-time check, so dismissed users never
 * see a flash.
 */
export function TutorialsBanner() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    try {
      if (!localStorage.getItem(DISMISSED_KEY)) setShow(true);
    } catch {}
  }, []);

  if (!show) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISSED_KEY, '1');
    } catch {}
    setShow(false);
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
