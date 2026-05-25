import { db } from '@/db/client';
import { keywordCurrentSummaryMeta, keepaEnrichmentRuns } from '@/db/schema';
import { desc } from 'drizzle-orm';
import { KeepaEnrichmentButton } from './KeepaEnrichmentButton';

export const dynamic = 'force-dynamic';

export default async function KeepaEnrichmentAdminPage() {
  const [meta] = await db.select().from(keywordCurrentSummaryMeta).limit(1);
  const recentRuns = await db
    .select()
    .from(keepaEnrichmentRuns)
    .orderBy(desc(keepaEnrichmentRuns.startedAt))
    .limit(5);

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-semibold">Keepa enrichment</h1>
      <p className="mt-2 text-gray-600">
        Weekly enrichment auto-fires after every kcs refresh in <strong>diff</strong> mode —
        ASINs enriched in any prior week have their data carried forward, and only genuinely
        new (or previously-failed) ASINs are hit via the Keepa API. Typical runtime:{' '}
        <strong>~5 hours</strong> (down from ~24 hours in full mode).
      </p>
      <p className="mt-2 text-sm text-gray-500">
        Run the <strong>full</strong> mode once per month or so to refresh prices, review
        counts, and categories on every in-scope ASIN. Takes the full ~24 hours but
        guarantees current data on every product.
      </p>

      <div className="mt-6 rounded border border-amber-200 bg-amber-50 p-4">
        <h2 className="text-sm font-semibold text-amber-900">Manual full refresh</h2>
        <p className="mt-1 text-sm text-amber-800">
          Triggers a full Keepa enrichment for the current kcs week
          {meta?.currentWeekEndDate ? (
            <>
              {' '}(<strong>{meta.currentWeekEndDate}</strong>)
            </>
          ) : null}
          . Every in-scope ASIN (~140k) will hit the Keepa API. Don&apos;t fire this if a
          run is already in progress.
        </p>
        <div className="mt-3">
          <KeepaEnrichmentButton
            currentWeek={meta?.currentWeekEndDate ?? null}
          />
        </div>
      </div>

      <h2 className="mt-8 text-sm font-semibold text-gray-700">Recent runs</h2>
      <div className="mt-2 overflow-x-auto border rounded">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-600">
            <tr>
              <th className="p-2">Week</th>
              <th className="p-2">Status</th>
              <th className="p-2 text-right">Processed / Total</th>
              <th className="p-2">Started</th>
              <th className="p-2">Completed</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {recentRuns.length === 0 ? (
              <tr>
                <td colSpan={5} className="p-3 text-center text-gray-500">No runs yet.</td>
              </tr>
            ) : recentRuns.map((r) => (
              <tr key={r.id}>
                <td className="p-2 font-mono">{r.weekEndDate}</td>
                <td className="p-2">
                  <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${statusColor(r.status)}`}>
                    {r.status}
                  </span>
                </td>
                <td className="p-2 text-right tabular-nums">
                  {r.processedAsins.toLocaleString()} / {r.totalAsins?.toLocaleString() ?? '?'}
                </td>
                <td className="p-2 text-xs text-gray-600 whitespace-nowrap">
                  {r.startedAt.toISOString().slice(0, 19).replace('T', ' ')}
                </td>
                <td className="p-2 text-xs text-gray-600 whitespace-nowrap">
                  {r.completedAt ? r.completedAt.toISOString().slice(0, 19).replace('T', ' ') : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function statusColor(status: string): string {
  switch (status) {
    case 'completed':  return 'bg-green-100 text-green-800';
    case 'running':    return 'bg-blue-100 text-blue-800';
    case 'failed':     return 'bg-red-100 text-red-800';
    case 'orphaned':   return 'bg-amber-100 text-amber-800';
    default:           return 'bg-gray-100 text-gray-700';
  }
}
