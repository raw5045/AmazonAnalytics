import type { MeterData } from '@/lib/ask/meter';
import { ADMIN_METER, NO_BALANCE_MESSAGE } from '@/lib/ask/messages';

export function Meter({ meter }: { meter: MeterData }) {
  const text = meter.admin ? ADMIN_METER : meter.exhausted ? NO_BALANCE_MESSAGE : `about ${meter.questionsLeft} questions left${meter.hasCredit ? ', including credit' : ''}`;
  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="text-slate-600">Usage this month</span>
      <div role="progressbar" aria-label="Usage this month" aria-valuenow={meter.percentUsed} aria-valuemin={0} aria-valuemax={100} className="h-2 w-40 overflow-hidden rounded bg-slate-200">
        <div className="h-2 bg-sky-500" style={{ width: `${meter.percentUsed}%` }} />
      </div>
      <span className="text-slate-700">{text}</span>
    </div>
  );
}
