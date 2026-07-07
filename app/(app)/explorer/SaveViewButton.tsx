'use client';

import { useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { parseExplorerFilters, type SearchParamsLike } from '@/lib/explorer/parseFilters';
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
}: {
  savedViewsCount: number;
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
    const sp: SearchParamsLike = {};
    searchParams?.forEach((value, key) => {
      sp[key] = value;
    });
    return parseExplorerFilters(sp);
  }, [searchParams]);

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
      router.push(`/explorer?view=${data.view.id}`);
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
      <button
        type="button"
        onClick={() => {
          setError(null);
          setIsOpen(true);
        }}
        disabled={atLimit}
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
