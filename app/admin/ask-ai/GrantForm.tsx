'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

/** Grant access by email at the default allowance. */
export function GrantForm() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/admin/ask-ai/accounts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'grant', email }) });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      setEmail('');
      setMessage('Granted.');
      router.refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="flex items-center gap-2 text-sm">
      <label>Grant access by email <input aria-label="Member email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="ml-1 w-64 rounded border border-gray-300 px-2 py-1" /></label>
      <button type="submit" disabled={busy} className="rounded border border-gray-300 bg-white px-2 py-1 hover:bg-gray-50 disabled:opacity-60">Grant</button>
      {message && <span role="status">{message}</span>}
    </form>
  );
}
