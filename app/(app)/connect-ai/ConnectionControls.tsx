'use client';
import { useState } from 'react';

type Status = 'enabled' | 'disconnected';

/** Disconnect / Reconnect for the app-level MCP record (amendment §3.4). */
export function ConnectionControls({ initialStatus }: { initialStatus: Status }) {
  const [status, setStatus] = useState<Status>(initialStatus);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const next = status === 'enabled' ? 'disconnect' : 'reconnect';

  async function act() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/mcp/connection', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: next }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { status: Status };
      setStatus(data.status);
    } catch {
      setError('Could not update the connection right now. Try again in a minute.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-slate-700">
        MCP access for this account is <strong>{status === 'enabled' ? 'enabled' : 'disconnected'}</strong>.
      </p>
      <button
        type="button"
        onClick={act}
        disabled={busy}
        className="w-fit rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-60"
      >
        {status === 'enabled' ? 'Disconnect' : 'Reconnect'}
      </button>
      {status === 'disconnected' && (
        <p className="text-xs text-slate-500">
          Reconnect lets an existing token work again. To force a fresh consent screen, remove the connector inside
          Claude or ChatGPT and add it again.
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
