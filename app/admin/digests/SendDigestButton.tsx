// app/admin/digests/SendDigestButton.tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

type Phase = 'idle' | 'firing' | 'sent' | 'failed';

/**
 * Send / Retry / Resume button for the current week's digest. Mirrors
 * KeepaEnrichmentButton's idle/firing/sent/failed pattern. The label +
 * confirm copy depend on the current run status:
 *   - null / undefined        → "Send digest"
 *   - 'sent_with_failures'     → "Retry failures"
 *   - 'sending' (stale)        → "Resume send" (retry mode)
 * 'sent' shows nothing (already done).
 */
export function SendDigestButton({
  weekEndDate,
  runStatus,
  recipientCount,
}: {
  weekEndDate: string;
  runStatus: string | null;
  recipientCount: number;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);

  if (runStatus === 'sent') {
    return <span className="text-xs text-gray-400">—</span>;
  }

  const isRetry = runStatus === 'sent_with_failures' || runStatus === 'sending';
  const label =
    runStatus === 'sent_with_failures' ? 'Retry failures'
    : runStatus === 'sending' ? 'Resume send'
    : 'Send digest';

  async function fire() {
    const confirmMsg =
      `Send the weekly digest for ${weekEndDate} to all subscribed users? ` +
      `This emails ${recipientCount} recipient${recipientCount === 1 ? '' : 's'} and can't be unsent.`;
    if (!confirm(confirmMsg)) return;
    setError(null);
    setPhase('firing');
    try {
      const res = await fetch('/api/admin/digests/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ weekEndDate, retry: isRetry }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setPhase('sent');
      // The Inngest event is fire-and-forget; refresh to pick up the
      // run row's status (the inline hint below covers the brief gap
      // before it flips to 'sending').
      router.refresh();
    } catch (e) {
      setPhase('failed');
      setError(e instanceof Error ? e.message : 'unknown error');
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={fire}
        disabled={phase === 'firing' || phase === 'sent'}
        className="self-start rounded bg-blue-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-800 disabled:bg-gray-300 disabled:cursor-not-allowed"
      >
        {phase === 'firing' ? 'Firing…' : phase === 'sent' ? 'Queued ✓' : label}
      </button>
      {phase === 'sent' && (
        <p className="text-xs text-gray-600">Refresh in a moment to see the result.</p>
      )}
      {phase === 'failed' && error && <p className="text-xs text-red-700">Failed: {error}</p>}
    </div>
  );
}
