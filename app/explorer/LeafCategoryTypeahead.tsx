'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * Search-as-you-type combobox for the leaf-category filter. The full
 * list (9k+ entries) is passed in once; filtering happens client-side
 * as the user types. Up to 50 matches shown at once.
 *
 * Keyboard:
 *   - ArrowDown / ArrowUp navigates the dropdown
 *   - Enter selects the highlighted match
 *   - Escape clears the input + closes the dropdown
 *   - Tab / blur closes
 *
 * Mouse:
 *   - Click a match to select it
 *   - X button next to the input clears the current selection
 */
export function LeafCategoryTypeahead({
  options,
  value,
  onChange,
}: {
  options: string[];
  /** The currently-selected category, or '' for none. */
  value: string;
  onChange: (next: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Re-sync the input when the parent's `value` changes externally
  // (e.g., Reset button).
  useEffect(() => {
    setDraft(value);
  }, [value]);

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

  // Filter logic — case-insensitive substring match.
  const matches = useMemo(() => {
    if (draft.trim().length === 0) {
      return options.slice(0, 50);
    }
    const needle = draft.trim().toLowerCase();
    const result: string[] = [];
    for (const opt of options) {
      if (opt.toLowerCase().includes(needle)) {
        result.push(opt);
        if (result.length >= 50) break;
      }
    }
    return result;
  }, [draft, options]);

  // Clamp highlight if matches shrink below it.
  useEffect(() => {
    if (highlight >= matches.length) setHighlight(Math.max(0, matches.length - 1));
  }, [matches.length, highlight]);

  const select = (cat: string) => {
    onChange(cat);
    setDraft(cat);
    setOpen(false);
  };

  const clear = () => {
    onChange('');
    setDraft('');
    setOpen(false);
    inputRef.current?.focus();
  };

  return (
    <div ref={containerRef} className="relative">
      <div className="flex gap-1">
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
                select(matches[highlight]);
              }
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setOpen(false);
              setDraft(value);
            }
          }}
          placeholder={value || 'Type to search 9k+ categories…'}
          className="filter-input flex-1"
          aria-label="Leaf category"
          aria-expanded={open}
          aria-autocomplete="list"
        />
        {value && (
          <button
            type="button"
            onClick={clear}
            className="px-2 text-xs text-gray-500 hover:text-gray-800 border border-gray-300 rounded"
            aria-label="Clear leaf category"
          >
            ×
          </button>
        )}
      </div>
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
                // mousedown rather than click so it fires before the
                // input's blur (which would close the dropdown).
                e.preventDefault();
                select(cat);
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
      {open && matches.length === 0 && (
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
