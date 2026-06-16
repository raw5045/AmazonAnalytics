/**
 * Async server component that owns the slow kwm 52-week query.
 * Rendered inside a <Suspense> boundary in page.tsx so the header,
 * charts, and top-products section stream in immediately from
 * fetchKeywordChartData while this resolves in the background.
 */
import { fetchKeywordRawHistory } from '@/lib/explorer/fetchKeywordDetail';
import { RawDataTable } from './RawDataTable';

export async function WeeklyHistoryTable({ id }: { id: string }) {
  const rows = await fetchKeywordRawHistory(id);
  return <RawDataTable rows={rows} />;
}

/**
 * Skeleton shown while WeeklyHistoryTable is loading.
 * Mimics the table's approximate height to minimise layout shift (CLS).
 */
export function HistoryTableSkeleton() {
  return (
    <div className="border rounded animate-pulse">
      {/* Header row */}
      <div className="h-8 bg-gray-100 border-b" />
      {/* Two data rows — RawDataTable defaults to showing the 2 most recent */}
      {[0, 1].map((i) => (
        <div key={i} className="h-10 bg-gray-50 border-b last:border-b-0" />
      ))}
      {/* "Show all N weeks" button area */}
      <div className="h-9 bg-white border-t" />
    </div>
  );
}
