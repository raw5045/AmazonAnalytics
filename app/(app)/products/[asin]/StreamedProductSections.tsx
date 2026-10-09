/**
 * Streamed history and keywords sections for the ASIN page (spec 2026-10-09 §6.2, §6.3).
 *
 * The page awaits only the facts (one primary-key read) so the title band and the facts card paint
 * first; these two reads stream in behind <Suspense>. Like the keyword page's StreamedSections and
 * TopProductsSection, each section awaits its own read inside a try/catch and fails soft, and NO
 * client error boundary wraps their <Suspense> (that would de-opt the server streaming). A failure is
 * logged as coded fields only (errFields), never an error message.
 */
import type { ReactNode } from 'react';
import { errFields } from '@/lib/ask/logSafe';
import { loadProductHistory, PRODUCT_HISTORY_CAP, type HistoryPoint } from '@/lib/products/loadProductHistory';
import { loadProductKeywords, type ProductKeywordsResult } from '@/lib/products/loadProductKeywords';
import type { SqlRunner } from '@/lib/products/searchProducts';
import type { ChartPoint } from './chartMeta';
import { LazyHistoryCharts } from './LazyHistoryCharts';
import { ProductKeywordsTable } from './ProductKeywordsTable';

function logLoadFailure(tag: string, e: unknown): void {
  const { error, code } = errFields(e);
  console.error(tag, JSON.stringify({ error, code }));
}

export async function HistorySection({ run, asin, fetched }: { run: SqlRunner; asin: string; fetched: boolean }) {
  // Never fetched: there is no snapshot yet, so skip the read and the chart chunk.
  if (!fetched) return <HistoryNote>No history yet</HistoryNote>;
  let points: HistoryPoint[];
  try {
    points = await loadProductHistory(run, asin);
  } catch (e) {
    logLoadFailure('[product history] load failed', e);
    return (
      <HistoryNote>Couldn&apos;t load the history — refresh to retry. (The rest of the page is unaffected.)</HistoryNote>
    );
  }
  // Nothing to chart: say so here instead of downloading the chart chunk to say it.
  if (points.length === 0) return <HistoryNote>No history yet</HistoryNote>;
  // Only the charted fields cross to the client (up to PRODUCT_HISTORY_CAP points).
  const chartPoints: ChartPoint[] = points.map(({ fetchedAt, currentPriceCents, salesRank, reviewCount, monthlySold }) => ({
    fetchedAt,
    currentPriceCents,
    salesRank,
    reviewCount,
    monthlySold,
  }));
  // A full page from the loader means older snapshots may have been left out; the summary says so.
  return <LazyHistoryCharts points={chartPoints} capped={points.length >= PRODUCT_HISTORY_CAP} />;
}

/** The history block's frame with one line in place of the charts (same frame as HistoryCharts). */
function HistoryNote({ children }: { children: ReactNode }) {
  return (
    <section className="mt-6">
      <h2 className="mb-3 text-sm font-semibold text-gray-700">History</h2>
      <p className="card-app p-4 text-sm text-gray-500">{children}</p>
    </section>
  );
}

export async function KeywordsSection({ run, asin }: { run: SqlRunner; asin: string }) {
  let result: ProductKeywordsResult;
  try {
    result = await loadProductKeywords(run, asin);
  } catch (e) {
    logLoadFailure('[product keywords] load failed', e);
    return (
      <section className="mt-6">
        <h2 className="mb-3 text-sm font-semibold text-gray-700">Keywords</h2>
        <p className="text-sm text-gray-500">
          Couldn&apos;t load the keywords — refresh to retry. (The rest of the page is unaffected.)
        </p>
      </section>
    );
  }
  return <ProductKeywordsTable rows={result.rows} total={result.total} />;
}

/** Shown while the keywords stream in. */
export function KeywordsSkeleton() {
  return (
    <section className="mt-6">
      <h2 className="mb-3 text-sm font-semibold text-gray-700">Keywords</h2>
      <div className="card-app overflow-hidden">
        <div className="flex items-center gap-2 border-b px-4 py-3 text-sm text-gray-600">
          <span
            className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-gray-600"
            aria-hidden
          />
          Loading keywords…
        </div>
        <div className="animate-pulse">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="h-10 border-b bg-gray-50 last:border-b-0" />
          ))}
        </div>
      </div>
    </section>
  );
}
