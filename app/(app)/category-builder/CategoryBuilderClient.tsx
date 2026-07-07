'use client';

import { useState, useTransition, useRef } from 'react';
import { PATH_SEP } from '@/lib/categoryBuilder/buildTree';
import { splitCategoryPath } from '@/lib/categoryBuilder/pathDisplay';
import type { LightNode } from '@/lib/categoryBuilder/treeNav';
import type { CustomCategoryDTO } from '@/lib/customCategories/loadServer';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface Props {
  rootLevel: LightNode[];
  initialCategories: CustomCategoryDTO[];
  signedIn: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CategoryBuilderClient({ rootLevel, initialCategories, signedIn }: Props) {
  // Drill-down path through the tree (segment names); [] = root / department list.
  const [path, setPath] = useState<string[]>([]);

  // Per-level cache: pathKey (names joined by PATH_SEP) → that level's LightNodes.
  // Seeded with the root level so the first render needs no fetch.
  const [levels, setLevels] = useState<Map<string, LightNode[]>>(() => new Map([['', rootLevel]]));
  const [levelLoading, setLevelLoading] = useState(false);
  const [addLoading, setAddLoading] = useState(false);
  // Path whose tree fetch failed — drives a "Couldn't load — retry" row instead
  // of the misleading "No sub-categories." empty state.
  const [errorPathKey, setErrorPathKey] = useState<string | null>(null);

  // The "cart" of leaf names to build the custom category from.
  const [cart, setCart] = useState<string[]>([]);

  // Build-panel form state.
  const [name, setName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);

  // Saved-categories list (seeded from server; mutated optimistically on save/delete).
  const [categories, setCategories] = useState<CustomCategoryDTO[]>(initialCategories);

  // Transient notice ("Added N") shown after addLeaves().
  const [addedNotice, setAddedNotice] = useState<{ text: string; tone: 'ok' | 'err' } | null>(null);
  const addedNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Error shown near Save button.
  const [saveError, setSaveError] = useState<string | null>(null);

  // In-flight state for mutations (POST / PATCH / DELETE).
  const [isPending, startTransition] = useTransition();

  // ---------------------------------------------------------------------------
  // Derived
  // ---------------------------------------------------------------------------

  const pathKey = path.join(PATH_SEP);
  const currentLevel: LightNode[] = levels.get(pathKey) ?? [];

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  // Transient notice near the cart (success = green, error = red), auto-dismissed.
  function notify(text: string, tone: 'ok' | 'err' = 'ok') {
    setAddedNotice({ text, tone });
    if (addedNoticeTimer.current !== null) clearTimeout(addedNoticeTimer.current);
    addedNoticeTimer.current = setTimeout(() => {
      setAddedNotice(null);
      addedNoticeTimer.current = null;
    }, tone === 'err' ? 3500 : 2000);
  }

  function addLeaves(paths: string[]) {
    setCart((prev) => {
      const existing = new Set(prev);
      const incoming = paths.filter((p) => !existing.has(p));
      const next = [...prev, ...incoming];
      // Transient notice: how many were newly added.
      if (incoming.length > 0) {
        notify(`Added ${incoming.length}`);
      } else if (paths.length === 0) {
        notify('Nothing to add');
      } else {
        notify('Already in cart');
      }
      return next;
    });
  }

  // Fetch + cache a level's children (no-op if already cached). On failure,
  // flags the path so the UI shows a retry row instead of "No sub-categories."
  async function fetchLevel(targetPath: string[]) {
    const key = targetPath.join(PATH_SEP);
    if (levels.has(key)) {
      setErrorPathKey((cur) => (cur === key ? null : cur));
      return;
    }
    setLevelLoading(true);
    setErrorPathKey((cur) => (cur === key ? null : cur));
    try {
      const res = await fetch(`/api/category-builder/tree?path=${encodeURIComponent(key)}`);
      if (!res.ok) throw new Error(`tree ${res.status}`);
      const json = (await res.json()) as { children: LightNode[] };
      setLevels((prev) => new Map(prev).set(key, json.children));
    } catch {
      // Don't cache the failure — flag it so the user gets a retry affordance
      // rather than the misleading "No sub-categories." after a transient blip.
      setErrorPathKey(key);
    } finally {
      setLevelLoading(false);
    }
  }

  // Drill into a child by name: push the segment, then fetch + cache that level.
  async function drillInto(name: string) {
    const nextPath = [...path, name];
    setPath(nextPath);
    await fetchLevel(nextPath);
  }

  // Add every terminal leaf under `segments` to the cart, fetched on demand.
  async function addUnderPath(segments: string[]) {
    setAddLoading(true);
    try {
      const res = await fetch(`/api/category-builder/leaves?path=${encodeURIComponent(segments.join(PATH_SEP))}`);
      if (!res.ok) throw new Error(`leaves ${res.status}`);
      const json = (await res.json()) as { leaves: string[] };
      addLeaves(json.leaves);
    } catch {
      notify("Couldn't load that category — try again", 'err');
    } finally {
      setAddLoading(false);
    }
  }

  function removeFromCart(path: string) {
    setCart((prev) => prev.filter((p) => p !== path));
  }

  function clearCart() {
    setCart([]);
    setName('');
    setEditingId(null);
    setSaveError(null);
    setAddedNotice(null);
  }

  function startEditing(c: CustomCategoryDTO) {
    setEditingId(c.id);
    setName(c.name);
    setCart(c.leafPaths);
    setSaveError(null);
    setAddedNotice(null);
  }

  // ---------------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------------

  function handleSave() {
    if (!name.trim() || cart.length === 0) return;
    setSaveError(null);

    startTransition(async () => {
      try {
        const url =
          editingId !== null
            ? `/api/category-builder/custom/${editingId}`
            : '/api/category-builder/custom';
        const method = editingId !== null ? 'PATCH' : 'POST';

        const res = await fetch(url, {
          method,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: name.trim(), leafPaths: cart }),
        });

        const json = await res.json() as { category?: CustomCategoryDTO; error?: string };

        if (!res.ok) {
          setSaveError(json.error ?? 'Something went wrong.');
          return;
        }

        const saved = json.category!;
        setCategories((prev) => {
          if (editingId !== null) {
            return prev.map((c) => (c.id === editingId ? saved : c));
          }
          return [saved, ...prev];
        });

        // Reset editor.
        setCart([]);
        setName('');
        setEditingId(null);
        setSaveError(null);
        setAddedNotice(null);
      } catch {
        setSaveError('Network error — please try again.');
      }
    });
  }

  function handleDelete(id: string) {
    startTransition(async () => {
      try {
        const res = await fetch(`/api/category-builder/custom/${id}`, { method: 'DELETE' });
        if (!res.ok) {
          const json = await res.json() as { error?: string };
          setSaveError(json.error ?? 'Delete failed.');
          return;
        }
        setCategories((prev) => prev.filter((c) => c.id !== id));
        // If we were editing this category, reset the editor.
        if (editingId === id) {
          setCart([]);
          setName('');
          setEditingId(null);
          setSaveError(null);
        }
      } catch {
        setSaveError('Network error — please try again.');
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const canSave = name.trim().length > 0 && cart.length > 0 && !isPending;

  return (
    <div className="flex gap-6 items-start">
      {/* ------------------------------------------------------------------ */}
      {/* LEFT: Drill-down browser                                            */}
      {/* ------------------------------------------------------------------ */}
      <div className="flex-1 min-w-0 border border-gray-200 rounded-lg overflow-hidden">
        {/* Breadcrumb */}
        <div className="flex flex-wrap items-center gap-1 px-4 py-2 bg-gray-50 border-b border-gray-200 text-sm">
          <button
            onClick={() => setPath([])}
            className="text-blue-600 hover:underline font-medium"
          >
            Departments
          </button>
          {path.map((segment, i) => (
            <span key={segment} className="flex items-center gap-1">
              <span className="text-gray-400">›</span>
              <button
                onClick={() => setPath(path.slice(0, i + 1))}
                className={
                  i === path.length - 1
                    ? 'text-gray-700 font-medium'
                    : 'text-blue-600 hover:underline'
                }
              >
                {segment}
              </button>
            </span>
          ))}
        </div>

        {/* "Add all of <current>" when drilled in */}
        {path.length > 0 && (
          <div className="px-4 py-2 bg-blue-50 border-b border-blue-100 flex items-center justify-between">
            <span className="text-sm text-blue-800 font-medium">{path[path.length - 1]}</span>
            <button
              onClick={() => addUnderPath(path)}
              disabled={isPending || addLoading}
              className="text-sm font-semibold text-blue-700 hover:text-blue-900 disabled:opacity-50"
            >
              ＋ Add all of {path[path.length - 1]}
            </button>
          </div>
        )}

        {/* Category rows */}
        <ul>
          {levelLoading && currentLevel.length === 0 && (
            <li className="px-4 py-6 text-sm text-gray-400 text-center">Loading…</li>
          )}
          {!levelLoading && currentLevel.length === 0 && errorPathKey === pathKey && (
            <li className="px-4 py-6 text-sm text-center">
              <span className="text-red-600">Couldn&apos;t load this level.</span>{' '}
              <button onClick={() => fetchLevel(path)} className="text-blue-600 underline">
                Retry
              </button>
            </li>
          )}
          {!levelLoading && currentLevel.length === 0 && errorPathKey !== pathKey && (
            <li className="px-4 py-6 text-sm text-gray-400 text-center">No sub-categories.</li>
          )}
          {currentLevel.map((node) => {
            const hasChildren = node.hasChildren;
            return (
              <li
                key={node.name}
                className="flex items-center px-4 py-2.5 border-b border-gray-100 last:border-b-0 hover:bg-[#F2F7FF] group"
              >
                {/* Name — clicking drills in if there are children */}
                <button
                  className={`flex-1 text-left text-sm ${
                    hasChildren
                      ? 'text-gray-800 cursor-pointer'
                      : 'text-gray-700 cursor-default'
                  }`}
                  onClick={() => {
                    if (hasChildren) drillInto(node.name);
                  }}
                  disabled={!hasChildren}
                >
                  {node.name}
                </button>

                {/* Add button */}
                <button
                  onClick={() => addUnderPath([...path, node.name])}
                  disabled={isPending || addLoading}
                  className="ml-3 text-xs font-semibold text-blue-600 hover:text-blue-800 disabled:opacity-50"
                >
                  Add
                </button>

                {/* Drill chevron */}
                {hasChildren && (
                  <button
                    onClick={() => drillInto(node.name)}
                    className="ml-2 text-gray-400 hover:text-gray-700"
                    aria-label={`Drill into ${node.name}`}
                  >
                    ›
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* RIGHT: Build panel + saved categories                               */}
      {/* ------------------------------------------------------------------ */}
      <div className="w-80 shrink-0 flex flex-col gap-4">
        {/* Added notice */}
        {addedNotice !== null && (
          <div
            className={`text-xs font-semibold rounded px-3 py-1.5 border ${
              addedNotice.tone === 'err'
                ? 'text-red-700 bg-red-50 border-red-200'
                : 'text-green-700 bg-green-50 border-green-200'
            }`}
          >
            {addedNotice.text}
          </div>
        )}

        {/* Build panel */}
        <div className="card-app overflow-hidden">
          <div className="px-4 py-3 bg-gray-50 border-b border-gray-200">
            <span className="text-sm font-semibold text-gray-700">
              {editingId !== null ? 'Edit category' : 'Build custom category'}
            </span>
          </div>

          {signedIn ? (
            <div className="px-4 py-3 flex flex-col gap-3">
              {/* Name input */}
              <input
                type="text"
                aria-label="Category name"
                placeholder="Category name"
                value={name}
                onChange={(e) => { setName(e.target.value); if (saveError) setSaveError(null); }}
                className="w-full rounded border border-gray-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
              />

              {/* Cart */}
              <div className="text-xs text-gray-500 font-medium">
                {cart.length === 0
                  ? 'No leaves yet — add from the browser'
                  : `${cart.length} categor${cart.length === 1 ? 'y' : 'ies'} selected`}
              </div>

              {cart.length > 0 && (
                <ul className="max-h-48 overflow-y-auto divide-y divide-gray-100 border border-gray-200 rounded text-xs">
                  {cart.map((path) => {
                    const { leaf, prefix } = splitCategoryPath(path);
                    return (
                      <li key={path} className="flex items-center justify-between px-2 py-1.5 hover:bg-gray-50">
                        <span className="min-w-0 truncate text-gray-700" title={path}>
                          <span className="font-medium">{leaf}</span>
                          {prefix && <span className="text-gray-400"> · {prefix}</span>}
                        </span>
                        <button
                          onClick={() => removeFromCart(path)}
                          className="ml-2 shrink-0 text-gray-400 hover:text-red-500"
                          aria-label={`Remove ${path}`}
                        >
                          ✕
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}

              {/* Error */}
              {saveError !== null && (
                <p className="text-xs text-red-600">{saveError}</p>
              )}

              {/* Actions */}
              <div className="flex gap-2">
                <button
                  onClick={handleSave}
                  disabled={!canSave}
                  className="flex-1 rounded-full bg-amber-300 px-3 py-1.5 text-xs font-semibold text-[#0B1E3A] hover:bg-amber-200 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {isPending ? 'Saving…' : editingId !== null ? 'Update' : 'Save Custom Category'}
                </button>
                <button
                  onClick={clearCart}
                  disabled={isPending}
                  className="rounded border border-gray-300 px-3 py-1.5 text-xs font-semibold text-gray-600 hover:bg-gray-50 disabled:opacity-40"
                >
                  Clear
                </button>
              </div>
            </div>
          ) : (
            <p className="px-4 py-6 text-sm text-gray-500 text-center">
              Sign in to build custom categories.
            </p>
          )}
        </div>

        {/* Saved categories */}
        {signedIn && categories.length > 0 && (
          <div className="card-app overflow-hidden">
            <div className="px-4 py-3 bg-gray-50 border-b border-gray-200">
              <span className="text-sm font-semibold text-gray-700">Your custom categories</span>
            </div>
            <ul className="divide-y divide-gray-100">
              {categories.map((c) => (
                <li
                  key={c.id}
                  className={`px-4 py-3 flex items-start gap-2 ${
                    editingId === c.id ? 'bg-blue-50' : 'hover:bg-gray-50'
                  }`}
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{c.name}</p>
                    <p className="text-xs text-gray-500">{c.leafPaths.length} categories</p>
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <button
                      onClick={() => startEditing(c)}
                      disabled={isPending}
                      className="text-xs font-semibold text-blue-600 hover:text-blue-800 disabled:opacity-40"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => handleDelete(c.id)}
                      disabled={isPending}
                      className="text-xs font-semibold text-red-500 hover:text-red-700 disabled:opacity-40"
                    >
                      Delete
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
