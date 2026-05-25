'use client';

import { useState } from 'react';

type Phase = 'idle' | 'firing' | 'sent' | 'failed';

export function KeepaEnrichmentButton({ currentWeek }: { currentWeek: string | null }) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [eventId, setEventId] = useState<string | null>(null);

  async function fire() {
    if (!currentWeek) return;
    if (!confirm(`Trigger a FULL Keepa enrichment for ${currentWeek}? This will call the Keepa API for ~140k ASINs and take ~24 hours.`)) {
      return;
    }
    setError(null);
    setEventId(null);
    setPhase('firing');
    try {
      const res = await fetch('/api/admin/keepa-enrichment/fire-full', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ weekEndDate: currentWeek }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setEventId(json.eventId ?? null);
      setPhase('sent');
    } catch (e) {
      setPhase('failed');
      setError(e instanceof Error ? e.message : 'unknown error');
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={fire}
        disabled={!currentWeek || phase === 'firing' || phase === 'sent'}
        className="self-start rounded bg-amber-700 px-4 py-2 text-sm font-medium text-white hover:bg-amber-800 disabled:bg-gray-300 disabled:cursor-not-allowed"
      >
        {phase === 'firing'
          ? 'Firing…'
          : phase === 'sent'
            ? 'Event sent ✓'
            : 'Run full Keepa enrichment now'}
      </button>
      {phase === 'sent' && eventId && (
        <p className="text-xs text-gray-600">
          Event id: <code className="font-mono">{eventId}</code> — watch progress at{' '}
          <a
            href="https://app.inngest.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-700 underline"
          >
            app.inngest.com
          </a>{' '}
          under <code className="font-mono">enrich-keepa-for-week</code>.
        </p>
      )}
      {phase === 'failed' && error && (
        <p className="text-xs text-red-700">Failed: {error}</p>
      )}
    </div>
  );
}
