'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { buildViewHref } from '@/lib/savedViews/serialize';
import type { SavedView } from '@/lib/savedViews/types';
import { NameViewModal } from './NameViewModal';

/**
 * The "Saved Views" picker at the top of FilterSidebar.
 *
 * Renders:
 *   - A dropdown button showing the currently-selected view name
 *     (with a trailing "*" if filters were modified after loading)
 *   - On click: a list of the user's saved views, each with an
 *     inline ⋮ menu for Rename / Delete
 *
 * Clicking a view navigates to /explorer?view=<id>&<view's filters>.
 * Rename + Delete call the saved-views API and refresh the page.
 */
export function SavedViewsDropdown({
  views,
  activeView,
  isViewModified,
}: {
  views: SavedView[];
  activeView: SavedView | null;
  isViewModified: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
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

  const applyView = (view: SavedView) => {
    setOpen(false);
    startTransition(() => {
      router.push(buildViewHref(view));
    });
  };

  const deleteView = async (view: SavedView) => {
    if (!confirm(`Delete "${view.name}"? This cannot be undone.`)) return;
    setOpen(false);
    const res = await fetch(`/api/explorer/saved-views/${view.id}`, { method: 'DELETE' });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      alert(`Failed to delete: ${body.error ?? res.statusText}`);
      return;
    }
    // If the deleted view was the active one, drop the ?view= param
    if (activeView?.id === view.id) {
      startTransition(() => router.push('/explorer'));
    } else {
      startTransition(() => router.refresh());
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
      startTransition(() => router.refresh());
    } finally {
      setIsRenaming(false);
    }
  };

  const buttonLabel = activeView
    ? `${activeView.name}${isViewModified ? ' *' : ''}`
    : 'Saved views';

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={isPending}
        className="w-full flex items-center justify-between border border-gray-300 rounded px-2 py-1.5 text-sm bg-white hover:bg-gray-50 disabled:opacity-60"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={activeView ? `Currently loaded: ${activeView.name}${isViewModified ? ' (modified)' : ''}` : 'Pick a saved view'}
      >
        <span className={`truncate ${activeView ? 'text-blue-900 font-medium' : 'text-gray-500'}`}>
          {buttonLabel}
        </span>
        <span className="text-gray-400 ml-2">▾</span>
      </button>

      {open && (
        <ul
          role="listbox"
          className="absolute z-20 mt-1 w-full bg-white border border-gray-300 rounded shadow-lg text-sm max-h-72 overflow-y-auto"
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
          <div className="absolute right-0 mt-1 w-32 bg-white border border-gray-300 rounded shadow-lg z-30 text-sm">
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
