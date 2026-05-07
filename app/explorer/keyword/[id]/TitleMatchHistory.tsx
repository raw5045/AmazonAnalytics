'use client';

import { useState } from 'react';
import type { KeywordDetailHistoryRow } from '@/lib/explorer/fetchKeywordDetail';
import { buildWeekCalendar, gapFillHistory } from '@/lib/explorer/formatHistory';

/**
 * 52 weeks × 3 slots grid showing whether the keyword appeared in each
 * top product's title each week. Toggle between strict (Amazon's flag)
 * and loose (our computed flag).
 *
 * Loose flags are NOT historical — kwm only stores Amazon's strict
 * version. We only have the loose computation for the CURRENT snapshot
 * (kcs row). For historical "loose" we'd have to recompute on demand
 * from the title text. For V1, the toggle just shows strict for past
 * weeks and shows the loose flag for the current week as an annotation.
 *
 * That's OK because the strict-vs-loose distinction is most interesting
 * for the current snapshot ("Amazon says no but we say yes" — the
 * Creatine Gummies case). Past weeks are mostly strict-only.
 */
export function TitleMatchHistory({
  history,
  latestWeek,
}: {
  history: KeywordDetailHistoryRow[];
  latestWeek: string;
}) {
  const [, setMode] = useState<'strict' | 'loose'>('strict');
  const calendar = buildWeekCalendar(latestWeek, 52);
  const data = gapFillHistory(history, calendar);

  return (
    <div className="border rounded p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-gray-700">Keyword in product title (52w)</h2>
        <ModeToggle onChange={setMode} />
      </div>
      <div className="space-y-1">
        {[1, 2, 3].map((slot) => (
          <SlotRow key={slot} slot={slot} data={data} />
        ))}
      </div>
      <p className="text-xs text-gray-500 mt-3">
        Strict = Amazon&apos;s exact-phrase flag (per-week). Loose match is computed only for the
        current snapshot — historical loose data is not stored.
      </p>
    </div>
  );
}

function SlotRow({
  slot,
  data,
}: {
  slot: number;
  data: ReturnType<typeof gapFillHistory>;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-gray-600 w-12 shrink-0">#{slot}</span>
      <div className="flex gap-px flex-1">
        {data.map((d) => {
          const raw = d.raw;
          const flag = !raw
            ? null
            : slot === 1
              ? raw.keywordInTitle1
              : slot === 2
                ? raw.keywordInTitle2
                : raw.keywordInTitle3;
          let bg: string;
          let title: string;
          if (!raw) {
            bg = 'bg-gray-100 border border-dashed border-gray-300';
            title = `${d.weekEndDate}: not observed`;
          } else if (flag === null) {
            bg = 'bg-gray-200';
            title = `${d.weekEndDate}: unknown`;
          } else if (flag) {
            bg = 'bg-green-500';
            title = `${d.weekEndDate}: in title #${slot}`;
          } else {
            bg = 'bg-red-200';
            title = `${d.weekEndDate}: NOT in title #${slot}`;
          }
          return <div key={d.weekEndDate} className={`flex-1 h-4 ${bg}`} title={title} />;
        })}
      </div>
    </div>
  );
}

function ModeToggle({ onChange }: { onChange: (m: 'strict' | 'loose') => void }) {
  // For V1 only "strict" is meaningful per-week; show the toggle but it's
  // a no-op visually. Reserved for a future commit that recomputes loose
  // historically (would require running our regex over each week's titles).
  return (
    <div className="text-xs text-gray-500">
      <select
        defaultValue="strict"
        onChange={(e) => onChange(e.target.value as 'strict' | 'loose')}
        className="border rounded px-2 py-0.5 text-xs bg-white"
        disabled
        title="Loose-historical view will be added in a follow-up"
      >
        <option value="strict">Strict (Amazon)</option>
        <option value="loose">Loose (computed)</option>
      </select>
    </div>
  );
}
