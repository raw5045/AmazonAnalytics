'use client';

// Error boundary for the authenticated app pages. Because error.tsx does NOT
// wrap the layout in its own segment, the (app) nav/header stays put and only
// the page content is replaced with this fallback.
import { useEffect } from 'react';

export default function AppError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    console.error('[app error]', error);
  }, [error]);

  return (
    <div className="p-6">
      <div className="mx-auto max-w-md rounded-lg border bg-white p-6 text-center">
        <h2 className="text-lg font-semibold text-gray-900">Something went wrong</h2>
        <p className="mt-2 text-sm text-gray-600">
          This page hit an unexpected error — it&apos;s usually temporary. Try again.
        </p>
        {error.digest && (
          <p className="mt-2 font-mono text-xs text-gray-400">ref: {error.digest}</p>
        )}
        <button
          onClick={() => unstable_retry()}
          className="mt-4 rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
