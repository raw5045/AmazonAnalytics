'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type {
  ExplorerFilters,
  JumpKey,
  SeverityKey,
  SortKey,
  TitleMatchMode,
  WindowKey,
} from '@/lib/explorer/types';
import { EXPLORER_DEFAULTS } from '@/lib/explorer/parseFilters';

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
  category: string;
  severities: SeverityKey[];
  titleSlots: number[];
  titleMatchMode: TitleMatchMode | '';
  sort: SortKey;
}

function filtersToPending(f: ExplorerFilters): PendingFilters {
  return {
    window: f.window,
    q: f.q ?? '',
    rankBest: f.rankMin?.toString() ?? '',
    rankWorst: f.rankMax?.toString() ?? '',
    jump: f.jump ?? '',
    category: f.category ?? '',
    severities: f.severities,
    titleSlots: f.titleSlots,
    titleMatchMode: f.titleMatchMode ?? '',
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
  if (p.jump) params.set('jump', p.jump);
  if (p.category) params.set('category', p.category);
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
  return params;
}

export function FilterSidebar({
  filters,
  categories,
}: {
  filters: ExplorerFilters;
  categories: string[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [pending, setPending] = useState<PendingFilters>(filtersToPending(filters));

  const apply = () => {
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
    <aside className="w-72 border-r p-4 space-y-5 sticky top-0 self-start">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-700">Filters</h2>
        {isPending && <span className="text-xs text-gray-400">Updating…</span>}
      </div>

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
      </FieldGroup>

      <FieldGroup label="Top clicked category #1">
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

      <div className="pt-3 border-t flex items-center gap-2">
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
