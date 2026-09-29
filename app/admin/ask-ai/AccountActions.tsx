'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

async function post(body: unknown): Promise<string | null> {
  const res = await fetch('/api/admin/ask-ai/accounts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (res.ok) return null;
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  return data?.error ?? `HTTP ${res.status}`;
}

const DOLLAR_ERROR = 'Enter a dollar amount.';

/**
 * Spec §11.5 row actions. Revoke and Add credit get a one-step inline confirm — the two actions
 * with a real, not-easily-undone consequence (cutting off access; an irreversible-in-effect spend)
 * — mirroring app/(app)/ask/Rail.tsx's delete confirm; Set allowance and Grant run immediately
 * (Task 10 review, S4a). Every action shows a success line on completion (S4b).
 */
export function AccountActions({ userId, access, allowanceUsd }: { userId: string; access: boolean; allowanceUsd: number }) {
  const router = useRouter();
  const [allowance, setAllowance] = useState(String(allowanceUsd));
  const [credit, setCredit] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<'revoke' | 'credit' | null>(null);

  const run = async (body: unknown, successMessage: string, onSuccess?: () => void) => {
    setBusy(true);
    setError(null);
    setStatus(null);
    const err = await post(body).catch(() => 'Request failed');
    setBusy(false);
    if (err) {
      setError(err);
      return;
    }
    setConfirming(null);
    setStatus(successMessage);
    onSuccess?.();
    router.refresh();
  };

  function setAllowanceAction() {
    const amountUsd = Number.parseFloat(allowance);
    // Never post an empty or non-numeric box (S4d): a NaN amount would otherwise reach the server
    // as an invalid request for no useful reason.
    if (!Number.isFinite(amountUsd)) { setStatus(null); setError(DOLLAR_ERROR); return; }
    void run({ action: 'set_allowance', userId, amountUsd }, 'Saved.');
  }
  function requestAddCredit() {
    const amountUsd = Number.parseFloat(credit);
    if (!Number.isFinite(amountUsd)) { setStatus(null); setError(DOLLAR_ERROR); return; }
    setError(null);
    setConfirming('credit');
  }
  function confirmAddCredit() {
    const amountUsd = Number.parseFloat(credit);
    if (!Number.isFinite(amountUsd)) { setStatus(null); setError(DOLLAR_ERROR); setConfirming(null); return; }
    void run({ action: 'add_credit', userId, amountUsd, note }, 'Credit added.', () => { setCredit(''); setNote(''); });
  }
  function confirmRevoke() {
    void run({ action: 'revoke', userId }, 'Access revoked.');
  }
  function grantAction() {
    void run({ action: 'grant', userId }, 'Access granted.');
  }

  const input = 'w-20 rounded border border-gray-300 px-1 py-0.5 text-sm';
  const button = 'rounded border border-gray-300 bg-white px-2 py-0.5 text-xs hover:bg-gray-50 disabled:opacity-60';
  const creditAmount = Number.parseFloat(credit);
  return (
    <div className="flex flex-col gap-1 text-xs">
      <div className="flex items-center gap-1">
        <label>Allowance $<input aria-label="Allowance $" className={input} value={allowance} onChange={(e) => setAllowance(e.target.value)} /></label>
        <button type="button" className={button} disabled={busy} onClick={setAllowanceAction}>Set</button>
      </div>
      <div className="flex items-center gap-1">
        <label>Credit $<input aria-label="Credit $" className={input} value={credit} onChange={(e) => setCredit(e.target.value)} /></label>
        <label>Note<input aria-label="Note" className="w-32 rounded border border-gray-300 px-1 py-0.5 text-sm" value={note} onChange={(e) => setNote(e.target.value)} /></label>
        {confirming === 'credit' ? (
          <span className="flex items-center gap-1">
            <span className="text-gray-700">Add {Number.isFinite(creditAmount) ? `$${creditAmount}` : 'this'} credit?</span>
            <button type="button" autoFocus className={button} disabled={busy} onClick={confirmAddCredit}>Confirm</button>
            <button type="button" className={button} disabled={busy} onClick={() => setConfirming(null)}>Cancel</button>
          </span>
        ) : (
          <button type="button" className={button} disabled={busy} onClick={requestAddCredit}>Add</button>
        )}
      </div>
      <div>
        {access ? (
          confirming === 'revoke' ? (
            <span className="flex items-center gap-1">
              <span className="text-gray-700">Revoke access for this member?</span>
              <button type="button" autoFocus className={button} disabled={busy} onClick={confirmRevoke}>Confirm</button>
              <button type="button" className={button} disabled={busy} onClick={() => setConfirming(null)}>Cancel</button>
            </span>
          ) : (
            <button type="button" className={button} disabled={busy} onClick={() => setConfirming('revoke')}>Revoke</button>
          )
        ) : (
          <button type="button" className={button} disabled={busy} onClick={grantAction}>Grant</button>
        )}
      </div>
      {error && <p role="alert" className="text-red-700">{error}</p>}
      {status && <p role="status" className="text-green-700">{status}</p>}
    </div>
  );
}
