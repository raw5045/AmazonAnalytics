'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Lightweight modal for naming a saved view. Used by both
 * "Save new" (initialName='') and "Rename" (initialName=existing).
 * Validates non-empty + ≤ 80 chars before letting Submit fire.
 *
 * Closes on Escape + outside-click + Cancel button. Returns the
 * cleaned name to the parent via onSubmit; the parent owns the
 * actual API call + post-success handling.
 */
export function NameViewModal({
  isOpen,
  initialName = '',
  title,
  submitLabel = 'Save',
  errorMessage = null,
  isSubmitting = false,
  onSubmit,
  onClose,
}: {
  isOpen: boolean;
  initialName?: string;
  title: string;
  submitLabel?: string;
  /** Error message from parent (e.g., name conflict, 5-view limit). Null hides. */
  errorMessage?: string | null;
  /** When true, disables the form + shows "Saving…" on the button. */
  isSubmitting?: boolean;
  onSubmit: (name: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [localError, setLocalError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Sync initialName when the modal re-opens with a different value
  useEffect(() => {
    if (isOpen) {
      setName(initialName);
      setLocalError(null);
      // Focus + select after the modal mounts
      setTimeout(() => inputRef.current?.select(), 50);
    }
  }, [isOpen, initialName]);

  // Escape closes
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = name.trim();
    if (clean.length === 0) {
      setLocalError('Name cannot be empty');
      return;
    }
    if (clean.length > 80) {
      setLocalError('Name cannot exceed 80 characters');
      return;
    }
    setLocalError(null);
    onSubmit(clean);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form
        onSubmit={handleSubmit}
        className="bg-white rounded shadow-xl w-full max-w-md p-5"
      >
        <h3 className="text-lg font-semibold text-gray-900">{title}</h3>
        <label className="block mt-4">
          <span className="text-sm text-gray-700">Name</span>
          <input
            ref={inputRef}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={isSubmitting}
            placeholder="e.g., My beauty niche under 100k"
            maxLength={100}
            className="mt-1 w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-2 focus:outline-blue-500"
          />
        </label>
        {(localError || errorMessage) && (
          <p className="mt-2 text-sm text-red-700">{localError ?? errorMessage}</p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="px-3 py-1.5 text-sm border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={isSubmitting || name.trim().length === 0}
            className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
          >
            {isSubmitting ? 'Saving…' : submitLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
