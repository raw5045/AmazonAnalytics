'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function BatchActions({ batchId, status }: { batchId: string; status: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function call(endpoint: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(endpoint, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'action failed');
    } finally {
      setBusy(false);
    }
  }

  const canImport = ['clean', 'partial_review'].includes(status);
  const canCancel = !['imported', 'failed', 'importing'].includes(status);

  return (
    <div className="flex items-center gap-4">
      <button
        onClick={() => call(`/api/admin/batches/${batchId}/import`)}
        disabled={!canImport || busy}
        className="rounded bg-green-600 px-4 py-2 text-white disabled:opacity-50"
      >
        Import valid files
      </button>
      <button
        onClick={() => call(`/api/admin/batches/${batchId}/cancel`)}
        disabled={!canCancel || busy}
        className="rounded bg-red-600 px-4 py-2 text-white disabled:opacity-50"
      >
        Cancel batch
      </button>
      {error && <span className="text-red-600">{error}</span>}
    </div>
  );
}
