import Link from 'next/link';

// Root 404 — renders inside the root layout. Also catches any unmatched URL
// across the whole app (Next routes unknown paths here).
export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="max-w-md text-center">
        <p className="text-sm font-medium text-gray-400">404</p>
        <h1 className="mt-1 text-2xl font-semibold text-gray-900">Page not found</h1>
        <p className="mt-2 text-sm text-gray-600">
          That page doesn&apos;t exist or may have moved.
        </p>
        <div className="mt-4 flex justify-center gap-3">
          <Link
            href="/explorer"
            className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700"
          >
            Go to Explorer
          </Link>
          <Link
            href="/"
            className="rounded-md border px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Home
          </Link>
        </div>
      </div>
    </div>
  );
}
