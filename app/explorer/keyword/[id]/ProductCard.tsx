/**
 * Product card for the /explorer/keyword/<id> detail page.
 *
 * One card per top-clicked ASIN (slots 1-3). Slot 1 renders an image
 * (160×160 medium-resolution from Amazon's CDN) alongside the data;
 * slots 2 and 3 are text-only to keep the page light. All cards
 * include an "Open on Amazon" link.
 *
 * Data sources:
 *   - `asin` + `fallbackTitle` come from kwm (always present)
 *   - `clickShare` / `conversionShare` come from kcs (slot 1 only)
 *   - `enriched` comes from asin_weekly_data (may be undefined for
 *     unenriched ASINs, e.g. dormant keywords)
 *
 * Pure server component — no client-side state.
 */
import type { EnrichedProduct } from '@/lib/explorer/fetchKeywordDetail';

const PLACEHOLDER_IMG_DATA_URL =
  "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 160 160'>" +
  "<rect fill='%23f3f4f6' width='160' height='160'/>" +
  "<text x='80' y='84' text-anchor='middle' font-family='sans-serif' font-size='12' fill='%239ca3af'>no image</text>" +
  '</svg>';

interface ProductCardProps {
  /** 1, 2, or 3 — slot 1 is the most-clicked product and gets richer rendering. */
  slotIndex: 1 | 2 | 3;
  asin: string;
  /** From kwm; fallback when asin_weekly_data doesn't have a title. */
  fallbackTitle: string | null;
  /** Slot 1 only — percentages as strings from kcs. */
  clickShare?: string | null;
  conversionShare?: string | null;
  /** Keepa-sourced enrichment data. Undefined for unenriched ASINs. */
  enriched?: EnrichedProduct;
}

export function ProductCard({
  slotIndex,
  asin,
  fallbackTitle,
  clickShare,
  conversionShare,
  enriched,
}: ProductCardProps) {
  const title = enriched?.title ?? fallbackTitle ?? '(no title)';
  const amazonUrl = `https://www.amazon.com/dp/${asin}`;
  const unavailable =
    enriched?.enrichmentStatus === 'no_price' || enriched?.enrichmentStatus === 'delisted';

  // Slot 1 — full card with image and trailing averages
  if (slotIndex === 1) {
    return (
      <div className="border rounded-lg p-4 flex gap-4 bg-white">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={enriched?.imageUrl ?? PLACEHOLDER_IMG_DATA_URL}
          alt=""
          width={160}
          height={160}
          loading="lazy"
          className="w-40 h-40 object-contain border rounded shrink-0 bg-gray-50"
        />
        <div className="flex-1 min-w-0">
          <div className="text-xs text-gray-500 font-mono">
            {asin}  •  rank #{slotIndex}
          </div>
          <h3 className="font-medium mt-1 leading-snug">{title}</h3>
          {enriched?.brand && (
            <div className="text-xs text-gray-600 mt-0.5">Brand: {enriched.brand}</div>
          )}

          <div className="mt-2 flex items-baseline gap-4 text-sm flex-wrap">
            {unavailable ? (
              <span className="text-amber-700 font-medium">
                Currently unavailable on Amazon
              </span>
            ) : (
              <span className="font-semibold text-lg">
                {formatPrice(enriched?.currentPriceCents ?? null)}
              </span>
            )}
            {enriched?.averageRatingX10 !== null && enriched?.averageRatingX10 !== undefined && (
              <span className="text-gray-700">
                {formatRating(enriched.averageRatingX10)}{' '}
                <span className="text-gray-500">
                  ({formatReviews(enriched.reviewCount ?? null)} reviews)
                </span>
              </span>
            )}
          </div>

          {(clickShare !== null && clickShare !== undefined) && (
            <div className="text-xs text-gray-500 mt-1">
              Click share: <span className="font-mono">{formatPct(clickShare)}</span>
              {' • '}
              Conv share: <span className="font-mono">{formatPct(conversionShare ?? null)}</span>
            </div>
          )}

          {enriched?.categoryPath && (
            <div className="text-xs text-gray-500 mt-2 truncate" title={enriched.categoryPath}>
              {enriched.categoryPath}
            </div>
          )}

          {enriched && hasAnyAvg(enriched) && (
            <div className="text-xs text-gray-500 mt-1 font-mono">
              Avg 30 / 90 / 180 / 365d:{' '}
              {formatPrice(enriched.avg30PriceCents)} / {formatPrice(enriched.avg90PriceCents)} /{' '}
              {formatPrice(enriched.avg180PriceCents)} / {formatPrice(enriched.avg365PriceCents)}
            </div>
          )}

          <a
            href={amazonUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block mt-3 text-sm text-blue-600 hover:underline"
          >
            View on Amazon →
          </a>
        </div>
      </div>
    );
  }

  // Slots 2 & 3 — compact text-only cards
  return (
    <div className="border rounded-lg p-3 bg-white">
      <div className="text-xs text-gray-500 font-mono">
        {asin}  •  rank #{slotIndex}
      </div>
      <h3 className="font-medium mt-1 leading-snug text-sm">{title}</h3>
      <div className="mt-1.5 flex items-baseline gap-3 text-xs flex-wrap">
        {enriched?.brand && (
          <span className="text-gray-600">Brand: {enriched.brand}</span>
        )}
        {unavailable ? (
          <span className="text-amber-700 font-medium">Currently unavailable</span>
        ) : (
          <span className="font-semibold text-sm">
            {formatPrice(enriched?.currentPriceCents ?? null)}
          </span>
        )}
        {enriched?.averageRatingX10 !== null && enriched?.averageRatingX10 !== undefined && (
          <span className="text-gray-700">
            {formatRating(enriched.averageRatingX10)}{' '}
            <span className="text-gray-500">
              ({formatReviews(enriched.reviewCount ?? null)})
            </span>
          </span>
        )}
      </div>
      {enriched?.categoryPath && (
        <div
          className="text-xs text-gray-500 mt-1.5 truncate"
          title={enriched.categoryPath}
        >
          {enriched.categoryPath}
        </div>
      )}
      <a
        href={amazonUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-block mt-2 text-xs text-blue-600 hover:underline"
      >
        View on Amazon →
      </a>
    </div>
  );
}

function formatPrice(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—';
  return `$${(cents / 100).toFixed(2)}`;
}

function formatRating(x10: number | null): string {
  if (x10 === null) return '—';
  return `${(x10 / 10).toFixed(1)}★`;
}

function formatReviews(n: number | null): string {
  if (n === null) return '—';
  return n.toLocaleString();
}

function formatPct(s: string | null): string {
  if (s === null || s === '') return '—';
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return '—';
  return `${n.toFixed(1)}%`;
}

function hasAnyAvg(e: EnrichedProduct): boolean {
  return (
    e.avg30PriceCents !== null ||
    e.avg90PriceCents !== null ||
    e.avg180PriceCents !== null ||
    e.avg365PriceCents !== null
  );
}
