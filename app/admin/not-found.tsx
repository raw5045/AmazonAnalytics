import Link from 'next/link';

/**
 * Custom 404 page for the admin section. Triggered whenever any admin route
 * calls notFound() (e.g. a batch ID that no longer exists, or a file ID under
 * a deleted batch). Gives the user actionable recovery paths instead of the
 * default opaque "404 Not Found".
 */
export default function AdminNotFound() {
  return (
    <div className="max-w-xl">
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <p className="mt-3 text-gray-700">
        The page you tried to open no longer exists. This usually happens when:
      </p>
      <ul className="mt-3 list-disc pl-6 text-gray-700">
        <li>A batch was cancelled (Cancel deletes the batch entirely)</li>
        <li>A bookmarked URL points at data that has been removed</li>
        <li>You navigated via browser history to a stale page</li>
      </ul>
      <p className="mt-4 text-gray-700">Try one of these:</p>
      <div className="mt-4 flex flex-col gap-2">
        <Link href="/admin/batches" className="text-blue-700 underline">
          → Upload history (all current batches)
        </Link>
        <Link href="/admin/upload" className="text-blue-700 underline">
          → Bulk upload (start a new batch)
        </Link>
        <Link href="/admin/upload/single" className="text-blue-700 underline">
          → Single file upload
        </Link>
        <Link href="/admin" className="text-blue-700 underline">
          → Admin overview
        </Link>
      </div>
    </div>
  );
}
