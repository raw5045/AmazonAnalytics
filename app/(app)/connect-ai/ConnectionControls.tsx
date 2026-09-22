'use client';
import { useState } from 'react';

type Status = 'enabled' | 'disconnected';

/** Narrows an unknown response payload's `status` field; anything else (wrong type, wrong value, missing) is not a valid status. */
function asStatus(value: unknown): Status | null {
  return value === 'enabled' || value === 'disconnected' ? value : null;
}

/** Disconnect / Reconnect for the app-level MCP record (amendment §3.4). */
export function ConnectionControls({ initialStatus }: { initialStatus: Status }) {
  const [status, setStatus] = useState<Status>(initialStatus);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const next = status === 'enabled' ? 'disconnect' : 'reconnect';
  const label = next === 'disconnect' ? 'Disconnect' : 'Reconnect';
  const busyLabel = next === 'disconnect' ? 'Disconnecting…' : 'Reconnecting…';

  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/mcp/connection', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: next }),
      });
      if (res.status === 404) {
        setError('MCP access is no longer available for this account.');
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: unknown = await res.json();
      const payloadStatus =
        data !== null && typeof data === 'object' ? asStatus((data as { status?: unknown }).status) : null;
      if (!payloadStatus) throw new Error('Malformed response payload');
      setStatus(payloadStatus);
    } catch {
      setError('Could not update the connection right now. Try again in a minute.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-slate-700" aria-live="polite">
        MCP access for this account is <strong>{status === 'enabled' ? 'enabled' : 'disconnected'}</strong>.
      </p>
      <p className="text-xs text-slate-500">
        Disconnect blocks every MCP request from this account until you reconnect; it does not remove the connector
        from Claude or ChatGPT.
      </p>
      <button
        type="button"
        onClick={toggle}
        disabled={busy}
        aria-busy={busy}
        className="w-fit rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-60"
      >
        {busy ? busyLabel : label}
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
