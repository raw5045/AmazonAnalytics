/**
 * Async server component that owns the slow kwm 52-week query.
 * Rendered inside a <Suspense> boundary in page.tsx so the header,
 * charts, and top-products section stream in immediately from
 * fetchKeywordChartData while this resolves in the background.
 */
import { fetchKeywordRawHistory } from '@/lib/explorer/fetchKeywordDetail';
import { RawDataTable } from './RawDataTable';

export async function WeeklyHistoryTable({ id }: { id: string }) {
  // Owns its own error handling so a failed history query shows an inline
  // message without tearing down the charts above — and crucially WITHOUT a
  // client error boundary wrapping this <Suspense> (that de-opts the streaming
  // that lets the charts paint first).
  let rows;
  try {
    rows = await fetchKeywordRawHistory(id);
  } catch (e) {
    console.error('[weekly history] load failed', e);
    return (
      <p className="text-sm text-gray-500">
        Couldn&apos;t load the weekly history table — refresh to retry. (The charts above are
        unaffected.)
      </p>
    );
  }
  return <RawDataTable rows={rows} />;
}

/**
 * Skeleton shown while WeeklyHistoryTable is loading.
 * Mimics the table's approximate height to minimise layout shift (CLS).
 */
export function HistoryTableSkeleton() {
  return (
    <div className="rounded border">
      {/* Explicit loading row so the (slow) history read clearly reads as
          "loading", not "broken". */}
      <div className="flex items-center gap-2 border-b px-4 py-3 text-sm text-gray-600">
        <span
          className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-gray-600"
          aria-hidden
        />
        Loading weekly history…
      </div>
      {/* Faint skeleton rows beneath, sized to approximate the table (limits CLS). */}
      <div className="animate-pulse">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-10 border-b bg-gray-50 last:border-b-0" />
        ))}
      </div>
    </div>
  );
}
