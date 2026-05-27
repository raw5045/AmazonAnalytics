'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type {
  ExplorerFilters,
  JumpKey,
  MatchMode,
  SeverityKey,
  SortKey,
  TitleMatchMode,
  WindowKey,
} from '@/lib/explorer/types';
import { EXPLORER_DEFAULTS } from '@/lib/explorer/parseFilters';
import type { SavedView } from '@/lib/savedViews/types';
import { LeafCategoryTypeahead } from './LeafCategoryTypeahead';
import { SavedViewsDropdown } from './SavedViewsDropdown';
import { NameViewModal } from './NameViewModal';
import { SaveOrUpdateDialog } from './SaveOrUpdateDialog';
import { MAX_VIEWS_PER_USER } from '@/lib/savedViews/validation';

const WINDOWS: Array<{ value: WindowKey; label: string }> = [
  { value: '1w', label: 'Week' },
  { value: '4w', label: 'Month' },
  { value: '13w', label: '3 Months' },
  { value: '26w', label: '6 Months' },
  { value: '52w', label: 'Year' },
];

const JUMPS: Array<{ value: JumpKey; label: string }> = [
  { value: '500k_to_100k', label: 'Outside top 500k → inside top 100k' },
  { value: '100k_to_50k', label: 'Outside top 100k → inside top 50k' },
  { value: '100k_to_10k', label: 'Outside top 100k → inside top 10k' },
  { value: '50k_to_10k', label: 'Outside top 50k → inside top 10k' },
  { value: 'custom', label: 'Custom thresholds…' },
];

const SEVERITIES: Array<{ value: SeverityKey; label: string }> = [
  { value: 'none', label: 'None (clean)' },
  { value: 'warning', label: 'Warning' },
  { value: 'critical', label: 'Critical' },
];

const SORTS: Array<{ value: SortKey; label: string }> = [
  { value: 'rank', label: 'Best current rank' },
  { value: 'rank_desc', label: 'Worst current rank' },
  { value: 'imp', label: 'Biggest improvement (window)' },
  { value: 'decline', label: 'Biggest decline (window)' },
  { value: 'title_gap', label: 'Most title gaps' },
  { value: 'avg_price_asc', label: 'Cheapest avg price (top-3)' },
  { value: 'avg_price_desc', label: 'Most expensive avg price (top-3)' },
  { value: 'avg_reviews_asc', label: 'Fewest avg reviews (top-3)' },
  { value: 'avg_reviews_desc', label: 'Most avg reviews (top-3)' },
];

const TITLE_MODES: Array<{ value: TitleMatchMode | ''; label: string }> = [
  { value: '', label: 'Show all (no title filter)' },
  { value: 'any', label: 'Missing from any selected' },
  { value: 'all', label: 'Missing from all selected' },
];

interface PendingFilters {
  window: WindowKey;
  q: string;
  rankBest: string;
  rankWorst: string;
  jump: JumpKey | '';
  /** Numeric string; only used when jump === 'custom'. */
  jumpFrom: string;
  /** Numeric string; only used when jump === 'custom'. */
  jumpTo: string;
  category: string;
  leafCategories: string[];
  severities: SeverityKey[];
  titleSlots: number[];
  titleMatchMode: TitleMatchMode | '';
  matchMode: MatchMode;
  sort: SortKey;
}

function filtersToPending(f: ExplorerFilters): PendingFilters {
  return {
    window: f.window,
    q: f.q ?? '',
    rankBest: f.rankMin?.toString() ?? '',
    rankWorst: f.rankMax?.toString() ?? '',
    jump: f.jump ?? '',
    jumpFrom: f.jumpFrom?.toString() ?? '',
    jumpTo: f.jumpTo?.toString() ?? '',
    category: f.category ?? '',
    leafCategories: f.leafCategories,
    severities: f.severities,
    titleSlots: f.titleSlots,
    titleMatchMode: f.titleMatchMode ?? '',
    matchMode: f.matchMode,
    sort: f.sort,
  };
}

function pendingToParams(p: PendingFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (p.window !== EXPLORER_DEFAULTS.window) params.set('window', p.window);
  if (p.sort !== EXPLORER_DEFAULTS.sort) params.set('sort', p.sort);
  if (p.q.trim().length >= 3) params.set('q', p.q.trim());
  if (p.rankBest) params.set('rank_min', p.rankBest);
  if (p.rankWorst) params.set('rank_max', p.rankWorst);
  if (p.jump) {
    params.set('jump', p.jump);
    if (p.jump === 'custom') {
      if (p.jumpFrom) params.set('jump_from', p.jumpFrom);
      if (p.jumpTo) params.set('jump_to', p.jumpTo);
    }
  }
  if (p.category) params.set('category', p.category);
  if (p.leafCategories.length > 0) params.set('leaf', p.leafCategories.join(','));
  // Default severities = ['none', 'warning']. Only emit when different.
  const defaultSev = JSON.stringify([...EXPLORER_DEFAULTS.severities].sort());
  const currentSev = JSON.stringify([...p.severities].sort());
  if (currentSev !== defaultSev && p.severities.length > 0) {
    params.set('severity', p.severities.join(','));
  }
  if (p.titleMatchMode) {
    params.set('title_match', p.titleMatchMode);
    // Only emit titles param if it differs from default [1, 2, 3]
    if (p.titleSlots.length !== 3) {
      params.set('titles', p.titleSlots.join(','));
    }
  }
  if (p.matchMode !== EXPLORER_DEFAULTS.matchMode) {
    params.set('match_mode', p.matchMode);
  }
  return params;
}

export function FilterSidebar({
  filters,
  categories,
  leafCategories,
  savedViews = [],
  activeView = null,
  isViewModified = false,
}: {
  filters: ExplorerFilters;
  categories: string[];
  leafCategories: string[];
  /** All of the current user's saved views (≤ 5). Empty for guests. */
  savedViews?: SavedView[];
  /** The view currently tagged in the URL (?view=<id>), if any. */
  activeView?: SavedView | null;
  /** True when effective filters differ from activeView.filters. */
  isViewModified?: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [pending, setPending] = useState<PendingFilters>(filtersToPending(filters));

  const apply = () => {
    const params = pendingToParams(pending);
    // Preserve the ?view= tag if a view is currently loaded — the
    // user is iterating on top of the view, not abandoning it.
    if (activeView) params.set('view', activeView.id);
    const qs = params.toString();
    startTransition(() => {
      router.replace(qs ? `/explorer?${qs}` : '/explorer', { scroll: false });
    });
  };

  // Save-view state machine. Three independent flows:
  //   1. No view active     → click Save → NameViewModal (create)
  //   2. View active + dirty → click Save → SaveOrUpdateDialog
  //   3. View active + !dirty → button disabled (nothing to save)
  const [saveDialog, setSaveDialog] = useState<
    'closed' | 'choose-update-or-new' | 'name-new'
  >('closed');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const filtersForSave = (): ExplorerFilters => {
    // Capture the current pending state as a full ExplorerFilters
    // payload to send to the API.
    return {
      window: pending.window,
      q: pending.q.trim().length >= 3 ? pending.q.trim() : null,
      rankMin: pending.rankBest ? parseInt(pending.rankBest, 10) : null,
      rankMax: pending.rankWorst ? parseInt(pending.rankWorst, 10) : null,
      jump: pending.jump || null,
      jumpFrom: pending.jump === 'custom' && pending.jumpFrom ? parseInt(pending.jumpFrom, 10) : null,
      jumpTo: pending.jump === 'custom' && pending.jumpTo ? parseInt(pending.jumpTo, 10) : null,
      category: pending.category || null,
      leafCategories: pending.leafCategories,
      severities: pending.severities,
      titleSlots: pending.titleSlots,
      titleMatchMode: pending.titleMatchMode || null,
      matchMode: pending.matchMode,
      sort: pending.sort,
      page: 1,
      perPage: 100,
    };
  };

  const onSaveClick = () => {
    setSaveError(null);
    if (activeView) {
      setSaveDialog('choose-update-or-new');
    } else {
      setSaveDialog('name-new');
    }
  };

  const submitNewView = async (name: string) => {
    setIsSaving(true);
    setSaveError(null);
    try {
      const res = await fetch('/api/explorer/saved-views', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, filters: filtersForSave() }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setSaveError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      const data = (await res.json()) as { view: SavedView };
      setSaveDialog('closed');
      // Navigate so the new view becomes "active" + dropdown refreshes
      startTransition(() => {
        const params = pendingToParams(pending);
        params.set('view', data.view.id);
        router.push(`/explorer?${params.toString()}`);
      });
    } finally {
      setIsSaving(false);
    }
  };

  const updateExistingView = async () => {
    if (!activeView) return;
    setIsSaving(true);
    setSaveError(null);
    try {
      const res = await fetch(`/api/explorer/saved-views/${activeView.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filters: filtersForSave() }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setSaveError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      setSaveDialog('closed');
      startTransition(() => router.refresh());
    } finally {
      setIsSaving(false);
    }
  };

  const reset = () => {
    setPending(filtersToPending(EXPLORER_DEFAULTS));
    startTransition(() => {
      router.replace('/explorer', { scroll: false });
    });
  };

  const dirty = JSON.stringify(filtersToPending(filters)) !== JSON.stringify(pending);

  const set = <K extends keyof PendingFilters>(key: K, value: PendingFilters[K]) => {
    setPending((p) => ({ ...p, [key]: value }));
  };

  const toggleSeverity = (sev: SeverityKey) => {
    set(
      'severities',
      pending.severities.includes(sev)
        ? pending.severities.filter((s) => s !== sev)
        : [...pending.severities, sev],
    );
  };

  const toggleTitleSlot = (slot: number) => {
    set(
      'titleSlots',
      pending.titleSlots.includes(slot)
        ? pending.titleSlots.filter((s) => s !== slot)
        : [...pending.titleSlots, slot].sort(),
    );
  };

  return (
    <aside className="w-72 border-r sticky top-0 self-start h-screen flex flex-col">
      {/* Scrollable filter content area */}
      <div className="flex-1 overflow-y-auto p-4 space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-700">Filters</h2>
        {isPending && <span className="text-xs text-gray-400">Updating…</span>}
      </div>

      <FieldGroup label="Saved views">
        <SavedViewsDropdown
          views={savedViews}
          activeView={activeView}
          isViewModified={isViewModified}
        />
      </FieldGroup>

      <FieldGroup label="Window">
        <select
          value={pending.window}
          onChange={(e) => set('window', e.target.value as WindowKey)}
          className="filter-input"
        >
          {WINDOWS.map((w) => (
            <option key={w.value} value={w.value}>
              {w.label}
            </option>
          ))}
        </select>
      </FieldGroup>

      <FieldGroup label="Sort">
        <select
          value={pending.sort}
          onChange={(e) => set('sort', e.target.value as SortKey)}
          className="filter-input"
        >
          {SORTS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </FieldGroup>

      <FieldGroup label="Search term contains">
        <input
          type="text"
          value={pending.q}
          onChange={(e) => set('q', e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') apply();
          }}
          placeholder="≥ 3 characters"
          className="filter-input"
        />
        {pending.q.length > 0 && pending.q.length < 3 && (
          <p className="text-xs text-gray-500 mt-1">Type at least 3 characters to filter by text.</p>
        )}
      </FieldGroup>

      <FieldGroup label="Rank range (1 = best)">
        <div className="flex gap-2">
          <input
            type="number"
            min={1}
            value={pending.rankBest}
            onChange={(e) => set('rankBest', e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && apply()}
            placeholder="Best (1)"
            className="filter-input flex-1"
            aria-label="Best rank"
          />
          <input
            type="number"
            min={1}
            value={pending.rankWorst}
            onChange={(e) => set('rankWorst', e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && apply()}
            placeholder="Worst (e.g. 10000)"
            className="filter-input flex-1"
            aria-label="Worst rank"
          />
        </div>
        <p className="text-xs text-gray-500 mt-1">Lower number = more searches. e.g. Best 1, Worst 10000 = top-10k.</p>
      </FieldGroup>

      <FieldGroup label="Threshold jump">
        <select
          value={pending.jump}
          onChange={(e) => set('jump', e.target.value as JumpKey | '')}
          className="filter-input"
        >
          <option value="">(none)</option>
          {JUMPS.map((j) => (
            <option key={j.value} value={j.value}>
              {j.label}
            </option>
          ))}
        </select>
        {pending.jump === 'custom' && (
          <div className="mt-2">
            <div className="flex gap-2">
              <input
                type="number"
                min={1}
                value={pending.jumpFrom}
                onChange={(e) => set('jumpFrom', e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && apply()}
                placeholder="Was worse than (e.g. 201000)"
                className="filter-input flex-1"
                aria-label="Custom jump: was ranked worse than"
              />
              <span className="self-center text-gray-400 text-xs">→</span>
              <input
                type="number"
                min={1}
                value={pending.jumpTo}
                onChange={(e) => set('jumpTo', e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && apply()}
                placeholder="Now better than (e.g. 75000)"
                className="filter-input flex-1"
                aria-label="Custom jump: now ranked better than"
              />
            </div>
            <p className="text-xs text-gray-500 mt-1">
              Show keywords whose rank in the selected window was worse than the first value and is now better than the second.
            </p>
          </div>
        )}
      </FieldGroup>

      <FieldGroup label="Top clicked category #1 (broad)">
        <select
          value={pending.category}
          onChange={(e) => set('category', e.target.value)}
          className="filter-input"
        >
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </FieldGroup>

      <FieldGroup label="Leaf categories (Keepa, slot-1)">
        <LeafCategoryTypeahead
          options={leafCategories}
          selected={pending.leafCategories}
          onChange={(next) => set('leafCategories', next)}
        />
        <p className="text-xs text-gray-500 mt-1">
          Long-tail category for the most-clicked product. {leafCategories.length.toLocaleString()} options —
          type to search, click or Enter to add. Multiple categories match with OR.
        </p>
      </FieldGroup>

      <FieldGroup label="Fake volume severity">
        <div className="space-y-1">
          {SEVERITIES.map((s) => (
            <label key={s.value} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={pending.severities.includes(s.value)}
                onChange={() => toggleSeverity(s.value)}
              />
              {s.label}
            </label>
          ))}
        </div>
      </FieldGroup>

      <FieldGroup label="Title match mode">
        <div className="flex gap-3 text-sm">
          <label className="flex items-center gap-1">
            <input
              type="radio"
              name="match-mode"
              checked={pending.matchMode === 'loose'}
              onChange={() => set('matchMode', 'loose')}
            />
            Loose
          </label>
          <label className="flex items-center gap-1">
            <input
              type="radio"
              name="match-mode"
              checked={pending.matchMode === 'strict'}
              onChange={() => set('matchMode', 'strict')}
            />
            Strict
          </label>
        </div>
        <p className="text-xs text-gray-500 mt-1">
          Loose: every word in the search term appears anywhere in the title.{' '}
          Strict: Amazon&apos;s exact-phrase match.
        </p>
      </FieldGroup>

      <FieldGroup label="Title-gap filter">
        <select
          value={pending.titleMatchMode}
          onChange={(e) => set('titleMatchMode', e.target.value as TitleMatchMode | '')}
          className="filter-input"
        >
          {TITLE_MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
        {pending.titleMatchMode && (
          <div className="mt-2 flex gap-3">
            {[1, 2, 3].map((slot) => (
              <label key={slot} className="flex items-center gap-1 text-sm">
                <input
                  type="checkbox"
                  checked={pending.titleSlots.includes(slot)}
                  onChange={() => toggleTitleSlot(slot)}
                />
                #{slot}
              </label>
            ))}
          </div>
        )}
      </FieldGroup>

      </div>{/* close scrollable area */}

      {/* Sticky footer with Apply / Reset — always visible without
          scrolling through the filter list. */}
      <div className="border-t bg-white p-3 flex flex-col gap-2 shadow-[0_-2px_4px_rgba(0,0,0,0.04)]">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={apply}
            disabled={!dirty || isPending}
            className="flex-1 bg-blue-600 text-white text-sm font-medium px-3 py-2 rounded hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
          >
            {isPending ? 'Applying…' : dirty ? 'Apply filters' : 'Filters applied'}
          </button>
          <button
            type="button"
            onClick={reset}
            className="text-xs text-gray-600 underline hover:text-gray-900"
          >
            Reset
          </button>
        </div>
        <button
          type="button"
          onClick={onSaveClick}
          disabled={
            isPending ||
            isSaving ||
            // Disable when an active view is loaded and nothing has been
            // modified — there's nothing meaningful to save.
            (activeView !== null && !isViewModified && !dirty)
          }
          className="text-xs px-3 py-1.5 rounded border border-gray-300 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
          title={
            savedViews.length >= MAX_VIEWS_PER_USER && !activeView
              ? `You've reached the ${MAX_VIEWS_PER_USER}-view limit. Delete a saved view to add a new one.`
              : activeView && !isViewModified && !dirty
                ? 'No changes to save'
                : undefined
          }
        >
          {activeView ? '💾 Save / update view' : '💾 Save current view'}
        </button>
      </div>

      <NameViewModal
        isOpen={saveDialog === 'name-new'}
        title="Save current view"
        submitLabel="Save view"
        errorMessage={saveError}
        isSubmitting={isSaving}
        onSubmit={submitNewView}
        onClose={() => {
          setSaveDialog('closed');
          setSaveError(null);
        }}
      />

      <SaveOrUpdateDialog
        isOpen={saveDialog === 'choose-update-or-new'}
        currentViewName={activeView?.name ?? ''}
        isSubmitting={isSaving}
        onUpdate={updateExistingView}
        onSaveAsNew={() => setSaveDialog('name-new')}
        onClose={() => {
          setSaveDialog('closed');
          setSaveError(null);
        }}
      />

      <style jsx>{`
        .filter-input {
          width: 100%;
          border: 1px solid #d1d5db;
          border-radius: 4px;
          padding: 4px 8px;
          font-size: 13px;
          background: white;
        }
        .filter-input:focus {
          outline: 2px solid #3b82f6;
          outline-offset: -1px;
        }
      `}</style>
    </aside>
  );
}

function FieldGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-700 mb-1">{label}</label>
      {children}
    </div>
  );
}
