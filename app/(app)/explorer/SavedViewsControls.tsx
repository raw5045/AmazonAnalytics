'use client';

import { useCallback, useMemo, useState } from 'react';
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
}

export function SavedViewsControls({ views: serverViews }: { views: SavedView[] }) {
  const membership = serverViews.map((v) => v.id).join(',');
  const [justSaved, setJustSaved] = useState<OverlayEntry[]>([]);

  const views = useMemo(() => {
    const known = new Set(serverViews.map((v) => v.id));
    const overlaid = justSaved
      .filter((o) => o.membership === membership && !known.has(o.view.id))
      .map((o) => o.view);
    return [...overlaid, ...serverViews];
  }, [justSaved, serverViews, membership]);

  const onSaved = useCallback(
    (view: SavedView) => {
      setJustSaved((prev) => [{ view, membership }, ...prev.filter((o) => o.view.id !== view.id)]);
    },
    [membership],
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
        <SavedViewsDropdown views={views} onDeleted={onDeleted} onRenamed={onRenamed} />
      </div>
      <SaveViewButton savedViewsCount={views.length} onSaved={onSaved} />
    </>
  );
}
