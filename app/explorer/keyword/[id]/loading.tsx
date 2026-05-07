export default function KeywordDetailLoading() {
  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="h-4 w-32 bg-gray-200 rounded animate-pulse" />
      <div className="mt-4 h-8 w-96 bg-gray-200 rounded animate-pulse" />
      <div className="mt-3 h-4 w-72 bg-gray-100 rounded animate-pulse" />
      <div className="mt-8 h-4 w-32 bg-gray-200 rounded animate-pulse" />
      <div className="mt-2 border rounded">
        {Array.from({ length: 12 }).map((_, i) => (
          <div key={i} className="h-10 border-b last:border-b-0 bg-gray-50 animate-pulse" />
        ))}
      </div>
    </div>
  );
}
