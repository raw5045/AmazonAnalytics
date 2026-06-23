'use client';

import { useState, useTransition } from 'react';
import { collectDescendantLeaves, type CategoryNode } from '@/lib/categoryBuilder/buildTree';
import type { CustomCategoryDTO } from '@/lib/customCategories/loadServer';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface Props {
  tree: CategoryNode[];
  initialCategories: CustomCategoryDTO[];
  signedIn: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CategoryBuilderClient({ tree, initialCategories, signedIn }: Props) {
  // Drill-down path through the tree; [] = root / department list.
  const [path, setPath] = useState<CategoryNode[]>([]);

  // The "cart" of leaf names to build the custom category from.
  const [cart, setCart] = useState<string[]>([]);

  // Build-panel form state.
  const [name, setName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);

  // Saved-categories list (seeded from server; mutated optimistically on save/delete).
  const [categories, setCategories] = useState<CustomCategoryDTO[]>(initialCategories);

  // Transient notice ("Added N") shown after addLeaves().
  const [addedNotice, setAddedNotice] = useState<string | null>(null);

  // Error shown near Save button.
  const [saveError, setSaveError] = useState<string | null>(null);

  // In-flight state for mutations (POST / PATCH / DELETE).
  const [isPending, startTransition] = useTransition();

  // ---------------------------------------------------------------------------
  // Derived
  // ---------------------------------------------------------------------------

  const lastNode = path.length > 0 ? path[path.length - 1] : null;
  const currentLevel: CategoryNode[] = lastNode ? lastNode.children : tree;

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function addLeaves(names: string[]) {
    setCart((prev) => {
      const existing = new Set(prev);
      const incoming = names.filter((n) => !existing.has(n));
      const next = [...prev, ...incoming];
      // Transient notice: how many were newly added.
      setAddedNotice(incoming.length > 0 ? `Added ${incoming.length}` : 'Already in cart');
      setTimeout(() => setAddedNotice(null), 2000);
      return next;
    });
  }

  function removeFromCart(leafName: string) {
    setCart((prev) => prev.filter((n) => n !== leafName));
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
    setCart(c.leafNames);
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
          body: JSON.stringify({ name: name.trim(), leafNames: cart }),
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
          {path.map((node, i) => (
            <span key={node.name} className="flex items-center gap-1">
              <span className="text-gray-400">›</span>
              <button
                onClick={() => setPath(path.slice(0, i + 1))}
                className={
                  i === path.length - 1
                    ? 'text-gray-700 font-medium'
                    : 'text-blue-600 hover:underline'
                }
              >
                {node.name}
              </button>
            </span>
          ))}
        </div>

        {/* "Add all of <current>" when drilled in */}
        {lastNode !== null && (
          <div className="px-4 py-2 bg-blue-50 border-b border-blue-100 flex items-center justify-between">
            <span className="text-sm text-blue-800 font-medium">{lastNode.name}</span>
            <button
              onClick={() => addLeaves(collectDescendantLeaves(lastNode))}
              disabled={isPending}
              className="text-sm font-semibold text-blue-700 hover:text-blue-900 disabled:opacity-50"
            >
              ＋ Add all of {lastNode.name}
            </button>
          </div>
        )}

        {/* Category rows */}
        <ul>
          {currentLevel.length === 0 && (
            <li className="px-4 py-6 text-sm text-gray-400 text-center">No sub-categories.</li>
          )}
          {currentLevel.map((node) => {
            const hasChildren = node.children.length > 0;
            return (
              <li
                key={node.name}
                className="flex items-center px-4 py-2.5 border-b border-gray-100 last:border-b-0 hover:bg-gray-50 group"
              >
                {/* Name — clicking drills in if there are children */}
                <button
                  className={`flex-1 text-left text-sm ${
                    hasChildren
                      ? 'text-gray-800 cursor-pointer'
                      : 'text-gray-700 cursor-default'
                  }`}
                  onClick={() => {
                    if (hasChildren) setPath([...path, node]);
                  }}
                  disabled={!hasChildren}
                >
                  {node.name}
                </button>

                {/* Add button */}
                <button
                  onClick={() => addLeaves(collectDescendantLeaves(node))}
                  disabled={isPending}
                  className="ml-3 text-xs font-semibold text-blue-600 hover:text-blue-800 disabled:opacity-50 opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  Add
                </button>

                {/* Drill chevron */}
                {hasChildren && (
                  <button
                    onClick={() => setPath([...path, node])}
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
          <div className="text-xs font-semibold text-green-700 bg-green-50 border border-green-200 rounded px-3 py-1.5">
            {addedNotice}
          </div>
        )}

        {/* Build panel */}
        <div className="border border-gray-200 rounded-lg overflow-hidden">
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
                placeholder="Category name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full rounded border border-gray-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
              />

              {/* Cart */}
              <div className="text-xs text-gray-500 font-medium">
                {cart.length === 0
                  ? 'No leaves yet — add from the browser'
                  : `${cart.length} leaf${cart.length === 1 ? '' : 's'} selected`}
              </div>

              {cart.length > 0 && (
                <ul className="max-h-48 overflow-y-auto divide-y divide-gray-100 border border-gray-200 rounded text-xs">
                  {cart.map((leaf) => (
                    <li key={leaf} className="flex items-center justify-between px-2 py-1.5 hover:bg-gray-50">
                      <span className="truncate text-gray-700">{leaf}</span>
                      <button
                        onClick={() => removeFromCart(leaf)}
                        className="ml-2 shrink-0 text-gray-400 hover:text-red-500"
                        aria-label={`Remove ${leaf}`}
                      >
                        ✕
                      </button>
                    </li>
                  ))}
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
                  className="flex-1 rounded bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
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
          <div className="border border-gray-200 rounded-lg overflow-hidden">
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
                    <p className="text-xs text-gray-500">{c.leafNames.length} leaves</p>
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
