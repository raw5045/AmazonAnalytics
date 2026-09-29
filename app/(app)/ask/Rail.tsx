'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ASK_MODELS, type AskModelId } from '@/lib/ask/models';
import { CHAT_CAP_MESSAGE, DELETE_FAILED_MESSAGE } from '@/lib/ask/messages';

export interface RailConversation { id: string; title: string; model: AskModelId; updatedAt: string }

function modelLabel(id: AskModelId): string {
  return ASK_MODELS.find((m) => m.id === id)?.label.split(' (')[0] ?? id;
}

/** Spec §11.2: newest first, New chat disabled at five, one-step delete confirm. Collapses under the thread on narrow screens via the grid in AskAi. */
export function Rail({ conversations, openId, atCap }: { conversations: RailConversation[]; openId: string | null; atCap: boolean }) {
  const router = useRouter();
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Task 9 D8. A 409 means a turn is still settling/saving under the lock, most often right after
   * Stop (Task 8 review's "Notes for later tasks") — its JSON body's `error` is BUSY_MESSAGE, shown
   * verbatim so the member sees the real reason instead of the generic line. 404 counts as success:
   * the chat is already gone. Anything else (network failure, 500) gets the generic line.
   */
  async function remove(id: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/ask/conversations/${id}`, { method: 'DELETE' });
      if (res.ok || res.status === 404) {
        setConfirmId(null);
        if (id === openId) router.replace('/ask');
        router.refresh();
        return;
      }
      if (res.status === 409) {
        const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
        setError(typeof body?.error === 'string' && body.error ? body.error : DELETE_FAILED_MESSAGE);
      } else {
        setError(DELETE_FAILED_MESSAGE);
      }
    } catch {
      setError(DELETE_FAILED_MESSAGE);
    } finally {
      setBusy(false);
    }
  }

  const button = 'rounded border border-slate-300 bg-white px-2 py-0.5 text-xs hover:bg-slate-50 disabled:opacity-60';
  return (
    <aside aria-label="Your chats" className="flex flex-col gap-3">
      <Link
        href="/ask"
        aria-disabled={atCap}
        onClick={(e) => { if (atCap) e.preventDefault(); }}
        className={`rounded-md px-3 py-2 text-center text-sm font-semibold ${atCap ? 'cursor-not-allowed bg-slate-200 text-slate-500' : 'bg-[#0B1E3A] text-white hover:bg-[#13294f]'}`}
      >
        New chat
      </Link>
      {atCap && <p className="text-xs text-amber-800">{CHAT_CAP_MESSAGE}</p>}
      <ul className="flex flex-col gap-1">
        {conversations.map((c) => (
          <li key={c.id} className={`rounded-md border p-2 text-sm ${c.id === openId ? 'border-sky-300 bg-white' : 'border-transparent hover:bg-white'}`}>
            <Link href={`/ask?c=${c.id}`} className="block truncate font-medium text-slate-800">{c.title}</Link>
            <div className="mt-1 flex items-center justify-between gap-2 text-xs text-slate-500">
              <span><span className="rounded bg-slate-100 px-1.5 py-0.5">{modelLabel(c.model)}</span> · {c.updatedAt.slice(0, 10)}</span>
              {confirmId === c.id ? (
                <span className="flex items-center gap-1">
                  <span className="text-slate-700">Delete this chat? It cannot be undone.</span>
                  <button type="button" className={button} disabled={busy} onClick={() => remove(c.id)}>Delete</button>
                  <button type="button" className={button} disabled={busy} onClick={() => setConfirmId(null)}>Cancel</button>
                </span>
              ) : (
                <button type="button" aria-label={`Delete ${c.title}`} className={button} onClick={() => setConfirmId(c.id)}>Delete</button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    </aside>
  );
}
