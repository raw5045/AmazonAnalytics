/**
 * Admin › Ask AI (spec §11.5): month spend vs ceiling, committed allowances, member table with
 * grant/allowance/credit/revoke. No transcripts, no message text anywhere on this page.
 * Admin-gating is enforced by app/admin/layout.tsx (requireAdmin) — not repeated here.
 */
import { globalMonthlyCeilingMicro, MICRO } from '@/lib/ask/config';
import { globalUsageForMonth, monthStartUtc, sumRemainingAllowances } from '@/lib/ask/ledger';
import { listAccountsForAdmin } from '@/lib/ask/adminView';
import { AccountActions } from './AccountActions';
import { GrantForm } from './GrantForm';

export const dynamic = 'force-dynamic';
const usd = (micro: number) => `$${(micro / MICRO).toFixed(2)}`;

export default async function AskAiAdminPage() {
  const now = new Date();
  const month = monthStartUtc(now);
  const [usage, remaining, rows] = await Promise.all([globalUsageForMonth(month), sumRemainingAllowances(now), listAccountsForAdmin(now)]);
  const ceiling = globalMonthlyCeilingMicro();
  const tooLow = remaining > ceiling - usage.costMicro;
  return (
    <div>
      <h1 className="mb-2 text-xl font-semibold">Ask AI</h1>
      <p className="text-sm text-gray-600">
        This month: <strong>{usd(usage.costMicro)}</strong> of the <strong>{usd(ceiling)}</strong> ceiling, {usage.questions.toLocaleString('en-US')} questions.
        Remaining allowances of members with access: <strong>{usd(remaining)}</strong>.
      </p>
      {tooLow && <p className="mt-1 text-sm text-amber-800">The ceiling is lower than what members could still use this month. Raise ASK_AI_GLOBAL_MONTHLY_CEILING_USD before granting more.</p>}
      <div className="my-4"><GrantForm /></div>
      <table className="w-full text-sm">
        <thead className="text-left text-gray-600"><tr><th className="py-1 pr-2">Member</th><th className="pr-2">Access</th><th className="pr-2">Allowance</th><th className="pr-2">Used</th><th className="pr-2">Credit</th><th className="pr-2">Questions</th><th className="pr-2">Last activity</th><th>Actions</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.userId} className="border-t align-top">
              <td className="py-2 pr-2">{r.email}{r.role === 'admin' && <span className="ml-1 rounded bg-amber-100 px-1 text-xs">admin</span>}</td>
              <td className="pr-2">{r.access ? 'yes' : 'no'}</td>
              <td className="pr-2">{usd(r.monthlyAllowanceMicro)}</td>
              <td className="pr-2">{usd(r.allowanceUsedMicro)}</td>
              <td className="pr-2">{usd(r.creditMicro)}</td>
              <td className="pr-2">{r.questionsMonth}</td>
              <td className="pr-2">{r.lastAt ? r.lastAt.toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'none'}</td>
              <td><AccountActions userId={r.userId} access={r.access} allowanceUsd={r.monthlyAllowanceMicro / MICRO} /></td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={8} className="py-3 text-gray-500">No accounts yet. Grant the first member above.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
