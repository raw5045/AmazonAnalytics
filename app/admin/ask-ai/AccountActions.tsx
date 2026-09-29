'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

async function post(body: unknown): Promise<string | null> {
  const res = await fetch('/api/admin/ask-ai/accounts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (res.ok) return null;
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  return data?.error ?? `HTTP ${res.status}`;
}

export function AccountActions({ userId, access, allowanceUsd }: { userId: string; access: boolean; allowanceUsd: number }) {
  const router = useRouter();
  const [allowance, setAllowance] = useState(String(allowanceUsd));
  const [credit, setCredit] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (body: unknown) => {
    setBusy(true);
    setError(null);
    const err = await post(body).catch(() => 'Request failed');
    setBusy(false);
    if (err) setError(err);
    else router.refresh();
  };
  const input = 'w-20 rounded border border-gray-300 px-1 py-0.5 text-sm';
  const button = 'rounded border border-gray-300 bg-white px-2 py-0.5 text-xs hover:bg-gray-50 disabled:opacity-60';
  return (
    <div className="flex flex-col gap-1 text-xs">
      <div className="flex items-center gap-1">
        <label>Allowance $<input aria-label="Allowance $" className={input} value={allowance} onChange={(e) => setAllowance(e.target.value)} /></label>
        <button type="button" className={button} disabled={busy} onClick={() => run({ action: 'set_allowance', userId, amountUsd: Number(allowance) })}>Set</button>
      </div>
      <div className="flex items-center gap-1">
        <label>Credit $<input aria-label="Credit $" className={input} value={credit} onChange={(e) => setCredit(e.target.value)} /></label>
        <label>Note<input aria-label="Note" className="w-32 rounded border border-gray-300 px-1 py-0.5 text-sm" value={note} onChange={(e) => setNote(e.target.value)} /></label>
        <button type="button" className={button} disabled={busy} onClick={() => run({ action: 'add_credit', userId, amountUsd: Number(credit), note })}>Add</button>
      </div>
      <div>
        {access ? (
          <button type="button" className={button} disabled={busy} onClick={() => run({ action: 'revoke', userId })}>Revoke</button>
        ) : (
          <button type="button" className={button} disabled={busy} onClick={() => run({ action: 'grant', userId })}>Grant</button>
        )}
      </div>
      {error && <p role="alert" className="text-red-700">{error}</p>}
    </div>
  );
}
