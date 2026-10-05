// lib/keepa/parseProduct.ts
/**
 * Pure parser: one Keepa product object (requested with rating=1, stats=90 and no history)
 * → ProductFacts (spec 2026-10-05 §5.1 step 5). No I/O.
 *
 * Every number comes from the `stats` object (`current`, `avg30`, `avg90`, `avg180`, `avg365`),
 * indexed by Keepa's Price Type; when a reply carries csv history instead (the `days=7`
 * fallback), the last csv value stands in for `current`. Keepa's −1 and anything below a
 * field's floor becomes null. A missing product is the caller's "delisted" (parseKeepaBatch).
 */
import { emptyFacts, type PriceSource, type ProductFacts } from './productFacts';

/** Keepa "Price Type" indices, shared by the csv arrays and every stats array. */
export const PRICE_TYPE = {
  AMAZON: 0,
  NEW: 1,
  SALES: 3,
  COUNT_NEW: 11,
  RATING: 16,
  COUNT_REVIEWS: 17,
  COUNT_NEW_FBA: 34,
  COUNT_NEW_FBM: 35,
} as const;

const AMAZON_IMAGE_CDN = 'https://m.media-amazon.com/images/I/';
/** Keepa epoch 2011-01-01T00:00Z expressed in unix minutes. */
const KEEPA_EPOCH_UNIX_MINUTES = 21_564_000;

/** Keepa Time minutes → ISO date; Keepa's 0 / −1 ("unknown") → null. */
export function keepaMinutesToDate(km: unknown): string | null {
  if (typeof km !== 'number' || !Number.isFinite(km) || km <= 0) return null;
  return new Date((km + KEEPA_EPOCH_UNIX_MINUTES) * 60_000).toISOString().slice(0, 10);
}

/** Medium-resolution primary image (~500 px), as the old parser did. */
export function primaryImageUrl(images: unknown): string | null {
  if (!Array.isArray(images) || images.length === 0) return null;
  const first = images[0] as { m?: unknown } | null;
  if (!first || typeof first !== 'object') return null;
  return typeof first.m === 'string' && first.m.length > 0 ? `${AMAZON_IMAGE_CDN}${first.m}` : null;
}

type Floor = 'positive' | 'nonNegative' | 'rating';

function clean(v: unknown, floor: Floor): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const n = Math.round(v);
  if (floor === 'positive') return n > 0 ? n : null;
  if (floor === 'rating') return n >= 0 && n <= 50 ? n : null;
  return n >= 0 ? n : null;
}

function stat(stats: unknown, key: string, index: number, floor: Floor): number | null {
  const arr = (stats as Record<string, unknown> | null | undefined)?.[key];
  return Array.isArray(arr) ? clean(arr[index], floor) : null;
}

function csvLast(csv: unknown, index: number, floor: Floor): number | null {
  if (!Array.isArray(csv)) return null;
  const series = csv[index];
  if (!Array.isArray(series) || series.length < 2) return null;
  return clean(series[series.length - 1], floor);
}

function current(p: Record<string, unknown>, index: number, floor: Floor): number | null {
  return stat(p.stats, 'current', index, floor) ?? csvLast(p.csv, index, floor);
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export function parseProductFacts(raw: unknown, expectedAsin: string): ProductFacts {
  if (!raw || typeof raw !== 'object') return emptyFacts(expectedAsin, 'error', 'bad_object');
  const p = raw as Record<string, unknown>;
  if (p.asin !== expectedAsin) return emptyFacts(expectedAsin, 'error', 'asin_mismatch');

  const amazon = current(p, PRICE_TYPE.AMAZON, 'positive');
  const newPrice = current(p, PRICE_TYPE.NEW, 'positive');
  const priceSource: PriceSource | null = amazon !== null ? 'amazon' : newPrice !== null ? 'new' : null;
  const priceIndex = priceSource === 'amazon' ? PRICE_TYPE.AMAZON : PRICE_TYPE.NEW;
  const priceAvg = (key: string) => (priceSource ? stat(p.stats, key, priceIndex, 'positive') : null);

  const tree = Array.isArray(p.categoryTree)
    ? (p.categoryTree as Array<{ name?: unknown } | null>).map((n) => str(n?.name)).filter((n): n is string => n !== null)
    : [];
  const availability =
    typeof p.availabilityAmazon === 'number' && Number.isInteger(p.availabilityAmazon) && p.availabilityAmazon >= -1 && p.availabilityAmazon <= 4
      ? p.availabilityAmazon
      : null;

  return {
    asin: expectedAsin,
    status: priceSource ? 'active' : 'no_price',
    errorCode: null,
    title: str(p.title),
    brand: str(p.brand),
    imageUrl: primaryImageUrl(p.images),
    categoryPath: tree.length > 0 ? tree.join(' › ') : null,
    categoryRoot: tree[0] ?? null,
    categoryLeaf: tree.length > 0 ? tree[tree.length - 1] : null,
    listedSince: keepaMinutesToDate(p.listedSince),
    trackingSince: keepaMinutesToDate(p.trackingSince),
    currentPriceCents: priceSource === 'amazon' ? amazon : newPrice,
    priceSource,
    salesRank: current(p, PRICE_TYPE.SALES, 'positive'),
    reviewCount: current(p, PRICE_TYPE.COUNT_REVIEWS, 'nonNegative'),
    averageRatingX10: current(p, PRICE_TYPE.RATING, 'rating'),
    lastRatingUpdate: keepaMinutesToDate(p.lastRatingUpdate),
    monthlySold: clean(p.monthlySold, 'positive'),
    keepaUpdatedAt: keepaMinutesToDate(p.lastUpdate),
    newOfferCount: current(p, PRICE_TYPE.COUNT_NEW, 'nonNegative'),
    fbaOfferCount: current(p, PRICE_TYPE.COUNT_NEW_FBA, 'nonNegative'),
    fbmOfferCount: current(p, PRICE_TYPE.COUNT_NEW_FBM, 'nonNegative'),
    amazonAvailability: availability,
    avg30PriceCents: priceAvg('avg30'),
    avg90PriceCents: priceAvg('avg90'),
    avg180PriceCents: priceAvg('avg180'),
    avg365PriceCents: priceAvg('avg365'),
    avg30SalesRank: stat(p.stats, 'avg30', PRICE_TYPE.SALES, 'positive'),
    avg90SalesRank: stat(p.stats, 'avg90', PRICE_TYPE.SALES, 'positive'),
  };
}

/** One entry per requested ASIN; a requested ASIN with no product in the reply is delisted. */
export function parseKeepaBatch(requested: readonly string[], products: unknown): Map<string, ProductFacts> {
  const byAsin = new Map<string, unknown>();
  if (Array.isArray(products)) {
    for (const raw of products) {
      const a = (raw as { asin?: unknown } | null)?.asin;
      if (typeof a === 'string') byAsin.set(a, raw);
    }
  }
  const out = new Map<string, ProductFacts>();
  for (const asin of requested) {
    const raw = byAsin.get(asin);
    out.set(asin, raw === undefined ? emptyFacts(asin, 'delisted') : parseProductFacts(raw, asin));
  }
  return out;
}
