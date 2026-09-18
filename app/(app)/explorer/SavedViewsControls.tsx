'use client';

import { useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import type { SavedView } from '@/lib/savedViews/types';
import { SavedViewsDropdown } from './SavedViewsDropdown';
import { SaveViewButton } from './SaveViewButton';

/**
 * Client owner of the saved-views toolbar (picker + Save button).
 *
 * The list arrives from the explorer LAYOUT (a server component). Saving a
 * view navigates with router.push('/explorer?view=<id>'), and a client-side
 * navigation re-renders only the page segment — the layout keeps the props
 * it rendered with until router.refresh() lands. Before this component
 * existed, that meant the freshly saved view was missing from the picker
 * until a full reload, so the box fell back to the "Saved views" placeholder
 * and looked like the save had failed (owner report, 2026-09-18).
 *
 * Fix: the moment the API confirms a save, the new view is overlaid on the
 * server list here (newest first, matching listSavedViewsForUser), so the
 * picker shows it as active immediately; SaveViewButton also triggers
 * router.refresh() so the layout re-fetches.
 *
 * Each overlay entry remembers the server list's membership (its ids) at
 * the time of the save and is dropped as soon as that membership changes —
 * normally when the refresh lands with the new id, but also if the list
 * changes for any other reason (e.g. a deletion made in another tab), so an
 * overlaid view can never outlive the server list. A refresh that gets
 * discarded by a quick follow-up navigation leaves the membership unchanged,
 * so the entry stays until the next refresh. Pure derivation: no effects, no
 * remount, so an open picker or modal is never wiped when a refresh lands.
 * Deletes and renames keep the overlay consistent for the window before a
 * refresh lands.
 */
interface OverlayEntry {
  view: SavedView;
  /** Server-list membership (ids, newest first) when this view was saved. */
  membership: string;
  /** The URL's search string when this view was saved. */
  search: string;
  /**
   * While true, this view reads as active as long as the URL has not moved
   * since the save (its own navigation is a page fetch away). Turned off for
   * good the first time the URL differs, so it cannot come back on a later
   * visit to the same URL.
   */
  bridge: boolean;
}

export function SavedViewsControls({ views: serverViews }: { views: SavedView[] }) {
  const membership = serverViews.map((v) => v.id).join(',');
  const [justSaved, setJustSaved] = useState<OverlayEntry[]>([]);
  const searchParams = useSearchParams();
  const currentSearch = searchParams?.toString() ?? '';

  // React's "adjust state when a prop changes" pattern: the first render in
  // which the URL differs from where a save happened ends that save's
  // active bridge for good (see OverlayEntry.bridge). The predicate is its
  // own change detector — false again right after the update — so this
  // cannot loop, and a save stamped with a stale URL mid-fetch is ended on
  // the very next render rather than lingering.
  if (justSaved.some((o) => o.bridge && o.search !== currentSearch)) {
    setJustSaved((prev) => prev.map((o) => (o.bridge && o.search !== currentSearch ? { ...o, bridge: false } : o)));
  }

  const { views, newest } = useMemo(() => {
    const known = new Set(serverViews.map((v) => v.id));
    const live = justSaved.filter((o) => o.membership === membership && !known.has(o.view.id));
    return { views: [...live.map((o) => o.view), ...serverViews], newest: live[0] ?? null };
  }, [justSaved, serverViews, membership]);

  // The picker normally derives "active" from `?view=<id>` in the URL, which
  // only updates once the post-save navigation commits (a page fetch away).
  // Until the URL moves, the newest just-saved view IS what the page shows
  // (its filters were the applied ones), so it reads as active from any save
  // origin: filtered URL, loaded view, or bare /explorer. Any Apply, pick,
  // or navigation changes the URL and wins.
  const activeIdOverride = newest && newest.bridge && newest.search === currentSearch ? newest.view.id : null;

  const onSaved = useCallback(
    (view: SavedView) => {
      setJustSaved((prev) => [
        { view, membership, search: currentSearch, bridge: true },
        ...prev.filter((o) => o.view.id !== view.id),
      ]);
    },
    [membership, currentSearch],
  );
  const onDeleted = useCallback((id: string) => {
    setJustSaved((prev) => prev.filter((o) => o.view.id !== id));
  }, []);
  const onRenamed = useCallback((id: string, name: string) => {
    setJustSaved((prev) => prev.map((o) => (o.view.id === id ? { ...o, view: { ...o.view, name } } : o)));
  }, []);

  return (
    <>
      <div className="w-72">
        <SavedViewsDropdown views={views} activeIdOverride={activeIdOverride} onDeleted={onDeleted} onRenamed={onRenamed} />
      </div>
      <SaveViewButton savedViewsCount={views.length} views={views} onSaved={onSaved} />
    </>
  );
}
