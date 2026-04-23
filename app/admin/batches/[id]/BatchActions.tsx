'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function BatchActions({ batchId, status }: { batchId: string; status: string }) {
  const [busy, setBusy] = useState<'import' | 'cancel' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function handleImport() {
    setBusy('import');
    setError(null);
    try {
      const res = await fetch(`/api/admin/batches/${batchId}/import`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'import failed');
    } finally {
      setBusy(null);
    }
  }

  async function handleCancel() {
    if (!confirm('Cancel this batch? All uploaded files will be deleted from storage and the batch will be removed.')) {
      return;
    }
    setBusy('cancel');
    setError(null);
    try {
      const res = await fetch(`/api/admin/batches/${batchId}/cancel`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const body = await res.json().catch(() => ({}));
      // Cancel deleted the batch — redirect to history page since this URL no longer exists
      const target = body.redirectTo ?? '/admin/batches';
      router.push(target);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'cancel failed');
      setBusy(null);
    }
    // Note: don't clear `busy` on success path — we're navigating away
  }

  const canImport = ['clean', 'partial_review'].includes(status);
  const canCancel = !['imported', 'imported_partial', 'importing'].includes(status);

  return (
    <div className="flex items-center gap-4">
      <button
        onClick={handleImport}
        disabled={!canImport || busy !== null}
        className="rounded bg-green-600 px-4 py-2 text-white disabled:opacity-50"
      >
        {busy === 'import' ? 'Importing…' : 'Import valid files'}
      </button>
      <button
        onClick={handleCancel}
        disabled={!canCancel || busy !== null}
        className="rounded bg-red-600 px-4 py-2 text-white disabled:opacity-50"
      >
        {busy === 'cancel' ? 'Cancelling…' : 'Cancel batch'}
      </button>
      {error && <span className="text-red-600">{error}</span>}
    </div>
  );
}
