'use client';

import { useEffect } from 'react';

/**
 * Three-choice dialog shown when the user clicks "Save current view"
 * with a view already loaded AND modifications applied:
 *
 *   - Update '[currentName]' — overwrites the existing view's filters
 *   - Save as new…           — opens NameViewModal to create a sibling
 *   - Cancel                 — close the dialog
 *
 * Cancel via Escape + outside-click + Cancel button. Doesn't manage
 * the API call itself — parent provides onUpdate / onSaveAsNew.
 */
export function SaveOrUpdateDialog({
  isOpen,
  currentViewName,
  onUpdate,
  onSaveAsNew,
  onClose,
  isSubmitting = false,
}: {
  isOpen: boolean;
  currentViewName: string;
  onUpdate: () => void;
  onSaveAsNew: () => void;
  onClose: () => void;
  isSubmitting?: boolean;
}) {
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white rounded shadow-xl w-full max-w-md p-5">
        <h3 className="text-lg font-semibold text-gray-900">Save filter changes</h3>
        <p className="mt-2 text-sm text-gray-700">
          You&apos;ve modified the filters on top of <strong>&ldquo;{currentViewName}&rdquo;</strong>.
          How would you like to save?
        </p>
        <div className="mt-5 flex flex-col gap-2">
          <button
            type="button"
            onClick={onUpdate}
            disabled={isSubmitting}
            className="px-3 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-300 text-left"
          >
            Update &ldquo;{currentViewName}&rdquo;
          </button>
          <button
            type="button"
            onClick={onSaveAsNew}
            disabled={isSubmitting}
            className="px-3 py-2 text-sm border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-60 text-left"
          >
            Save as new view…
          </button>
        </div>
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900 disabled:opacity-60"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
