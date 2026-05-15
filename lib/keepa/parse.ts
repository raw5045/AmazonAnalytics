/**
 * Pure parser: convert a raw Keepa product response into an EnrichmentRow
 * ready for asin_weekly_data INSERT.
 *
 * Reference:
 *   csv[0]  = Amazon price (cents)        — primary current price source
 *   csv[1]  = "New" price (cents)         — fallback when csv[0] empty
 *   csv[3]  = Sales rank
 *   csv[16] = RATING (0-50 scale)         — stored as-is in average_rating_x10
 *   csv[17] = COUNT_REVIEWS
 *
 * Time format: "Keepa Time Minutes" — minutes since 2011-01-01 00:00 UTC.
 *
 * Status state machine (see asin_weekly_data column docs):
 *   product null/undefined            → 'delisted'
 *   csv[0] AND csv[1] both unavailable → 'no_price' (rest still captured)
 *   else                              → 'active'
 *
 * No I/O here — caller fetches the JSON via lib/keepa/client.ts, then
 * passes products[0] in. Keeps this fully unit-testable from fixtures.
 */
import type { EnrichmentRow } from './types';

const AMAZON_IMAGE_CDN = 'https://m.media-amazon.com/images/I/';

/**
 * Keepa csv arrays are alternating [timestamp_min, value, timestamp_min, value, ...].
 * Returns the last value, or null when the array is missing/empty or the
 * last value is -1 (Keepa's "unavailable" sentinel).
 */
export function lastCsvValue(arr: unknown): number | null {
  if (!Array.isArray(arr) || arr.length < 2) return null;
  const v = arr[arr.length - 1];
  if (typeof v !== 'number' || v < 0) return null;
  return v;
}

/**
 * Convert Keepa Time Minutes → ISO date (YYYY-MM-DD).
 *
 * Keepa epoch = 2011-01-01 00:00 UTC = 1,293,840,000 unix seconds
 *                                     = 21,564,000 unix minutes.
 * unixSeconds = (keepaMinutes + 21564000) * 60.
 */
export function keepaMinutesToDate(km: number | null | undefined): string | null {
  if (km === null || km === undefined || km < 0) return null;
  return new Date((km + 21_564_000) * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * Pull the medium-resolution primary product image URL out of Keepa's
 * `images` array.
 *
 * Each image entry is { l: 'large.jpg', lH, lW, m: 'medium.jpg', mH, mW }.
 * We use the medium (~500×500) since the product card renders at 160×160
 * (good through 3× DPI displays without hitting the 2560×2560 large).
 * Returns null when images is missing, empty, or the first entry lacks `m`.
 */
export function primaryImageUrl(images: unknown): string | null {
  if (!Array.isArray(images) || images.length === 0) return null;
  const first = images[0] as { m?: unknown } | null;
  if (!first || typeof first !== 'object') return null;
  const m = first.m;
  if (typeof m !== 'string' || m.length === 0) return null;
  return `${AMAZON_IMAGE_CDN}${m}`;
}

/**
 * Simple trailing-window average over a Keepa csv price array.
 *
 * Walks backward from the most recent entry, stops once a timestamp is
 * older than (nowMinutes - days*1440). Skips -1 entries. Returns the
 * integer mean, or null if fewer than 2 valid data points were found
 * inside the window.
 *
 * Limitation: this is a simple arithmetic mean of observation points,
 * not a time-weighted mean. A product priced $10 for 25 days and $20
 * for 5 days will report ~$15, not the time-weighted $11.67. Fine for
 * "roughly what's it cost lately" displays; revisit if higher fidelity
 * becomes important.
 */
export function averageCsvLastN(
  arr: unknown,
  days: number,
  nowMinutes: number,
): number | null {
  if (!Array.isArray(arr) || arr.length < 4) return null;
  const cutoffMinutes = nowMinutes - days * 1440;
  let sum = 0;
  let count = 0;
  for (let i = arr.length - 2; i >= 0; i -= 2) {
    const t = arr[i];
    const v = arr[i + 1];
    if (typeof t !== 'number' || typeof v !== 'number') continue;
    if (t < cutoffMinutes) break;
    if (v < 0) continue;
    sum += v;
    count += 1;
  }
  if (count < 2) return null;
  return Math.round(sum / count);
}

/**
 * Orchestrator: take one Keepa product (typically `response.products[0]`)
 * and produce the EnrichmentRow for asin_weekly_data.
 */
export function parseKeepaProduct(
  rawProduct: unknown,
  asin: string,
  weekEndDate: string,
): EnrichmentRow {
  // Delisted case: Keepa returned no product object at all.
  if (!rawProduct || typeof rawProduct !== 'object') {
    return emptyRow(asin, weekEndDate, 'delisted');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = rawProduct as any;
  const csv: unknown[] = Array.isArray(p.csv) ? p.csv : [];

  // Price: prefer Amazon (csv[0]), fall back to "New" (csv[1]).
  // If neither has a current value, the product is suppressed/unavailable
  // on Amazon — flag as no_price but keep capturing the metadata.
  const amazonPrice = lastCsvValue(csv[0]);
  const newPrice = lastCsvValue(csv[1]);
  const currentPriceCents = amazonPrice ?? newPrice;
  const status: 'active' | 'no_price' = currentPriceCents !== null ? 'active' : 'no_price';

  // Category breadcrumb (root → leaf). Tree may be null for some no_price ASINs.
  const tree: Array<{ catId: number; name: string }> = Array.isArray(p.categoryTree)
    ? p.categoryTree
    : [];
  const categoryPath = tree.length > 0 ? tree.map((n) => n.name).join(' › ') : null;
  const categoryRoot = tree[0]?.name ?? null;
  const categoryLeaf = tree[tree.length - 1]?.name ?? null;

  // Reference timestamp for trailing-window averages. Use the most-recent
  // csv[0] timestamp as "now" — that anchors us to whatever moment Keepa
  // last observed the price. Falls back to "now" in Keepa minutes if csv[0]
  // is empty.
  const nowMinutes = (() => {
    if (Array.isArray(csv[0]) && csv[0].length >= 2) {
      const lastTs = csv[0][csv[0].length - 2];
      if (typeof lastTs === 'number') return lastTs;
    }
    return Math.floor(Date.now() / 60_000) - 21_564_000;
  })();

  return {
    asin,
    week_end_date: weekEndDate,
    title: typeof p.title === 'string' ? p.title : null,
    brand: typeof p.brand === 'string' ? p.brand : null,
    image_url: primaryImageUrl(p.images),
    category_path: categoryPath,
    category_root: categoryRoot,
    category_leaf: categoryLeaf,
    current_price_cents: currentPriceCents,
    sales_rank: lastCsvValue(csv[3]),
    review_count: lastCsvValue(csv[17]),
    average_rating_x10: lastCsvValue(csv[16]),
    last_rating_update: keepaMinutesToDate(
      typeof p.lastRatingUpdate === 'number' ? p.lastRatingUpdate : null,
    ),
    avg30_price_cents: averageCsvLastN(csv[0], 30, nowMinutes),
    avg90_price_cents: averageCsvLastN(csv[0], 90, nowMinutes),
    avg180_price_cents: averageCsvLastN(csv[0], 180, nowMinutes),
    avg365_price_cents: averageCsvLastN(csv[0], 365, nowMinutes),
    variations: Array.isArray(p.variations) ? p.variations : null,
    promotions: Array.isArray(p.promotions) ? p.promotions : null,
    enrichment_status: status,
    error_message: null,
  };
}

/**
 * Build an empty EnrichmentRow with a given terminal status. Used for the
 * delisted case and (from the Inngest job) the error case.
 */
export function emptyRow(
  asin: string,
  weekEndDate: string,
  status: 'delisted' | 'error',
  errorMessage: string | null = null,
): EnrichmentRow {
  return {
    asin,
    week_end_date: weekEndDate,
    title: null,
    brand: null,
    image_url: null,
    category_path: null,
    category_root: null,
    category_leaf: null,
    current_price_cents: null,
    sales_rank: null,
    review_count: null,
    average_rating_x10: null,
    last_rating_update: null,
    avg30_price_cents: null,
    avg90_price_cents: null,
    avg180_price_cents: null,
    avg365_price_cents: null,
    variations: null,
    promotions: null,
    enrichment_status: status,
    error_message: errorMessage,
  };
}
