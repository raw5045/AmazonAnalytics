export default function ExplorerLoading() {
  return (
    <div className="flex">
      <aside className="w-72 border-r p-4">
        <div className="h-4 w-20 bg-gray-200 rounded animate-pulse" />
        <div className="mt-4 space-y-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-8 bg-gray-100 rounded animate-pulse" />
          ))}
        </div>
      </aside>
      <div className="flex-1 p-6">
        <div className="h-4 w-64 bg-gray-200 rounded animate-pulse" />
        <div className="mt-4 border rounded">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="h-10 border-b last:border-b-0 bg-gray-50 animate-pulse" />
          ))}
        </div>
      </div>
    </div>
  );
}
