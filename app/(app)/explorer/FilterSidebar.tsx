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
import { jumpPresetsFor, type JumpMetric } from '@/lib/explorer/jumpPresets';
import { LeafCategoryTypeahead } from './LeafCategoryTypeahead';
import { LoadingOverlay } from './LoadingOverlay';

const WINDOWS: Array<{ value: WindowKey; label: string }> = [
  { value: '1w', label: 'Week' },
  { value: '4w', label: 'Month' },
  { value: '13w', label: '3 Months' },
  { value: '26w', label: '6 Months' },
  { value: '52w', label: 'Year' },
];

const SEVERITIES: Array<{ value: SeverityKey; label: string }> = [
  { value: 'none', label: 'None (clean)' },
  { value: 'warning', label: 'Warning' },
  { value: 'critical', label: 'Critical' },
];

const SORTS: Array<{ value: SortKey; label: string }> = [
  { value: 'rank', label: 'Best current rank' },
  { value: 'rank_desc', label: 'Worst current rank' },
  { value: 'imp', label: 'Biggest improvement (search volume)' },
  { value: 'decline', label: 'Biggest decline (search volume)' },
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
  /** Whole-word (default, fast) vs broad substring (opt-in, slower). */
  qMode: 'word' | 'broad';
  rankBest: string;
  rankWorst: string;
  jump: JumpKey | '';
  jumpMetric: JumpMetric;
  /** Numeric string; only used when jump === 'custom'. */
  jumpFrom: string;
  /** Numeric string; only used when jump === 'custom'. */
  jumpTo: string;
  category: string;
  leafPaths: string[];
  /** Whether the leaf-categories filter is in individual-leaf or custom-category mode. */
  leafMode: 'leaf' | 'custom';
  customCategoryIds: string[];
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
    qMode: f.qMode,
    rankBest: f.rankMin?.toString() ?? '',
    rankWorst: f.rankMax?.toString() ?? '',
    jump: f.jump ?? '',
    jumpMetric: f.jumpMetric,
    jumpFrom: f.jumpFrom?.toString() ?? '',
    jumpTo: f.jumpTo?.toString() ?? '',
    category: f.category ?? '',
    leafPaths: f.leafPaths,
    leafMode: f.customCategoryIds.length > 0 ? 'custom' : 'leaf',
    customCategoryIds: f.customCategoryIds,
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
  // qmode only affects results alongside an active q; emit it only then to keep URLs clean.
  if (p.q.trim().length >= 3 && p.qMode === 'broad') params.set('qmode', 'broad');
  if (p.rankBest) params.set('rank_min', p.rankBest);
  if (p.rankWorst) params.set('rank_max', p.rankWorst);
  if (p.jumpMetric === 'volume') params.set('jump_metric', 'volume');
  if (p.jump) {
    params.set('jump', p.jump);
    if (p.jump === 'custom') {
      if (p.jumpFrom) params.set('jump_from', p.jumpFrom);
      if (p.jumpTo) params.set('jump_to', p.jumpTo);
    }
  }
  if (p.category) params.set('category', p.category);
  if (p.leafMode === 'custom') {
    if (p.customCategoryIds.length > 0) params.set('custom', p.customCategoryIds.join(','));
  } else if (p.leafPaths.length > 0) {
    for (const path of p.leafPaths) params.append('leaf', path);
  }
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
  customCategories = [],
}: {
  filters: ExplorerFilters;
  categories: string[];
  leafCategories: string[];
  customCategories?: { id: string; name: string; leafPaths: string[] }[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [pending, setPending] = useState<PendingFilters>(filtersToPending(filters));

  const apply = () => {
    // Apply always produces a URL with no `view=<id>` tag. When the
    // user is editing a loaded view, this means the chip in the top
    // toolbar blanks out — they're no longer "on" the view. To save
    // the modified state, they use the Save view button in the toolbar
    // (or, with the v1 model, delete-and-resave to replace the
    // existing view).
    const params = pendingToParams(pending);
    const qs = params.toString();
    startTransition(() => {
      router.replace(qs ? `/explorer?${qs}` : '/explorer', { scroll: false });
    });
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
    <>
      <LoadingOverlay show={isPending} />
      <aside className="sticky top-[100px] flex h-[calc(100vh-100px)] w-72 flex-col self-start border-r border-slate-200 bg-white">
      {/* Scrollable filter content area */}
      <div className="flex-1 overflow-y-auto p-4 space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-700">Filters</h2>
        {isPending && <span className="text-xs text-gray-400">Updating…</span>}
      </div>

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

        {/* Whole-word (default, fast) vs broad substring (opt-in, slower). */}
        <div className="mt-2 flex overflow-hidden rounded-full border border-slate-300 text-xs font-medium">
          <button
            type="button"
            onClick={() => set('qMode', 'word')}
            className={`flex-1 px-2 py-1 ${
              pending.qMode === 'word'
                ? 'bg-[#0B1E3A] text-white'
                : 'bg-white text-gray-700 hover:bg-slate-50'
            }`}
          >
            Whole word
          </button>
          <button
            type="button"
            onClick={() => set('qMode', 'broad')}
            className={`flex-1 border-l border-slate-300 px-2 py-1 ${
              pending.qMode === 'broad'
                ? 'bg-[#0B1E3A] text-white'
                : 'bg-white text-gray-700 hover:bg-slate-50'
            }`}
          >
            Broad (slower)
          </button>
        </div>
        {pending.qMode === 'broad' ? (
          <p className="text-xs text-amber-700 mt-1">
            Broad matches the letters anywhere (e.g. “air” inside “chair”). It scans every
            keyword, so this filter can take up to ~2 minutes.
          </p>
        ) : (
          <p className="text-xs text-gray-500 mt-1">
            Whole word matches the term as a full word (e.g. “air”, not “chair”). Fast.
          </p>
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

      {/* Movement card — metric toggle + window + preset + optional custom inputs */}
      <div className="space-y-3 rounded-xl border border-slate-200 bg-[#FAFBFD] p-3">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Movement</p>

        {/* Metric toggle */}
        <div className="flex overflow-hidden rounded-full border border-slate-300 text-xs font-medium">
          <button
            type="button"
            onClick={() => setPending((p) => ({ ...p, jumpMetric: 'rank', jump: '', jumpFrom: '', jumpTo: '' }))}
            className={`flex-1 px-2 py-1 ${
              pending.jumpMetric === 'rank'
                ? 'bg-[#0B1E3A] text-white'
                : 'bg-white text-gray-700 hover:bg-slate-50'
            }`}
          >
            Rank
          </button>
          <button
            type="button"
            onClick={() => setPending((p) => ({ ...p, jumpMetric: 'volume', jump: '', jumpFrom: '', jumpTo: '' }))}
            className={`flex-1 border-l border-slate-300 px-2 py-1 ${
              pending.jumpMetric === 'volume'
                ? 'bg-[#0B1E3A] text-white'
                : 'bg-white text-gray-700 hover:bg-slate-50'
            }`}
          >
            Volume
          </button>
        </div>

        {/* Window */}
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

        {/* Preset */}
        <FieldGroup label="Threshold jump">
          <select
            value={pending.jump}
            onChange={(e) => set('jump', e.target.value as JumpKey | '')}
            className="filter-input"
          >
            <option value="">Any movement</option>
            {jumpPresetsFor(pending.jumpMetric).map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.label}
              </option>
            ))}
            <option value="custom">Custom…</option>
          </select>
        </FieldGroup>

        {/* Custom inputs — shown only when jump === 'custom' */}
        {pending.jump === 'custom' && (
          <div className="space-y-2">
            <div>
              <label className="block text-xs text-gray-600 mb-1">
                {pending.jumpMetric === 'volume'
                  ? 'Had fewer than (searches/mo)'
                  : 'Was ranked worse than'}
              </label>
              <input
                type="number"
                min={1}
                value={pending.jumpFrom}
                onChange={(e) => set('jumpFrom', e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && apply()}
                placeholder={pending.jumpMetric === 'volume' ? 'e.g. 5000' : 'e.g. 201000'}
                className="filter-input"
                aria-label={
                  pending.jumpMetric === 'volume'
                    ? 'Had fewer than (searches/mo)'
                    : 'Custom jump: was ranked worse than'
                }
              />
            </div>
            <div>
              <label className="block text-xs text-gray-600 mb-1">
                {pending.jumpMetric === 'volume'
                  ? 'Now has more than (searches/mo)'
                  : 'Now ranked better than'}
              </label>
              <input
                type="number"
                min={1}
                value={pending.jumpTo}
                onChange={(e) => set('jumpTo', e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && apply()}
                placeholder={pending.jumpMetric === 'volume' ? 'e.g. 15000' : 'e.g. 75000'}
                className="filter-input"
                aria-label={
                  pending.jumpMetric === 'volume'
                    ? 'Now has more than (searches/mo)'
                    : 'Custom jump: now ranked better than'
                }
              />
            </div>
          </div>
        )}
      </div>

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
        {/* Leaf | Custom segmented toggle */}
        <div className="mb-2 flex overflow-hidden rounded-full border border-slate-300 text-xs font-medium">
          <button
            type="button"
            onClick={() => set('leafMode', 'leaf')}
            className={`flex-1 px-2 py-1 ${
              pending.leafMode === 'leaf'
                ? 'bg-[#0B1E3A] text-white'
                : 'bg-white text-gray-700 hover:bg-slate-50'
            }`}
          >
            Leaf
          </button>
          <button
            type="button"
            onClick={() => set('leafMode', 'custom')}
            className={`flex-1 border-l border-slate-300 px-2 py-1 ${
              pending.leafMode === 'custom'
                ? 'bg-[#0B1E3A] text-white'
                : 'bg-white text-gray-700 hover:bg-slate-50'
            }`}
          >
            Custom
          </button>
        </div>

        {pending.leafMode === 'leaf' ? (
          <>
            <LeafCategoryTypeahead
              options={leafCategories}
              selected={pending.leafPaths}
              onChange={(next) => set('leafPaths', next)}
            />
            <p className="text-xs text-gray-500 mt-1">
              Long-tail category for the most-clicked product. {leafCategories.length.toLocaleString()} options —
              type to search, click or Enter to add. Multiple categories match with OR.
            </p>
          </>
        ) : (
          <>
            {customCategories.length === 0 ? (
              <p className="text-xs text-gray-400 mt-1">
                No custom categories yet — build one in the Category Builder tab.
              </p>
            ) : (
              <>
                <div className="space-y-1">
                  {customCategories.map((c) => (
                    <label key={c.id} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={pending.customCategoryIds.includes(c.id)}
                        onChange={() => {
                          set(
                            'customCategoryIds',
                            pending.customCategoryIds.includes(c.id)
                              ? pending.customCategoryIds.filter((id) => id !== c.id)
                              : [...pending.customCategoryIds, c.id],
                          );
                        }}
                      />
                      <span>
                        {c.name}{' '}
                        <span className="text-gray-400">({c.leafPaths.length})</span>
                      </span>
                    </label>
                  ))}
                </div>
                {(() => {
                  const selectedCats = customCategories.filter((c) =>
                    pending.customCategoryIds.includes(c.id),
                  );
                  const selectedCount = selectedCats.length;
                  const uniqueLeaves = new Set(selectedCats.flatMap((c) => c.leafPaths)).size;
                  return selectedCount > 0 ? (
                    <p className="text-xs text-gray-500 mt-1">
                      {selectedCount} selected → {uniqueLeaves} leaves
                    </p>
                  ) : null;
                })()}
              </>
            )}
          </>
        )}
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
      <div className="border-t bg-white p-3 flex items-center gap-2 shadow-[0_-2px_4px_rgba(0,0,0,0.04)]">
        <button
          type="button"
          onClick={apply}
          disabled={!dirty || isPending}
          className="flex-1 rounded-full bg-amber-300 px-3 py-2 text-sm font-semibold text-[#0B1E3A] hover:bg-amber-200 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
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

      <style jsx>{`
        .filter-input {
          width: 100%;
          border: 1px solid #cbd5e1;
          border-radius: 8px;
          padding: 5px 9px;
          font-size: 13px;
          background: white;
        }
        .filter-input:focus {
          outline: 2px solid #3b82f6;
          outline-offset: -1px;
        }
      `}</style>
    </aside>
    </>
  );
}

function FieldGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</label>
      {children}
    </div>
  );
}
