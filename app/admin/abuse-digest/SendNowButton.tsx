'use client';

import { useState } from 'react';

/** Posts the page's displayed day to the force-send route and shows the result. */
export function SendNowButton({ day }: { day: string }) {
  const [state, setState] = useState<'idle' | 'sending' | 'done' | 'error'>('idle');
  const [detail, setDetail] = useState<string>('');

  async function send() {
    setState('sending');
    setDetail('');
    try {
      const res = await fetch('/api/admin/abuse-digest/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ day }),
      });
      const json = await res.json();
      if (!res.ok) {
        setState('error');
        setDetail(json.error ?? `HTTP ${res.status}`);
        return;
      }
      setState('done');
      setDetail(
        json.sent
          ? `Sent to ${json.recipients} admin${json.recipients === 1 ? '' : 's'} (${json.flags} flags).`
          : `Not sent: ${json.skipped ?? 'unknown'}`,
      );
    } catch (e) {
      setState('error');
      setDetail(e instanceof Error ? e.message : 'request failed');
    }
  }

  return (
    <span className="inline-flex items-center gap-3">
      <button
        onClick={send}
        disabled={state === 'sending'}
        className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {state === 'sending' ? 'Sending…' : `Send now (${day})`}
      </button>
      {detail && (
        <span className={`text-sm ${state === 'error' ? 'text-red-700' : 'text-gray-600'}`}>{detail}</span>
      )}
    </span>
  );
}
