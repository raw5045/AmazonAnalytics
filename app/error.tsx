'use client';

// General error boundary for route segments that don't have a closer error.tsx
// (marketing home, /app landing, sign-in/up). Root-layout failures are handled
// by global-error.tsx instead.
import { useEffect } from 'react';
import Link from 'next/link';

export default function RootError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    console.error('[root error]', error);
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="max-w-md rounded-lg border bg-white p-8 text-center">
        <h2 className="text-xl font-semibold text-gray-900">Something went wrong</h2>
        <p className="mt-2 text-sm text-gray-600">
          An unexpected error occurred. It&apos;s usually temporary.
        </p>
        {error.digest && (
          <p className="mt-2 font-mono text-xs text-gray-400">ref: {error.digest}</p>
        )}
        <div className="mt-4 flex justify-center gap-3">
          <button
            onClick={() => unstable_retry()}
            className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700"
          >
            Try again
          </button>
          <Link
            href="/"
            className="rounded-md border px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}
