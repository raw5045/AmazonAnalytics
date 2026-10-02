import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { getToolName, isToolUIPart } from 'ai';
import { requireAuthenticatedUser } from '@/lib/auth/requireAuthenticatedUser';
import { env } from '@/lib/env';
import { askAiEnabled, askAiWritesEnabled, ASK_LIMITS, DEFAULT_MODEL } from '@/lib/ask/config';
import { askAiEligible } from '@/lib/ask/eligibility';
import { countMemberAccountsWithAccess, getAccount, resetPeriodIfDue } from '@/lib/ask/ledger';
import { listConversations, loadConversation, type AskUIMessage } from '@/lib/ask/conversations';
import { meterFor } from '@/lib/ask/meter';
import { SWITCHED_OFF_MESSAGE } from '@/lib/ask/messages';
import { CHANGE_TOOLS, DELETE_TOOLS } from '@/lib/ask/writeKinds';
import { AskAi } from './AskAi';

export const metadata: Metadata = { title: 'Ask AI' };
export const dynamic = 'force-dynamic';

/**
 * The client renders only a tool call's compact INPUT (ToolActivity) — never its output, which can
 * be a full page of research rows — and the chat route reloads history itself for the next turn,
 * so the page payload never needs it either. Never ship it to the browser (Task 9 fix round, item
 * 6). `output` is a required field on the `output-available` variant of `ToolUIPart`, so it is set
 * to `undefined` rather than omitted — TypeScript accepts that (this repo does not turn on
 * `exactOptionalPropertyTypes`). This does not remove the key from what is sent to the client:
 * React's server-component serialisation writes an `undefined` prop value as the literal string
 * `"$undefined"`, so the key survives on the wire with no payload behind it (Task 9 fix round 2,
 * item 5 — corrects the "absent from the serialised JSON" claim above).
 *
 * The exception (arc 4): the eight workspace writes keep a reduced output. The approval cards name
 * a view or category from the chat's own results (useWorkspaceNames), so without it a reloaded
 * delete record would show the id's last 8 characters instead of the name. A few dozen bytes
 * (reducedWriteOutput below), where a list or research output can be a page of rows.
 */
function withoutToolOutputs(messages: AskUIMessage[]): AskUIMessage[] {
  return messages.map((m) => ({
    ...m,
    parts: m.parts.map((p) => {
      if (!isToolUIPart(p)) return p;
      const name = getToolName(p);
      const write = CHANGE_TOOLS.has(name) || DELETE_TOOLS.has(name);
      return { ...p, output: write ? reducedWriteOutput(p.output) : undefined };
    }) as AskUIMessage['parts'],
  }));
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * What a workspace write's stored output keeps on a reload (lib/workspace/contracts.ts): the
 * `{ id, name }` of a create/update result's `view` / `category` or a delete result's `deleted` —
 * the keys useWorkspaceNames reads — or the `{ error }` of a failed write, kept so a reloaded record
 * has the outcome the route recorded on the stored message (spec §6); it is the member's own data,
 * and nothing on the client reads it today. Nothing for anything else (a watchlist result, a card
 * still waiting with no output, an output not of the expected shape).
 */
function reducedWriteOutput(output: unknown): unknown {
  if (!isRecord(output)) return undefined;
  if ('error' in output) return { error: output.error };
  for (const key of ['view', 'category', 'deleted'] as const) {
    const item = output[key];
    if (isRecord(item) && typeof item.id === 'string' && typeof item.name === 'string') return { [key]: { id: item.id, name: item.name } };
  }
  return undefined;
}

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
      open={open ? {
        id: open.conversation.id,
        model: open.conversation.model,
        messageCount: open.conversation.messageCount,
        messages: withoutToolOutputs(open.messages),
        // Computed server-side, per request (Task 9 fix round 2, item 1 / N1) — the raw
        // inFlightSince timestamp never reaches the client, which must not do this comparison
        // itself (a client-side "is this recent" clock, frozen at mount, could read an
        // already-expired lock as still busy forever). The page is force-dynamic, so a plain
        // router.refresh() always re-runs this comparison against the current time.
        // `new Date()` rather than `Date.now()`: the React Compiler's purity rule (eslint) treats
        // `Date.now` as a specifically denylisted impure call even in a Server Component, which
        // this file otherwise never re-renders like a client one — `new Date()` is the same
        // current-time read and is already used unflagged a few lines above (resetPeriodIfDue).
        inFlight: open.conversation.inFlightSince !== null && new Date().getTime() - open.conversation.inFlightSince.getTime() < ASK_LIMITS.inFlightExpiryMinutes * 60_000,
      } : null}
      meter={meterFor(account, model, isAdmin)}
      preview={isAdmin && memberAccounts === 0}
      appOrigin={new URL(env.APP_PUBLIC_URL).origin}
      // Spec 2026-10-01 §8. No row yet (an admin before their first turn: the gates create it then)
      // passes null; the server render that ends that turn (a refresh, or the move to the new chat)
      // brings the row's values, and AskAi takes them.
      writes={askAiWritesEnabled() && account ? { autoApproveChanges: account.autoApproveChanges, autoApproveDeletes: account.autoApproveDeletes } : null}
    />
  );
}
