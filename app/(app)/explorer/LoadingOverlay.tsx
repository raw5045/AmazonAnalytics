'use client';

/**
 * Full-viewport centered loading overlay shown during in-place explorer
 * transitions (filter Apply, sort, pagination). Driven by the caller's
 * useTransition isPending. Pure-CSS spinner — a faint ring with a rotating
 * blue arc and "Loading" in the middle, over a dimmed backdrop.
 *
 * Complementary to loading.tsx (the route-level skeleton for hard/cold
 * loads); this covers soft router.replace transitions where the old page
 * stays mounted and would otherwise look frozen.
 */
export function LoadingOverlay({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-white/60"
    >
      <div className="relative h-16 w-16">
        <div className="absolute inset-0 rounded-full border-4 border-gray-200" aria-hidden="true" />
        <div className="absolute inset-0 rounded-full border-4 border-transparent border-t-blue-600 animate-spin" aria-hidden="true" />
        <span className="absolute inset-0 flex items-center justify-center text-xs font-medium text-gray-700">
          Loading
        </span>
      </div>
    </div>
  );
}
