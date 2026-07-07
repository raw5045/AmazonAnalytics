'use client';

import { usePathname } from 'next/navigation';

/**
 * Sticky toolbar row that holds the saved-views dropdown + Save button.
 *
 * Rendered ONLY on the keyword LIST page (/explorer): that's where filter
 * state lives, so it's the only place the controls mean anything. On detail
 * pages (/explorer/keyword/*) the row used to render as an empty white strip
 * sandwiched between the navy app bar and the navy title band (2026-07
 * reskin) — hiding it there removes the sandwich. SaveViewButton already
 * self-hides on detail paths; this hides the whole bar.
 */
export function SavedViewsBar({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (pathname !== '/explorer') return null;
  return (
    <div className="sticky top-[52px] z-20 flex h-12 items-center justify-end gap-2 border-b border-slate-200 bg-white px-6">
      {children}
    </div>
  );
}
