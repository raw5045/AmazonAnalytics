'use client';

import { usePathname } from 'next/navigation';

/**
 * Sticky toolbar row that holds the saved-views dropdown + Save button.
 *
 * Visible ONLY on the keyword LIST page (/explorer): that's where filter
 * state lives, so it's the only place the controls mean anything. On detail
 * pages (/explorer/keyword/*) the row used to render as an empty white strip
 * sandwiched between the navy app bar and the navy title band (2026-07
 * reskin) — hiding it there removes the sandwich. SaveViewButton already
 * self-hides on detail paths; this hides the whole bar.
 *
 * Hidden, not unmounted: SavedViewsControls inside keeps a just-saved
 * overlay until the layout re-fetches, and a refresh that gets discarded by
 * a quick follow-up navigation would otherwise lose it on a trip into a
 * keyword detail page and back.
 */
export function SavedViewsBar({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const visible = pathname === '/explorer';
  return (
    <div
      className={`${visible ? 'flex' : 'hidden'} sticky top-[52px] z-20 h-12 items-center justify-end gap-2 border-b border-slate-200 bg-white px-6`}
    >
      {children}
    </div>
  );
}
