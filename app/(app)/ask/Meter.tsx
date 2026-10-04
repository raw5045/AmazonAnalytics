import type { MeterData } from '@/lib/ask/meter';
import { ADMIN_METER, NO_BALANCE_MESSAGE } from '@/lib/ask/messages';

export function Meter({ meter }: { meter: MeterData }) {
  // Only 1 is ever singular (Minor 10, final review) — same rule as dailyLimitMessage in messages.ts.
  const questionWord = meter.questionsLeft === 1 ? 'question' : 'questions';
  const text = meter.admin ? ADMIN_METER : meter.exhausted ? NO_BALANCE_MESSAGE : `about ${meter.questionsLeft} ${questionWord} left${meter.hasCredit ? ', including credit' : ''}`;
  return (
    <div className="text-[11px] text-slate-500">
      <div className="flex items-center gap-2">
        <span>Usage</span>
        <div role="progressbar" aria-label="Usage this month" aria-valuenow={meter.percentUsed} aria-valuemin={0} aria-valuemax={100} className="h-1.5 w-20 overflow-hidden rounded bg-slate-200">
          <div className="h-1.5 bg-sky-500" style={{ width: `${meter.percentUsed}%` }} />
        </div>
      </div>
      <p className="mt-0.5 text-slate-600">{text}</p>
    </div>
  );
}
