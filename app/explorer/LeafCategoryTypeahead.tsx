'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * Multi-select search-as-you-type combobox for the leaf-category
 * filter. Selected categories show as chips above the input; typing
 * filters the dropdown of remaining options.
 *
 * Keyboard:
 *   - ArrowDown / ArrowUp navigates the dropdown
 *   - Enter selects the highlighted match (adds chip + clears input)
 *   - Backspace on empty input removes the last chip
 *   - Escape clears the input + closes the dropdown
 *
 * Mouse:
 *   - Click a match to add it as a chip
 *   - Click ×  on a chip to remove it
 */
export function LeafCategoryTypeahead({
  options,
  selected,
  onChange,
}: {
  options: string[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState('');
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const selectedSet = useMemo(() => new Set(selected), [selected]);

  // Close the dropdown on outside-click.
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

  // Case-insensitive substring match, excluding already-selected.
  const matches = useMemo(() => {
    const needle = draft.trim().toLowerCase();
    const result: string[] = [];
    for (const opt of options) {
      if (selectedSet.has(opt)) continue;
      if (needle.length === 0 || opt.toLowerCase().includes(needle)) {
        result.push(opt);
        if (result.length >= 50) break;
      }
    }
    return result;
  }, [draft, options, selectedSet]);

  useEffect(() => {
    if (highlight >= matches.length) setHighlight(Math.max(0, matches.length - 1));
  }, [matches.length, highlight]);

  const addCategory = (cat: string) => {
    if (selectedSet.has(cat)) return;
    onChange([...selected, cat]);
    setDraft('');
    setHighlight(0);
    // Keep dropdown open so the user can add more without re-clicking.
    inputRef.current?.focus();
  };

  const removeCategory = (cat: string) => {
    onChange(selected.filter((c) => c !== cat));
    inputRef.current?.focus();
  };

  return (
    <div ref={containerRef} className="relative">
      {/* Chips for currently-selected categories */}
      {selected.length > 0 && (
        <div className="mb-1 flex flex-wrap gap-1">
          {selected.map((cat) => (
            <span
              key={cat}
              className="inline-flex items-center gap-1 rounded bg-blue-50 border border-blue-200 px-2 py-0.5 text-xs text-blue-900"
            >
              <span className="max-w-[180px] truncate" title={cat}>{cat}</span>
              <button
                type="button"
                onClick={() => removeCategory(cat)}
                className="text-blue-700 hover:text-blue-900 leading-none"
                aria-label={`Remove ${cat}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <input
        ref={inputRef}
        type="text"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setOpen(true);
          setHighlight(0);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
            setHighlight((h) => Math.min(h + 1, matches.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setHighlight((h) => Math.max(h - 1, 0));
          } else if (e.key === 'Enter') {
            if (open && matches[highlight]) {
              e.preventDefault();
              addCategory(matches[highlight]);
            }
          } else if (e.key === 'Backspace' && draft.length === 0 && selected.length > 0) {
            e.preventDefault();
            removeCategory(selected[selected.length - 1]);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            setOpen(false);
            setDraft('');
          }
        }}
        placeholder={selected.length === 0 ? 'Type to search 9k+ categories…' : 'Add another category…'}
        className="filter-input"
        aria-label="Add leaf category"
        aria-expanded={open}
        aria-autocomplete="list"
      />

      {open && matches.length > 0 && (
        <ul
          role="listbox"
          className="absolute z-10 mt-1 max-h-72 w-full overflow-y-auto bg-white border border-gray-300 rounded shadow-lg text-sm"
        >
          {matches.map((cat, i) => (
            <li
              key={cat}
              role="option"
              aria-selected={i === highlight}
              onMouseDown={(e) => {
                e.preventDefault();
                addCategory(cat);
              }}
              onMouseEnter={() => setHighlight(i)}
              className={`px-2 py-1 cursor-pointer ${i === highlight ? 'bg-blue-100' : 'hover:bg-gray-50'}`}
            >
              {cat}
            </li>
          ))}
          {matches.length === 50 && (
            <li className="px-2 py-1 text-xs text-gray-500 italic border-t">
              First 50 matches shown. Type more to narrow.
            </li>
          )}
        </ul>
      )}
      {open && matches.length === 0 && draft.length > 0 && (
        <div className="absolute z-10 mt-1 w-full bg-white border border-gray-300 rounded shadow-lg p-2 text-sm text-gray-500">
          No matches.
        </div>
      )}

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
    </div>
  );
}
