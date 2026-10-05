// lib/keepa/parseProduct.ts
/**
 * Pure parser: one Keepa product object (requested with rating=1, stats=90 and no history)
 * → ProductFacts (spec 2026-10-05 §5.1 step 5). No I/O.
 *
 * Every number comes from the `stats` object (`current`, `avg30`, `avg90`, `avg180`, `avg365`),
 * indexed by Keepa's Price Type; when a reply carries csv history instead (the `days=7`
 * fallback), the last csv value stands in for a `current` slot that is absent. Keepa's −1 and
 * anything below a field's floor becomes null. In the offer-count series Keepa's −1 means no
 * offers, so it is stored as 0. Keepa answers an inaccessible or invalid ASIN with a product
 * object of productType 3 or 4, which is "delisted"; a product with neither stats nor csv, and a
 * requested ASIN missing from the reply (parseKeepaBatch), are errors, never "no_price" or
 * "delisted".
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
/** Postgres `integer` maximum: a larger count, price or rank is garbage. */
const INT4_MAX = 2_147_483_647;

/**
 * Keepa Time minutes → ISO date; Keepa's 0 / −1 ("unknown") → null. Garbage past the year 2100
 * is null too, so no caller sees a RangeError or a year Postgres rejects.
 */
export function keepaMinutesToDate(km: unknown): string | null {
  if (typeof km !== 'number' || !Number.isFinite(km) || km <= 0) return null;
  const d = new Date((km + KEEPA_EPOCH_UNIX_MINUTES) * 60_000);
  if (Number.isNaN(d.getTime()) || d.getUTCFullYear() > 2100) return null;
  return d.toISOString().slice(0, 10);
}

/** A non-empty string with its NUL characters removed (Postgres text rejects them), else null. */
function str(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.replace(/\u0000/g, '');
  return s.length > 0 ? s : null;
}

/** Medium-resolution primary image (~500 px), as the old parser did. */
export function primaryImageUrl(images: unknown): string | null {
  if (!Array.isArray(images) || images.length === 0) return null;
  const first = images[0] as { m?: unknown } | null;
  if (!first || typeof first !== 'object') return null;
  const m = str(first.m);
  return m === null ? null : `${AMAZON_IMAGE_CDN}${m}`;
}

type Floor = 'positive' | 'nonNegative' | 'rating' | 'offerCount';

function clean(v: unknown, floor: Floor): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const n = Math.round(v);
  if (n > INT4_MAX) return null;
  if (floor === 'positive') return n > 0 ? n : null;
  if (floor === 'rating') return n >= 0 && n <= 50 ? n : null;
  if (floor === 'offerCount') return v === -1 ? 0 : n >= 0 ? n : null;
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

/**
 * The `stats.current` slot whenever it holds a number (−1 included: Keepa's answer is final);
 * the last csv value only when that slot is absent.
 */
function current(p: Record<string, unknown>, index: number, floor: Floor): number | null {
  const cur = (p.stats as Record<string, unknown> | null | undefined)?.current;
  const slot = Array.isArray(cur) ? cur[index] : undefined;
  return typeof slot === 'number' ? clean(slot, floor) : csvLast(p.csv, index, floor);
}

/** Keepa productType 3 (inaccessible) and 4 (invalid): the ASIN no longer resolves to a product. */
export const DELISTED_PRODUCT_TYPES: ReadonlySet<number> = new Set([3, 4]);

export function parseProductFacts(raw: unknown, expectedAsin: string): ProductFacts {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyFacts(expectedAsin, 'error', 'bad_object');
  const p = raw as Record<string, unknown>;
  if (p.asin !== expectedAsin) return emptyFacts(expectedAsin, 'error', 'asin_mismatch');
  if (typeof p.productType === 'number' && DELISTED_PRODUCT_TYPES.has(p.productType)) return emptyFacts(expectedAsin, 'delisted');
  // Fail closed: without stats or csv a Keepa format change would read as "no price" for every ASIN.
  if (!Array.isArray((p.stats as Record<string, unknown> | null | undefined)?.current) && !Array.isArray(p.csv)) {
    return emptyFacts(expectedAsin, 'error', 'no_stats');
  }

  const amazon = current(p, PRICE_TYPE.AMAZON, 'positive');
  const newPrice = current(p, PRICE_TYPE.NEW, 'positive');
  const priceSource: PriceSource | null = amazon !== null ? 'amazon' : newPrice !== null ? 'new' : null;
  const priceIndex = priceSource === 'amazon' ? PRICE_TYPE.AMAZON : PRICE_TYPE.NEW;
  const priceAvg = (key: string) => (priceSource ? stat(p.stats, key, priceIndex, 'positive') : null);

  const names = Array.isArray(p.categoryTree) ? (p.categoryTree as Array<{ name?: unknown } | null>).map((n) => str(n?.name)) : [];
  // All or nothing: a path with a dropped node would never match the full-path category matching.
  const tree = names.every((n): n is string => n !== null) ? names : [];
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
    newOfferCount: current(p, PRICE_TYPE.COUNT_NEW, 'offerCount'),
    fbaOfferCount: current(p, PRICE_TYPE.COUNT_NEW_FBA, 'offerCount'),
    fbmOfferCount: current(p, PRICE_TYPE.COUNT_NEW_FBM, 'offerCount'),
    amazonAvailability: availability,
    avg30PriceCents: priceAvg('avg30'),
    avg90PriceCents: priceAvg('avg90'),
    avg180PriceCents: priceAvg('avg180'),
    avg365PriceCents: priceAvg('avg365'),
    avg30SalesRank: stat(p.stats, 'avg30', PRICE_TYPE.SALES, 'positive'),
    avg90SalesRank: stat(p.stats, 'avg90', PRICE_TYPE.SALES, 'positive'),
  };
}

/**
 * One entry per requested ASIN. Keepa answers even an invalid ASIN with a product object, so a
 * requested ASIN missing from the reply means a cut-off reply: an error for that ASIN (backoff,
 * retried), never a delisting. A product object whose parse throws is an error for that ASIN
 * only (one bad product never fails its batch).
 */
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
    if (raw === undefined) {
      out.set(asin, emptyFacts(asin, 'error', 'missing_from_reply'));
      continue;
    }
    try {
      out.set(asin, parseProductFacts(raw, asin));
    } catch {
      out.set(asin, emptyFacts(asin, 'error', 'parse_failed'));
    }
  }
  return out;
}
