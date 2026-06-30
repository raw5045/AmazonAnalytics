'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { buildViewHref } from '@/lib/savedViews/serialize';
import type { SavedView } from '@/lib/savedViews/types';
import { NameViewModal } from './NameViewModal';

/**
 * The "Saved Views" picker, rendered in the explorer's layout header.
 *
 * Renders:
 *   - A dropdown button showing the currently-selected view name,
 *     or "Saved views" placeholder when none is active
 *   - On click: a list of the user's saved views, each with an
 *     inline ⋮ menu for Rename / Delete
 *
 * Because this lives in the layout (which can't access search params
 * server-side), the active view is derived client-side via
 * useSearchParams() + a lookup into the `views` array. No extra DB
 * call needed — `views` already has all the user's saved views, so
 * the active one is just a find-by-id.
 *
 * Clicking a view navigates to /explorer?view=<id> (the server
 * hydrates filters from the view's stored JSON). The moment the user
 * modifies any filter and hits Apply, FilterSidebar drops the view
 * tag from the URL and this dropdown blanks out — there's no
 * "modified" indicator because the view is no longer "loaded" after
 * editing.
 *
 * Rename + Delete call the saved-views API and refresh the page.
 */
export function SavedViewsDropdown({
  views,
}: {
  views: SavedView[];
}) {
  const searchParams = useSearchParams();
  const viewId = searchParams?.get('view') ?? null;
  const activeView = useMemo(
    () => (viewId ? views.find((v) => v.id === viewId) ?? null : null),
    [viewId, views],
  );
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [renamingView, setRenamingView] = useState<SavedView | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [isRenaming, setIsRenaming] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Note: these handlers used to wrap router calls in startTransition
  // + drive a `disabled={isPending}` on the dropdown button. In
  // practice the transition's isPending got stuck true after a
  // delete (Next.js 16's transition tracking for router.refresh()
  // doesn't always resolve when the layout's data fetch is what
  // changed), which left the dropdown permanently disabled — the
  // user couldn't reopen it or pick a different view. Direct
  // router calls work fine: the navigation still happens, we just
  // don't have a tracked "pending" state to get stuck.
  const applyView = (view: SavedView) => {
    setOpen(false);
    router.push(buildViewHref(view));
  };

  const deleteView = async (view: SavedView) => {
    if (!confirm(`Delete "${view.name}"? This cannot be undone.`)) return;
    setOpen(false);
    try {
      const res = await fetch(`/api/explorer/saved-views/${view.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        alert(`Failed to delete: ${body.error ?? res.statusText}`);
        return;
      }
      // If the deleted view was the active one, drop the ?view= param;
      // otherwise just refresh so the layout re-fetches savedViews
      // without the deleted row.
      if (activeView?.id === view.id) {
        router.push('/explorer');
      } else {
        router.refresh();
      }
    } catch {
      // fetch() rejected (network down). deleteView reports via alert(), so
      // keep that channel rather than introducing inline error state here.
      alert('Network error — could not delete the view. Please check your connection and try again.');
    }
  };

  const submitRename = async (newName: string) => {
    if (!renamingView) return;
    setIsRenaming(true);
    setRenameError(null);
    try {
      const res = await fetch(`/api/explorer/saved-views/${renamingView.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: newName }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setRenameError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      setRenamingView(null);
      router.refresh();
    } catch {
      // fetch() rejected (network down) — mirror the HTTP-error path so the
      // rename modal shows feedback instead of silently doing nothing.
      setRenameError('Network error — please check your connection and try again.');
    } finally {
      setIsRenaming(false);
    }
  };

  const buttonLabel = activeView ? activeView.name : 'Saved views';

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between border border-gray-300 rounded px-2 py-1.5 text-sm bg-white hover:bg-gray-50"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={activeView ? `Currently loaded: ${activeView.name}` : 'Pick a saved view'}
      >
        <span className={`truncate ${activeView ? 'text-blue-900 font-medium' : 'text-gray-500'}`}>
          {buttonLabel}
        </span>
        <span className="text-gray-400 ml-2">▾</span>
      </button>

      {open && (
        // No max-height / overflow on the UL: with a 5-view per-user
        // limit there's never enough content to need scroll, and any
        // overflow:auto here would clip the absolutely-positioned ⋮
        // popover inside each row.
        <ul
          role="listbox"
          className="absolute z-20 mt-1 w-full bg-white border border-gray-300 rounded shadow-lg text-sm"
        >
          {views.length === 0 ? (
            <li className="px-3 py-2 text-gray-500 italic">
              No saved views yet. Configure filters and click &quot;Save current view&quot;.
            </li>
          ) : views.map((v) => (
            <SavedViewItem
              key={v.id}
              view={v}
              isActive={activeView?.id === v.id}
              onApply={() => applyView(v)}
              onRename={() => {
                setOpen(false);
                setRenamingView(v);
              }}
              onDelete={() => deleteView(v)}
            />
          ))}
        </ul>
      )}

      <NameViewModal
        isOpen={renamingView !== null}
        initialName={renamingView?.name ?? ''}
        title="Rename saved view"
        submitLabel="Rename"
        errorMessage={renameError}
        isSubmitting={isRenaming}
        onSubmit={submitRename}
        onClose={() => {
          setRenamingView(null);
          setRenameError(null);
        }}
      />
    </div>
  );
}

/**
 * One row in the dropdown. Click selects the view; the trailing ⋮
 * opens a tiny popover with Rename + Delete.
 */
function SavedViewItem({
  view,
  isActive,
  onApply,
  onRename,
  onDelete,
}: {
  view: SavedView;
  isActive: boolean;
  onApply: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  return (
    <li
      className={`relative flex items-center justify-between px-3 py-1.5 hover:bg-gray-50 ${isActive ? 'bg-blue-50' : ''}`}
    >
      <button
        type="button"
        onClick={onApply}
        className="flex-1 text-left truncate text-gray-800 hover:text-gray-900"
      >
        {view.name}
        {isActive && <span className="ml-1 text-blue-700">✓</span>}
      </button>
      <div ref={menuRef} className="relative ml-2">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen((v) => !v);
          }}
          className="px-1.5 py-0.5 text-gray-500 hover:text-gray-900 hover:bg-gray-200 rounded"
          aria-label={`Options for ${view.name}`}
          title="Rename or delete"
        >
          ⋮
        </button>
        {menuOpen && (
          // `top-full` anchors the popover at the bottom edge of the
          // ⋮ button (not the top of the relative div, which would
          // put it level with the row content). `w-36` gives Rename
          // / Delete enough horizontal room to render without
          // hugging the edges.
          <div className="absolute right-0 top-full mt-1 w-36 bg-white border border-gray-300 rounded shadow-lg z-40 text-sm">
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false);
                onRename();
              }}
              className="block w-full text-left px-3 py-1.5 hover:bg-gray-50"
            >
              Rename…
            </button>
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false);
                onDelete();
              }}
              className="block w-full text-left px-3 py-1.5 hover:bg-red-50 text-red-700"
            >
              Delete
            </button>
          </div>
        )}
      </div>
    </li>
  );
}
