'use client';
import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ASK_MODELS, type AskModelId } from '@/lib/ask/models';
import { CHAT_CAP_MESSAGE, DELETE_FAILED_MESSAGE } from '@/lib/ask/messages';
import { groupConversations, useLocalDayKey } from './railGroups';

export interface RailConversation { id: string; title: string; model: AskModelId; updatedAt: string }

function modelLabel(id: AskModelId): string {
  return ASK_MODELS.find((m) => m.id === id)?.label.split(' (')[0] ?? id;
}

/**
 * Spec 2026-10-04 §3: the page's h1 and the admin chip, New chat (disabled at five with the cap
 * line), the chats grouped by local day (one unlabelled group until the member's day is known —
 * railGroups), each row with its one-step delete confirm, and a footer slot for the switches and
 * the meter. Fills whatever height its parent gives it (AskAi: a sticky column on md+, a drawer
 * below) and scrolls its list in the middle. The 409/404/error handling of a delete is unchanged
 * (Task 9 D8): a 409's body is the real reason, 404 counts as success, anything else the generic line.
 */
export function Rail({ conversations, openId, atCap, onNavigate, preview = false, footer }: {
  conversations: RailConversation[]; openId: string | null; atCap: boolean; onNavigate: () => void;
  /** Admin preview chip next to the title (page.tsx: an admin while no member has access). */
  preview?: boolean;
  /** The rail's bottom block (AskAi passes the Approvals switches and the usage meter). */
  footer?: ReactNode;
}) {
  const router = useRouter();
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const todayKey = useLocalDayKey();
  const groups = groupConversations(conversations, todayKey);

  async function remove(id: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/ask/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (res.ok || res.status === 404) {
        setConfirmId(null);
        // M3 (round-3): replace OR refresh, never both — deleting the OPEN chat already triggers a
        // fresh render via the URL change (a force-dynamic route); deleting another chat needs its
        // own refresh to update the list.
        if (id === openId) router.replace('/ask');
        else router.refresh();
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

  const small = 'rounded px-1.5 py-0.5 text-[11px] hover:bg-white disabled:opacity-60';
  return (
    <aside aria-label="Your chats" className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 px-4 pt-4">
        <h1 className="text-[15px] font-bold">Ask AI</h1>
        {preview && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">Admin preview</span>}
      </div>
      <div className="px-4 pt-3">
        <Link
          href="/ask"
          aria-disabled={atCap}
          onClick={(e) => { if (atCap) e.preventDefault(); else onNavigate(); }}
          className={`block rounded-md px-3 py-2 text-center text-sm font-semibold ${atCap ? 'cursor-not-allowed bg-slate-200 text-slate-500' : 'bg-[#0B1E3A] text-white hover:bg-[#13294f]'}`}
        >
          New chat
        </Link>
        {atCap && <p className="mt-2 text-xs text-amber-800">{CHAT_CAP_MESSAGE}</p>}
      </div>
      <div className="mt-3 min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {groups.map((group, index) => (
          <section key={group.label ?? 'all'} aria-label={group.label ?? 'Chats'} className={index > 0 ? 'mt-4' : undefined}>
            {group.label && <h2 className="px-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{group.label}</h2>}
            <ul className="mt-1 flex flex-col gap-1">
              {group.items.map((c) => (
                <li key={c.id} className={`rounded-md border px-2 py-1.5 text-sm ${c.id === openId ? 'border-sky-300 bg-white' : 'border-transparent hover:bg-white'}`}>
                  <Link href={`/ask?c=${encodeURIComponent(c.id)}`} onClick={onNavigate} className="block truncate font-medium text-slate-800">{c.title}</Link>
                  {confirmId === c.id ? (
                    <div key="confirm" className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-slate-700">
                      <span>Delete this chat? It cannot be undone.</span>
                      {/* Autofocus + a specific name (item 10 M8): the confirm step replaces the Delete control in place. The two rows' keys make this a fresh mount: autoFocus only acts on mount, and without them React would reuse the Delete button's node. */}
                      <button type="button" autoFocus aria-label={`Confirm delete ${c.title}`} className={`${small} border border-slate-300 bg-white text-slate-800`} disabled={busy} onClick={() => remove(c.id)}>Delete</button>
                      <button type="button" className={`${small} border border-slate-300 bg-white text-slate-800`} disabled={busy} onClick={() => setConfirmId(null)}>Cancel</button>
                    </div>
                  ) : (
                    <div key="meta" className="mt-0.5 flex items-center justify-between gap-2 text-[11px] text-slate-500">
                      <span><span className="rounded bg-slate-100 px-1 py-px">{modelLabel(c.model)}</span> · {c.updatedAt.slice(0, 10)}</span>
                      <button type="button" aria-label={`Delete ${c.title}`} className={`${small} text-slate-400 hover:text-slate-800 focus-visible:text-slate-800`} onClick={() => setConfirmId(c.id)}>Delete</button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}
        {error && <p role="alert" className="mt-2 px-2 text-sm text-red-700">{error}</p>}
      </div>
      {footer && <div data-rail-footer className="border-t border-slate-200 px-4 py-3">{footer}</div>}
    </aside>
  );
}
