'use client';

import { useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { parseExplorerFilters } from '@/lib/explorer/parseFilters';
import { searchParamsToLike } from '@/lib/explorer/export/query';
import type { SavedView } from '@/lib/savedViews/types';
import { NameViewModal } from './NameViewModal';
import { MAX_VIEWS_PER_USER } from '@/lib/savedViews/validation';

/**
 * "Save view" button in the explorer layout header.
 *
 * Saves whatever filters are currently *applied* (reflected in the
 * URL) — not unapplied pending changes in the sidebar. To save a
 * tweaked state, users hit Apply in the sidebar first, then Save here.
 *
 * Derives filters from `useSearchParams()` + `parseExplorerFilters`
 * (same parsing path the server uses). Because the layout doesn't
 * have access to searchParams, doing this client-side keeps the data
 * flow consistent without adding a second server-side parse.
 *
 * Hidden on /explorer/keyword/* (the detail page) where "save filters"
 * has no meaning — the URL has no filter params there.
 *
 * Per the v1 model there is no "Update existing view" action. To
 * replace a view's filters, the user deletes the old view (via the
 * dropdown's ⋮ menu) and re-saves with the same name. The unique
 * (user_id, name) constraint surfaces a clear error if they try to
 * save with a name that already exists.
 */
export function SaveViewButton({
  savedViewsCount,
  views = [],
  onSaved,
}: {
  savedViewsCount: number;
  /** The picker's list (server list + just-saved overlay), to resolve a loaded view's filters. */
  views?: SavedView[];
  /** Called with the created view before navigating, so the picker can show it at once. */
  onSaved?: (view: SavedView) => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isOpen, setIsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // Convert URLSearchParams → SearchParamsLike → ExplorerFilters
  // using the same parser the server uses, so what we save exactly
  // matches what's currently rendered.
  const filters = useMemo(() => {
    // Repeated keys (`leaf=A&leaf=B`) must stay arrays — collapsing them to
    // the last value silently saved a single leaf category.
    const sp = searchParamsToLike(new URLSearchParams(searchParams?.toString() ?? ''));
    // Bookmark form (`?view=<id>`, no filter params): the applied filters are
    // the loaded view's stored ones. The URL carries none, so parsing it saved
    // the DEFAULTS — every "wiped" view of 2026-09-18 was saved while another
    // view was loaded. Mirrors the page's own resolution (activeView &&
    // !urlHasFilters); the hybrid shape `?view=<id>&<filters>` keeps URL-wins.
    // First value wins for a repeated `view`, as the page's getOne does.
    const viewId = Array.isArray(sp.view) ? sp.view[0] : sp.view ?? null;
    const urlHasFilters = Object.keys(sp).some((k) => k !== 'view' && k !== 'page' && k !== 'per_page');
    if (viewId && !urlHasFilters) {
      const loaded = views.find((v) => v.id === viewId);
      if (loaded) return loaded.filters;
    }
    return parseExplorerFilters(sp);
  }, [searchParams, views]);

  // Only show on the main explorer page — saving from the keyword
  // detail page would persist empty/default filters.
  if (pathname !== '/explorer') return null;

  const atLimit = savedViewsCount >= MAX_VIEWS_PER_USER;

  const handleSubmit = async (name: string) => {
    setIsSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/explorer/saved-views', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, filters }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      const data = (await res.json()) as { view: SavedView };
      setIsOpen(false);
      // Hand the view to the toolbar first, so it is already in the list when
      // the navigation commits and the picker switches to it. push() re-renders
      // the page segment only; the layout that owns the saved-views list keeps
      // its stale props until refresh() re-fetches it — without the refresh
      // the new view stayed missing from the picker until a full reload (owner
      // report, 2026-09-18). Cost: a save renders the explorer page twice
      // (navigate + refresh), the same as rename/delete already do.
      onSaved?.(data.view);
      router.push(`/explorer?view=${data.view.id}`);
      router.refresh();
    } catch {
      // fetch() itself rejected (offline, DNS failure, connection reset).
      // Without this catch the rejection went unhandled and the modal sat
      // open with no feedback — surface it like an HTTP error instead.
      setError('Network error — please check your connection and try again.');
    } finally {
      setIsSaving(false);
    }
  };

  const tooltip = atLimit
    ? `You've reached the ${MAX_VIEWS_PER_USER}-view limit. Delete a saved view to add a new one.`
    : 'Save the currently applied filters as a new view';

  return (
    <>
      {/* At the cap the button is disabled; say why in plain sight (the hover
          tooltip alone went unnoticed — owner hit the cap while testing,
          2026-09-18). */}
      {atLimit && (
        <span id="save-view-cap-note" className="text-xs text-amber-700">
          {savedViewsCount} of {MAX_VIEWS_PER_USER} views saved — delete one to save another.
        </span>
      )}
      <button
        type="button"
        onClick={() => {
          setError(null);
          setIsOpen(true);
        }}
        disabled={atLimit}
        aria-describedby={atLimit ? 'save-view-cap-note' : undefined}
        className="whitespace-nowrap rounded-full bg-amber-300 px-4 py-1.5 text-sm font-semibold text-[#0B1E3A] hover:bg-amber-200 disabled:cursor-not-allowed disabled:opacity-50"
        title={tooltip}
      >
        Save view
      </button>
      <NameViewModal
        isOpen={isOpen}
        title="Save current view"
        submitLabel="Save view"
        errorMessage={error}
        isSubmitting={isSaving}
        onSubmit={handleSubmit}
        onClose={() => {
          setIsOpen(false);
          setError(null);
        }}
      />
    </>
  );
}
