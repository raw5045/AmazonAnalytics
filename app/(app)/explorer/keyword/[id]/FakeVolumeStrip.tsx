import type { KeywordDetailHistoryRow } from '@/lib/explorer/fetchKeywordDetail';
import { buildWeekCalendar, gapFillHistory } from '@/lib/explorer/formatHistory';

/**
 * 52 cells, one per week, colored by fake_volume_severity:
 *   - none      gray-100  (clean signal)
 *   - warning   orange-400
 *   - critical  red-600
 *   - unknown   gray-300  (NULL severity — couldn't evaluate)
 *   - missing   gray-100 with diagonal stripe (term not observed that week)
 *
 * Hover shows a tooltip with the date + severity + click/conv shares
 * + eval_status so a user can dig into "why was this critical?"
 */

const SEVERITY_BG: Record<string, string> = {
  none: 'bg-emerald-200',
  warning: 'bg-orange-400',
  critical: 'bg-red-600',
};

export function FakeVolumeStrip({
  history,
  latestWeek,
}: {
  history: KeywordDetailHistoryRow[];
  latestWeek: string;
}) {
  const calendar = buildWeekCalendar(latestWeek, 52);
  const data = gapFillHistory(history, calendar);

  return (
    <div className="border rounded p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-gray-700">Fake-volume history (52w)</h2>
        <Legend />
      </div>
      <div className="flex gap-px" role="img" aria-label="Weekly fake-volume severity">
        {data.map((d) => (
          <Cell key={d.weekEndDate} datum={d} />
        ))}
      </div>
      <div className="mt-2 flex justify-between text-xs text-gray-500">
        <span>{data[0]?.weekEndDate}</span>
        <span>{data[data.length - 1]?.weekEndDate}</span>
      </div>
    </div>
  );
}

function Cell({ datum }: { datum: ReturnType<typeof gapFillHistory>[number] }) {
  const raw = datum.raw;
  const sev = raw?.fakeVolumeSeverity;

  let bg: string;
  let title: string;
  if (!raw) {
    bg = 'bg-gray-100 border border-dashed border-gray-300';
    title = `${datum.weekEndDate}\nUnranked / not observed`;
  } else if (sev === null || sev === undefined) {
    bg = 'bg-gray-300';
    const status = raw.fakeVolumeEvalStatus ?? 'unknown';
    title = `${datum.weekEndDate}\nCould not evaluate (${status})`;
  } else {
    bg = SEVERITY_BG[sev] ?? 'bg-gray-300';
    const click = raw.topClickedProduct1ClickShare ? `${parseFloat(raw.topClickedProduct1ClickShare).toFixed(1)}%` : '—';
    const conv = raw.topClickedProduct1ConversionShare ? `${parseFloat(raw.topClickedProduct1ConversionShare).toFixed(1)}%` : '—';
    title = `${datum.weekEndDate}\nseverity: ${sev}\nclick #1: ${click}\nconv #1: ${conv}`;
  }
  return <div className={`flex-1 h-6 ${bg}`} title={title} />;
}

function Legend() {
  return (
    <div className="flex items-center gap-3 text-xs text-gray-600">
      <LegendItem className="bg-emerald-200" label="none" />
      <LegendItem className="bg-orange-400" label="warning" />
      <LegendItem className="bg-red-600" label="critical" />
      <LegendItem className="bg-gray-300" label="unknown" />
    </div>
  );
}

function LegendItem({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={`inline-block w-3 h-3 rounded-sm ${className}`} />
      {label}
    </span>
  );
}
