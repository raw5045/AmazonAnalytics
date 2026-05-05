'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState, useTransition, type FormEvent } from 'react';
import type {
  ExplorerFilters,
  JumpKey,
  SeverityKey,
  SortKey,
  TitleMatchMode,
  WindowKey,
} from '@/lib/explorer/types';

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

export function FilterSidebar({
  filters,
  categories,
}: {
  filters: ExplorerFilters;
  categories: string[];
}) {
  const router = useRouter();
  const sp = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const [qInput, setQInput] = useState(filters.q ?? '');
  const [rankMinInput, setRankMinInput] = useState(filters.rankMin?.toString() ?? '');
  const [rankMaxInput, setRankMaxInput] = useState(filters.rankMax?.toString() ?? '');

  const update = (mutate: (params: URLSearchParams) => void) => {
    const params = new URLSearchParams(sp?.toString());
    mutate(params);
    // Any filter change resets to page 1.
    params.delete('page');
    startTransition(() => {
      router.replace(`/explorer?${params.toString()}`, { scroll: false });
    });
  };

  const setOrDelete = (key: string, value: string | null) => {
    update((p) => {
      if (value === null || value === '') p.delete(key);
      else p.set(key, value);
    });
  };

  const submitText = (e: FormEvent) => {
    e.preventDefault();
    setOrDelete('q', qInput.trim() || null);
  };

  const submitRanks = (e: FormEvent) => {
    e.preventDefault();
    update((p) => {
      const min = rankMinInput.trim();
      const max = rankMaxInput.trim();
      if (min) p.set('rank_min', min);
      else p.delete('rank_min');
      if (max) p.set('rank_max', max);
      else p.delete('rank_max');
    });
  };

  const toggleSeverity = (sev: SeverityKey) => {
    const next = filters.severities.includes(sev)
      ? filters.severities.filter((s) => s !== sev)
      : [...filters.severities, sev];
    if (next.length === 0) return;
    setOrDelete('severity', next.length === 3 ? null : next.join(','));
  };

  const toggleTitleSlot = (slot: number) => {
    const next = filters.titleSlots.includes(slot)
      ? filters.titleSlots.filter((s) => s !== slot)
      : [...filters.titleSlots, slot].sort();
    if (next.length === 0) return;
    setOrDelete('titles', next.join(',') === '1,2,3' ? null : next.join(','));
  };

  return (
    <aside className="w-72 border-r p-4 space-y-5 sticky top-0 self-start">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-700">Filters</h2>
        {isPending && <span className="text-xs text-gray-400">Updating…</span>}
      </div>

      <FieldGroup label="Window">
        <select
          value={filters.window}
          onChange={(e) => setOrDelete('window', e.target.value === '1w' ? null : e.target.value)}
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
          value={filters.sort}
          onChange={(e) => setOrDelete('sort', e.target.value === 'rank' ? null : e.target.value)}
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
        <form onSubmit={submitText}>
          <input
            type="text"
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            onBlur={submitText}
            placeholder="≥ 3 characters"
            className="filter-input"
          />
        </form>
        {qInput.length > 0 && qInput.length < 3 && (
          <p className="text-xs text-gray-500 mt-1">Type at least 3 characters to filter by text.</p>
        )}
      </FieldGroup>

      <FieldGroup label="Current rank">
        <form onSubmit={submitRanks} className="flex gap-2">
          <input
            type="number"
            min={1}
            value={rankMinInput}
            onChange={(e) => setRankMinInput(e.target.value)}
            onBlur={submitRanks}
            placeholder="min"
            className="filter-input flex-1"
          />
          <input
            type="number"
            min={1}
            value={rankMaxInput}
            onChange={(e) => setRankMaxInput(e.target.value)}
            onBlur={submitRanks}
            placeholder="max"
            className="filter-input flex-1"
          />
        </form>
      </FieldGroup>

      <FieldGroup label="Threshold jump">
        <select
          value={filters.jump ?? ''}
          onChange={(e) => setOrDelete('jump', e.target.value || null)}
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
          value={filters.category ?? ''}
          onChange={(e) => setOrDelete('category', e.target.value || null)}
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
                checked={filters.severities.includes(s.value)}
                onChange={() => toggleSeverity(s.value)}
              />
              {s.label}
            </label>
          ))}
        </div>
      </FieldGroup>

      <FieldGroup label="Title-gap filter">
        <select
          value={filters.titleMatchMode ?? ''}
          onChange={(e) => setOrDelete('title_match', e.target.value || null)}
          className="filter-input"
        >
          {TITLE_MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
        {filters.titleMatchMode && (
          <div className="mt-2 flex gap-3">
            {[1, 2, 3].map((slot) => (
              <label key={slot} className="flex items-center gap-1 text-sm">
                <input
                  type="checkbox"
                  checked={filters.titleSlots.includes(slot)}
                  onChange={() => toggleTitleSlot(slot)}
                />
                #{slot}
              </label>
            ))}
          </div>
        )}
      </FieldGroup>

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
