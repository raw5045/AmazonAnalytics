export default function KeywordDetailLoading() {
  return (
    <>
      {/* Thin animated bar at the top of the viewport — provides a clear
          "navigation in progress" signal even before the skeleton renders. */}
      <div className="fixed top-0 left-0 right-0 h-0.5 bg-blue-100 z-50 overflow-hidden">
        <div className="h-full w-1/3 bg-blue-600 animate-loading-bar" />
      </div>

      <div className="p-6 max-w-6xl mx-auto">
        <div className="text-sm text-blue-700 inline-flex items-center gap-2 mb-2">
          <span className="inline-block h-2 w-2 rounded-full bg-blue-600 animate-pulse" />
          Loading keyword…
        </div>

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

      {/* Animation keyframes for the top progress bar. Tailwind doesn't ship
          an indeterminate-progress animation out of the box, so we inline it. */}
      <style>{`
        @keyframes loading-bar {
          0% { transform: translateX(-100%); }
          50% { transform: translateX(150%); }
          100% { transform: translateX(400%); }
        }
        .animate-loading-bar {
          animation: loading-bar 1.4s ease-in-out infinite;
        }
      `}</style>
    </>
  );
}
