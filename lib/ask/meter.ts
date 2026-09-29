import type { AskModelId } from './config';
import type { AskAccount } from './ledger';
import { estimatedQuestionsLeft } from './pricing';
import { balanceMicro } from './ledger';

export interface MeterData { percentUsed: number; questionsLeft: number; hasCredit: boolean; exhausted: boolean; admin: boolean }

/**
 * Spec §11.4. Pure; the page computes it server-side. Server-only by usage: only page.tsx imports
 * this module (via `./ledger`, which imports `db`) — client components receive `MeterData` as
 * props instead (Meter.tsx imports only the `MeterData` type, elided at build time).
 */
export function meterFor(account: AskAccount | null, model: AskModelId, isAdmin: boolean): MeterData {
  if (!account) return { percentUsed: 0, questionsLeft: 0, hasCredit: false, exhausted: !isAdmin, admin: isAdmin };
  const percentUsed = account.monthlyAllowanceMicro > 0 ? Math.min(100, Math.round((account.allowanceUsedMicro / account.monthlyAllowanceMicro) * 100)) : 0;
  const balance = balanceMicro(account);
  return { percentUsed, questionsLeft: estimatedQuestionsLeft(balance, model), hasCredit: account.creditMicro > 0, exhausted: !isAdmin && balance <= 0, admin: isAdmin };
}
