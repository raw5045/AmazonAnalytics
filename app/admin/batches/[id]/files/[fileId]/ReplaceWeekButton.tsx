'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function ReplaceWeekButton({ fileId, replacesFileId }: { fileId: string; replacesFileId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function onClick() {
    if (!confirm('Replace the existing week with this file? Old data will be deleted.')) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/files/${fileId}/replace`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ replacesFileId }),
      });
      if (!res.ok) throw new Error('replace failed');
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button
        onClick={onClick}
        disabled={busy}
        className="rounded bg-amber-600 px-3 py-1 text-sm text-white disabled:opacity-50"
      >
        {busy ? 'Replacing…' : 'Replace this week'}
      </button>
      {error && <p className="text-red-600 text-xs mt-1">{error}</p>}
    </div>
  );
}
