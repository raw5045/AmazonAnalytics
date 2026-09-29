/**
 * Admin › Ask AI (spec §11.5, amended Task 10 review): month spend vs ceiling (counting spendable
 * credit too, C-m7), model mix (S2), alert-reached timestamps (C-m3), member table with grant/
 * allowance/credit/revoke and per-member spend this month (C-m7; Task 10 nits, spec note 2 — the
 * ledger sum is always the UTC calendar month, unlike the allowance's own "used this period", which
 * will track period_start once Stripe sets it). No transcripts, no message text anywhere on this page.
 */
import { requireAdmin, AuthError } from '@/lib/auth/requireAdmin';
import { redirect } from 'next/navigation';
import { globalMonthlyCeilingMicro, MICRO } from '@/lib/ask/config';
import { globalUsageForMonth, monthStartUtc, sumRemainingAllowances } from '@/lib/ask/ledger';
import { listAccountsForAdmin, modelMixForMonth, sumCreditWithAccess } from '@/lib/ask/adminView';
import { ASK_MODELS } from '@/lib/ask/models';
import { AccountActions } from './AccountActions';
import { GrantForm } from './GrantForm';

export const dynamic = 'force-dynamic';
const usd = (micro: number) => `$${(micro / MICRO).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const modelFullLabel = (id: string) => ASK_MODELS.find((m) => m.id === id)?.label ?? id;
const questionsWord = (n: number) => (n === 1 ? 'question' : 'questions');
const fmtAlertAt = (at: Date | null) => (at ? `${at.toISOString().replace('T', ' ').slice(0, 16)} UTC` : null);

export default async function AskAiAdminPage() {
  // Next 16 renders layouts and pages in parallel, and a client-sent Next-Router-State-Tree can
  // claim the /admin layout already ran (partial rendering) — app/admin/layout.tsx's requireAdmin()
  // is therefore not a guaranteed gate on its own (vendored docs, 01-app/02-guides/authentication.md,
  // "Layouts and auth checks": "these don't re-render on navigation, meaning the user session won't
  // be checked on every route change... you should do the checks close to your data source").
  // Checked again here, before any data read, mirroring the layout's own AuthError handling (Task
  // 10 review, S1). Every other /admin page still relies on the layout alone — recorded as a
  // follow-up (spec §16, and the plan's Task 10 fix-round blockquote).
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) redirect(e.code === 'UNAUTHENTICATED' ? '/sign-in' : '/explorer');
    throw e;
  }
  const now = new Date();
  const month = monthStartUtc(now);
  const [usage, remaining, credit, rows, mix] = await Promise.all([
    globalUsageForMonth(month),
    sumRemainingAllowances(now),
    sumCreditWithAccess(),
    listAccountsForAdmin(now),
    modelMixForMonth(now),
  ]);
  const ceiling = globalMonthlyCeilingMicro();
  // The ceiling-too-low check must also count spendable credit, not just committed allowances —
  // credit is real spendable balance too (Task 10 review, C-m7).
  const tooLow = remaining + credit > ceiling - usage.costMicro;
  // "Reached", not "sent" (Task 10 nits, spec note 4): alerted80At/alerted100At are set when the
  // threshold is crossed, before the send is even attempted — an unset admin email, a failed send,
  // or a jump straight to 100% would all still show a timestamp here despite no email going out.
  const alertParts: string[] = [];
  const alerted80 = fmtAlertAt(usage.alerted80At);
  const alerted100 = fmtAlertAt(usage.alerted100At);
  if (alerted80) alertParts.push(`80% reached ${alerted80}`);
  if (alerted100) alertParts.push(`100% reached ${alerted100}`);

  return (
    <div>
      <h1 className="mb-2 text-xl font-semibold">Ask AI</h1>
      <p className="text-sm text-gray-600">
        This month: <strong>{usd(usage.costMicro)}</strong> of the <strong>{usd(ceiling)}</strong> ceiling, {usage.questions.toLocaleString('en-US')} questions.
        Remaining allowances of members with access: <strong>{usd(remaining)}</strong>. Spendable credit: <strong>{usd(credit)}</strong>.
      </p>
      <p className="mt-1 text-sm text-gray-600">
        Model mix: {mix.length === 0 ? 'none yet' : mix.map((m) => `${modelFullLabel(m.model)} ${m.questions.toLocaleString('en-US')} ${questionsWord(m.questions)} (${usd(m.costMicro)})`).join(' · ')}
      </p>
      <p className="mt-1 text-sm text-gray-600">Alerts this month: {alertParts.length === 0 ? 'none' : alertParts.join(' · ')}</p>
      {tooLow && <p className="mt-1 text-sm text-amber-800">The ceiling is lower than what members could still use this month. Raise ASK_AI_GLOBAL_MONTHLY_CEILING_USD before granting more.</p>}
      <div className="my-4"><GrantForm /></div>
      <table className="w-full text-sm">
        <thead className="text-left text-gray-600">
          <tr>
            <th className="py-1 pr-2">Member</th><th className="pr-2">Access</th><th className="pr-2">Allowance</th><th className="pr-2">Used</th>
            <th className="pr-2">Credit</th><th className="pr-2">Spend (month)</th><th className="pr-2">Questions</th><th className="pr-2">Last activity</th><th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.userId} className="border-t align-top">
              <td className="py-2 pr-2">{r.email}{r.role === 'admin' && <span className="ml-1 rounded bg-amber-100 px-1 text-xs">admin</span>}</td>
              <td className="pr-2">{r.access ? 'yes' : 'no'}</td>
              <td className="pr-2">{usd(r.monthlyAllowanceMicro)}</td>
              <td className="pr-2">{usd(r.allowanceUsedMicro)}</td>
              <td className="pr-2">{usd(r.creditMicro)}</td>
              <td className="pr-2">{usd(r.spendMonthMicro)}</td>
              <td className="pr-2">{r.questionsMonth}</td>
              <td className="pr-2">{r.lastAt ? r.lastAt.toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'none'}</td>
              <td><AccountActions userId={r.userId} access={r.access} allowanceUsd={r.monthlyAllowanceMicro / MICRO} /></td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={9} className="py-3 text-gray-500">No accounts yet. Grant the first member above.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
