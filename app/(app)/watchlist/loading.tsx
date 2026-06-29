// Instant skeleton for /watchlist (the page does two sequential awaits before
// it can render). Mirrors the header + bulk-add box + table layout.
export default function Loading() {
  return (
    <div className="p-6">
      <div className="mb-4">
        <div className="h-8 w-40 animate-pulse rounded bg-gray-200" />
        <div className="mt-2 h-4 w-48 animate-pulse rounded bg-gray-100" />
      </div>
      <div className="mb-6 h-24 w-full animate-pulse rounded border bg-gray-50" />
      <div className="space-y-2">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="h-10 w-full animate-pulse rounded bg-gray-100" />
        ))}
      </div>
    </div>
  );
}
