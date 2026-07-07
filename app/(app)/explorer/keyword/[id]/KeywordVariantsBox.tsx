import type { KeywordVariantInfo } from '@/lib/explorer/fetchKeywordDetail';
import { cleanSearchTermForDisplay, hadUnicodeNoise } from '@/lib/analytics/derivedFields';

/**
 * "Keyword variants" box on the keyword detail page.
 *
 * Lists the distinct raw CSV phrasings observed for this keyword in the
 * most recent week, paired with each one's SFR rank. Intended for
 * exact-phrase advertising and backend-keyword brainstorming — every
 * variant is a way real searchers typed this term, and the rank gives
 * a relative-popularity signal.
 *
 * Visual treatment of "data noise" rows: when the raw string contained
 * invisible-character noise (OBJ replacement char, ZWSP, etc. — a
 * known Amazon CSV bug), we still display it but lower its visual
 * weight and add a small "data noise" badge so users can mentally
 * filter it out when copying variants.
 *
 * Cap: today we store up to 3 raw_examples per (week, term) in
 * import_duplicate_search_terms. The plan is to drop that cap going
 * forward; for now this box shows what's available (1-3 entries).
 *
 * Empty state: this component is only mounted when the most recent
 * week's variants entry exists, so it never renders empty.
 */

interface DisplayVariant {
  cleaned: string;
  rawIsNoisy: boolean;
  rank: number;
}

export function KeywordVariantsBox({
  weekEndDate,
  variants,
}: {
  weekEndDate: string;
  variants: KeywordVariantInfo;
}) {
  // Pair raw_examples[i] with the matching rank from losing_ranks[i].
  // Both arrays are sorted by rank ASC at import time, so position is
  // the join key.
  const display: DisplayVariant[] = [];
  const cap = Math.min(variants.rawExamples.length, variants.losingRanks.length);
  for (let i = 0; i < cap; i++) {
    const raw = variants.rawExamples[i];
    display.push({
      cleaned: cleanSearchTermForDisplay(raw) || raw,
      rawIsNoisy: hadUnicodeNoise(raw),
      rank: variants.losingRanks[i],
    });
  }

  return (
    <div className="card-app p-4">
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="text-sm font-semibold text-gray-700">Keyword variants</h2>
        <span className="text-xs text-gray-500">week ending {weekEndDate}</span>
      </div>
      <p className="text-xs text-gray-500 mb-3">
        Distinct phrasings observed in Amazon&rsquo;s source data for this keyword,
        with each variant&rsquo;s individual search-frequency rank. Useful for exact-phrase
        advertising targets and backend keyword expansion.
      </p>
      <table className="w-full text-sm">
        <thead className="text-xs uppercase tracking-wide text-gray-600 text-left border-b">
          <tr>
            <th className="pb-2 font-medium">Variant</th>
            <th className="pb-2 font-medium text-right">Rank (SFR)</th>
            <th className="pb-2 font-medium text-center w-24">Quality</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {display.map((v, i) => (
            <tr key={i} className={v.rawIsNoisy ? 'text-gray-400' : 'text-gray-800'}>
              <td className="py-1.5 font-mono">
                {v.cleaned}
              </td>
              <td className="py-1.5 text-right tabular-nums">
                {v.rank.toLocaleString()}
              </td>
              <td className="py-1.5 text-center">
                {v.rawIsNoisy ? (
                  <span
                    className="inline-block text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-50 border border-amber-200 text-amber-700"
                    title="The raw CSV string contained invisible-character noise (a known Amazon export bug). The displayed text is the cleaned form; the rank is from the noisy row."
                  >
                    data noise
                  </span>
                ) : (
                  <span className="text-xs text-gray-400">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
