'use client';

import { useState } from 'react';
import type { KeywordDetailHistoryRow } from '@/lib/explorer/fetchKeywordDetail';
import { buildWeekCalendar, gapFillHistory } from '@/lib/explorer/formatHistory';

/**
 * 52 weeks × 3 slots grid showing whether the keyword appeared in each
 * top product's title each week. Both flags are now stored per-week:
 *
 *   - strict (Amazon's flag): the value Amazon ships in the SFR CSV.
 *     Requires exact-phrase match.
 *   - loose (our flag, backfilled in migration 0014): every non-stopword
 *     token in the search term appears anywhere in the title via
 *     word-boundary match. Catches "Creatine Monohydrate Gummies" for
 *     the search "Creatine Gummies".
 *
 * Default: loose. The strict view is mainly useful for confirming
 * Amazon's exact tagging when investigating a specific anomaly.
 */
export function TitleMatchHistory({
  history,
  latestWeek,
}: {
  history: KeywordDetailHistoryRow[];
  latestWeek: string;
}) {
  const [mode, setMode] = useState<'strict' | 'loose'>('loose');
  const calendar = buildWeekCalendar(latestWeek, 52);
  const data = gapFillHistory(history, calendar);

  return (
    <div className="card-app p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-gray-700">Keyword in product title (52w)</h2>
        <ModeToggle mode={mode} onChange={setMode} />
      </div>
      <div className="space-y-1">
        {[1, 2, 3].map((slot) => (
          <SlotRow key={slot} slot={slot} data={data} mode={mode} />
        ))}
      </div>
      <p className="text-xs text-gray-500 mt-3">
        {mode === 'loose'
          ? 'Loose match: every word in the search term appears anywhere in the title (word-boundary, case-insensitive). Default view.'
          : 'Strict match: Amazon’s exact-phrase flag from the source CSV.'}
      </p>
    </div>
  );
}

function SlotRow({
  slot,
  data,
  mode,
}: {
  slot: number;
  data: ReturnType<typeof gapFillHistory>;
  mode: 'strict' | 'loose';
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-gray-600 w-12 shrink-0">#{slot}</span>
      <div className="flex gap-px flex-1">
        {data.map((d) => {
          const raw = d.raw;
          let flag: boolean | null = null;
          if (raw) {
            if (mode === 'loose') {
              flag = slot === 1 ? raw.keywordInTitle1Loose
                : slot === 2 ? raw.keywordInTitle2Loose
                : raw.keywordInTitle3Loose;
            } else {
              flag = slot === 1 ? raw.keywordInTitle1
                : slot === 2 ? raw.keywordInTitle2
                : raw.keywordInTitle3;
            }
          }
          let bg: string;
          let title: string;
          if (!raw) {
            bg = 'bg-gray-100 border border-dashed border-gray-300';
            title = `${d.weekEndDate}: not observed`;
          } else if (flag === null) {
            bg = 'bg-gray-200';
            title = `${d.weekEndDate}: unknown (${mode})`;
          } else if (flag) {
            bg = 'bg-green-500';
            title = `${d.weekEndDate}: in title #${slot} (${mode})`;
          } else {
            bg = 'bg-red-200';
            title = `${d.weekEndDate}: NOT in title #${slot} (${mode})`;
          }
          return <div key={d.weekEndDate} className={`flex-1 h-4 ${bg}`} title={title} />;
        })}
      </div>
    </div>
  );
}

function ModeToggle({ mode, onChange }: { mode: 'strict' | 'loose'; onChange: (m: 'strict' | 'loose') => void }) {
  return (
    <div className="text-xs text-gray-500">
      <select
        value={mode}
        onChange={(e) => onChange(e.target.value as 'strict' | 'loose')}
        className="border rounded px-2 py-0.5 text-xs bg-white"
      >
        <option value="loose">Loose (computed)</option>
        <option value="strict">Strict (Amazon)</option>
      </select>
    </div>
  );
}
