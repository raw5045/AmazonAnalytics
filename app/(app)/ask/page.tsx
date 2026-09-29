import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { requireAuthenticatedUser } from '@/lib/auth/requireAuthenticatedUser';
import { env } from '@/lib/env';
import { askAiEnabled, DEFAULT_MODEL } from '@/lib/ask/config';
import { askAiEligible } from '@/lib/ask/eligibility';
import { countMemberAccountsWithAccess, getAccount, resetPeriodIfDue } from '@/lib/ask/ledger';
import { listConversations, loadConversation } from '@/lib/ask/conversations';
import { meterFor } from '@/lib/ask/meter';
import { SWITCHED_OFF_MESSAGE } from '@/lib/ask/messages';
import { AskAi } from './AskAi';

export const metadata: Metadata = { title: 'Ask AI' };
export const dynamic = 'force-dynamic';

/** Spec §11. Server: gate, load the rail, the open chat (?c=<uuid>) and the meter; the client component does the rest. */
export default async function AskPage({ searchParams }: { searchParams: Promise<{ c?: string }> }) {
  const user = await requireAuthenticatedUser();
  const isAdmin = user.role === 'admin';
  let account = await getAccount(user.id);
  if (!askAiEligible(user.role, account)) notFound();
  if (!askAiEnabled()) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-8 text-slate-800">
        <h1 className="text-2xl font-bold">Ask AI</h1>
        <section className="mt-4 rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-700">{SWITCHED_OFF_MESSAGE}</section>
      </div>
    );
  }
  if (account) account = (await resetPeriodIfDue(user.id, new Date())) ?? account;
  const sp = await searchParams;
  const openId = sp.c && z.uuid().safeParse(sp.c).success ? sp.c : null;
  const [conversations, open, memberAccounts] = await Promise.all([
    listConversations(user.id),
    openId ? loadConversation(user.id, openId) : Promise.resolve(null),
    isAdmin ? countMemberAccountsWithAccess() : Promise.resolve(1),
  ]);
  const model = open?.conversation.model ?? DEFAULT_MODEL;
  return (
    <AskAi
      conversations={conversations.map((c) => ({ id: c.id, title: c.title, model: c.model, updatedAt: c.updatedAt.toISOString() }))}
      open={open ? { id: open.conversation.id, model: open.conversation.model, messageCount: open.conversation.messageCount, messages: open.messages } : null}
      meter={meterFor(account, model, isAdmin)}
      preview={isAdmin && memberAccounts === 0}
      appOrigin={new URL(env.APP_PUBLIC_URL).origin}
    />
  );
}
