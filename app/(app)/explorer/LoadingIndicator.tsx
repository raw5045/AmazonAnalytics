/**
 * Shared top-of-viewport progress indicator used by both /explorer and
 * /explorer/keyword/[id] loading states. Pure CSS — no dependencies.
 *
 * Renders:
 *   - A thin blue bar fixed at the top of the viewport with an
 *     indeterminate-progress sliding animation.
 *   - A small "Loading <label>…" line above the page skeleton.
 *
 * Inline <style> block carries the keyframes because Tailwind doesn't
 * ship an indeterminate-progress animation out of the box.
 */
export function LoadingIndicator({ label }: { label: string }) {
  return (
    <>
      <div className="fixed top-0 left-0 right-0 h-0.5 bg-blue-100 z-50 overflow-hidden">
        <div className="h-full w-1/3 bg-blue-600 animate-loading-bar" />
      </div>
      <div className="px-6 pt-4">
        <div className="text-sm text-blue-700 inline-flex items-center gap-2">
          <span className="inline-block h-2 w-2 rounded-full bg-blue-600 animate-pulse" />
          Loading {label}…
        </div>
      </div>
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
