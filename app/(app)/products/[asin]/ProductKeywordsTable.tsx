/**
 * The ASIN page's keywords block (spec 2026-10-09 §6.3): this week's keywords the product is a top-3
 * clicked product for, in the loader's order (best keyword rank first), capped by the loader at 500
 * with a "showing 500 of N" line beside the full count. Styled like the keyword page's top products
 * table (TopProductsSection.tsx). Each keyword opens its keyword page; the link carries no `from`
 * (the keyword page's back control returns to the explorer).
 */
import Link from 'next/link';
import type { ProductKeywordRow } from '@/lib/products/loadProductKeywords';
import { formatVolume } from '@/lib/products/format';

export function ProductKeywordsTable({ rows, total }: { rows: ProductKeywordRow[]; total: number }) {
  return (
    <section className="mt-6">
      <h2 className="mb-1 text-sm font-semibold text-gray-700">Keywords</h2>
      <p className="mb-3 text-xs text-gray-500">
        This week&apos;s keywords where it is one of the top 3 clicked products, best keyword rank first.
      </p>
      {rows.length === 0 ? (
        <p className="card-app p-4 text-sm text-gray-500">Not a top-3 clicked product for any keyword this week</p>
      ) : (
        <>
          <div className="card-app overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-gray-600">
                <tr>
                  <th className="p-2">Keyword</th>
                  <th className="p-2 text-right" title="The keyword's search frequency rank this week (1 = most searched)">
                    Rank
                  </th>
                  <th className="p-2 text-right" title="Estimated monthly searches, from the rank → volume calibration fit">
                    Est. searches
                  </th>
                  <th className="p-2 text-right" title="This product's click-share position for the keyword (1 = most clicked)">
                    Slot
                  </th>
                  <th className="p-2 text-right" title="Share of all clicks for this keyword that went to this product (Amazon-reported, this week)">
                    Click %
                  </th>
                  <th
                    className="p-2 text-right"
                    title="Share of all conversions for this keyword that went to this product (Amazon-reported, this week)"
                  >
                    Conv %
                  </th>
                  <th
                    className="p-2 text-right"
                    title="Consecutive imported weeks, ending this week, this product has been in the keyword's top 3 (any slot)"
                  >
                    Weeks in top 3
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((r) => (
                  <tr key={`${r.searchTermId}-${r.slot}`}>
                    <td className="p-2">
                      <Link
                        href={`/explorer/keyword/${r.searchTermId}`}
                        className="text-blue-700 hover:underline focus-visible:underline"
                      >
                        {r.searchTermRaw}
                      </Link>
                    </td>
                    <td className="p-2 text-right tabular-nums">{r.currentRank.toLocaleString('en-US')}</td>
                    <td className="p-2 text-right tabular-nums whitespace-nowrap">
                      {r.estimatedMonthlySearches === null ? <Dash /> : `~${formatVolume(r.estimatedMonthlySearches)}`}
                    </td>
                    <td className="p-2 text-right tabular-nums">{r.slot}</td>
                    <td className="p-2 text-right tabular-nums">{formatShare(r.clickSharePct)}</td>
                    <td className="p-2 text-right tabular-nums">{formatShare(r.conversionSharePct)}</td>
                    <td
                      className="p-2 text-right tabular-nums"
                      title={`In this keyword's top 3 since the week ending ${r.streakStartedWeek}`}
                    >
                      {r.weeksInTop3.toLocaleString('en-US')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {total > rows.length && (
            <p className="mt-2 text-xs text-gray-500">
              Showing {rows.length.toLocaleString('en-US')} of {total.toLocaleString('en-US')} keywords (best rank first).
            </p>
          )}
        </>
      )}
    </section>
  );
}

function Dash() {
  return <span className="text-gray-400">—</span>;
}

/** 32.5 → "32.5%": one decimal, as the keyword page's top products table shows shares. */
function formatShare(pct: number | null) {
  return pct === null || !Number.isFinite(pct) ? <Dash /> : `${pct.toFixed(1)}%`;
}
