'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function ApproveSchemaButton({
  schemaVersionId,
  fileId,
}: {
  schemaVersionId: string;
  fileId: string;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function handleApprove() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/schema/${schemaVersionId}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fileId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? 'Approval failed');
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Approval failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <button
        onClick={handleApprove}
        disabled={submitting}
        className="rounded bg-green-600 px-4 py-2 text-white disabled:opacity-50"
      >
        {submitting ? 'Approving…' : 'Approve as active schema'}
      </button>
      {error && <p className="mt-2 text-red-600">{error}</p>}
    </div>
  );
}
