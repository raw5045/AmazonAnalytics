/**
 * Streamed "Top clicked products" section.
 *
 * Owns the deferred current-week product read (fetchKeywordProducts) so the
 * detail page's header + 4 charts paint immediately from the fast loader; this
 * box fills in behind a <Suspense> once the cold-page kwm slice resolves
 * (a single row on the 140M-row table that costs ~2s cold).
 *
 * Like WeeklyHistoryTable, it carries its own try/catch and NO client error
 * boundary wraps its <Suspense> — that would de-opt the server streaming that
 * lets the charts paint first.
 */
import {
  fetchKeywordProducts,
  type EnrichedProduct,
} from '@/lib/explorer/fetchKeywordDetail';

export async function TopProductsSection({
  id,
  currentWeekEndDate,
}: {
  id: string;
  currentWeekEndDate: string;
}) {
  let slots: TopProductSlot[];
  let enrichedByAsin: Record<string, EnrichedProduct>;
  try {
    const products = await fetchKeywordProducts(id, currentWeekEndDate);
    slots = products.currentWeekProductSlots.map((s) => ({
      slot: s.slot,
      asin: s.asin,
      fallbackTitle: s.title,
    }));
    enrichedByAsin = products.enrichedProductsByAsin;
  } catch (e) {
    console.error('[top products] load failed', e);
    return (
      <section className="mt-6">
        <h2 className="text-sm font-semibold text-gray-700 mb-3">Top clicked products</h2>
        <p className="text-sm text-gray-500">
          Couldn&apos;t load the top products — refresh to retry. (The charts above are unaffected.)
        </p>
      </section>
    );
  }

  // No products for this week → omit the section entirely (matches prior behavior).
  if (!slots.some((s) => s.asin)) return null;

  return (
    <section className="mt-6">
      <h2 className="text-sm font-semibold text-gray-700 mb-3">Top clicked products</h2>
      <TopProductsTable slots={slots} enrichedByAsin={enrichedByAsin} />
    </section>
  );
}

/** Skeleton shown while the current-week product slice streams in. */
export function TopProductsSkeleton() {
  return (
    <section className="mt-6">
      <h2 className="text-sm font-semibold text-gray-700 mb-3">Top clicked products</h2>
      <div className="card-app overflow-hidden">
        <div className="flex items-center gap-2 border-b px-4 py-3 text-sm text-gray-600">
          <span
            className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-gray-600"
            aria-hidden
          />
          Loading products…
        </div>
        <div className="animate-pulse">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-12 border-b bg-gray-50 last:border-b-0" />
          ))}
        </div>
      </div>
    </section>
  );
}

interface TopProductSlot {
  slot: 1 | 2 | 3;
  asin: string | null;
  fallbackTitle: string | null;
}

/**
 * Compact table replacing the old image-heavy ProductCard layout
 * (which was the dominant cause of slow page loads). Shows the three
 * top-clicked products' price, review count + star rating, and
 * leaf category — all from already-fetched Keepa data.
 */
function TopProductsTable({
  slots,
  enrichedByAsin,
}: {
  slots: TopProductSlot[];
  enrichedByAsin: Record<string, EnrichedProduct>;
}) {
  const rows = slots.filter((s): s is TopProductSlot & { asin: string } => !!s.asin);
  return (
    <div className="card-app overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-left text-gray-600">
          <tr>
            <th className="p-2 w-8">#</th>
            <th className="p-2">Product</th>
            <th className="p-2 text-right">Price</th>
            <th className="p-2 text-right">Reviews</th>
            <th className="p-2">Leaf category</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((s) => {
            const enriched = enrichedByAsin[s.asin];
            const title = enriched?.title ?? s.fallbackTitle ?? null;
            return (
              <tr key={`${s.slot}-${s.asin}`} className="align-top">
                <td className="p-2 font-mono text-gray-600">{s.slot}</td>
                <td className="p-2 max-w-md">
                  <div className="truncate" title={title ?? undefined}>
                    {title ?? <span className="text-gray-400">—</span>}
                  </div>
                  <div className="text-xs text-gray-500 font-mono">
                    <a
                      href={`https://www.amazon.com/dp/${s.asin}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:underline"
                    >
                      {s.asin}
                    </a>
                  </div>
                </td>
                <td className="p-2 text-right tabular-nums">
                  {formatPrice(enriched?.currentPriceCents ?? null)}
                </td>
                <td className="p-2 text-right tabular-nums whitespace-nowrap">
                  {formatReviews(enriched?.reviewCount ?? null, enriched?.averageRatingX10 ?? null)}
                </td>
                <td className="p-2 text-xs text-gray-700">
                  {enriched?.categoryLeaf ?? enriched?.categoryPath ?? <span className="text-gray-400">—</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function formatPrice(cents: number | null): React.ReactNode {
  if (cents === null || !Number.isFinite(cents)) return <span className="text-gray-400">—</span>;
  return `$${(cents / 100).toFixed(2)}`;
}

function formatReviews(count: number | null, ratingX10: number | null): React.ReactNode {
  if (count === null || !Number.isFinite(count)) return <span className="text-gray-400">—</span>;
  const star =
    ratingX10 !== null && Number.isFinite(ratingX10)
      ? <span className="text-yellow-600">★ {(ratingX10 / 10).toFixed(1)}</span>
      : null;
  const reviewStr = count >= 1000 ? `${(count / 1000).toFixed(1)}k` : count.toLocaleString();
  return (
    <span>
      {reviewStr}
      {star && <> · {star}</>}
    </span>
  );
}
