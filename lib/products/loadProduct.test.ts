// lib/products/loadProduct.test.ts
import { describe, it, expect } from 'vitest';
import { asinProducts, asinSnapshots, keywordTopAsins, keywordCurrentSummary } from '@/db/schema';
import { loadProduct, productFactsSql, productFallbackTitleSql, productTrackedSql, type ProductFacts } from './loadProduct';
import { loadProductHistory, productHistorySql, PRODUCT_HISTORY_CAP, type HistoryPoint } from './loadProductHistory';
import { aliasCols, dbCols, notIn, recordingRow, recordingRunner, selectNames } from './testHelpers';

/** Answers the three statements loadProduct can issue from fixed rows; anything else is a bug. */
function fakeRun(results: { facts?: unknown[]; tracked?: unknown[]; fallback?: unknown[] }) {
  return recordingRunner((text) => {
    if (text === productFactsSql('x').text) return results.facts ?? [];
    if (text === productTrackedSql('x').text) return results.tracked ?? [];
    if (text === productFallbackTitleSql('x').text) return results.fallback ?? [];
    throw new Error(`unexpected statement: ${text.slice(0, 60)}`);
  });
}
const FACTS_TEXT = productFactsSql('x').text;
const TRACKED_TEXT = productTrackedSql('x').text;
const FALLBACK_TEXT = productFallbackTitleSql('x').text;

const FACTS_CARD_COLUMNS = [
  'asin', 'title', 'brand', 'image_url', 'category_path', 'listed_since', 'tracking_since',
  'current_price_cents', 'avg30_price_cents', 'avg90_price_cents', 'avg180_price_cents', 'avg365_price_cents',
  'sales_rank', 'avg30_sales_rank', 'avg90_sales_rank', 'rank_ratio_x100',
  'review_count', 'average_rating_x10', 'last_rating_update', 'monthly_sold', 'keepa_updated_at',
  'new_offer_count', 'fba_offer_count', 'fbm_offer_count', 'amazon_availability',
  'enrichment_status', 'last_fetched_at', 'fetch_count', 'in_scope', 'best_rank', 'tier',
];

describe('productFactsSql', () => {
  const q = productFactsSql('B000000001');
  it('reads one catalog row by ASIN with no scope or status predicate (a direct link opens out-of-scope and delisted rows)', () => {
    expect(q.values).toEqual(['B000000001']);
    expect(q.text).toContain('FROM asin_products a');
    expect(q.text.slice(q.text.indexOf('WHERE'))).toBe('WHERE a.asin = $1');
  });
  it('selects every column the facts card shows, dates and the status as text', () => {
    expect(notIn(FACTS_CARD_COLUMNS, selectNames(q.text))).toEqual([]);
    for (const d of ['listed_since', 'tracking_since', 'last_rating_update', 'keepa_updated_at']) expect(q.text).toContain(`a.${d}::text AS ${d}`);
    expect(q.text).toContain('a.enrichment_status::text AS enrichment_status');
  });
  it('names only real columns', () => {
    expect(aliasCols(q.text, 'a').size).toBeGreaterThan(25);
    expect(notIn(aliasCols(q.text, 'a'), dbCols(asinProducts))).toEqual([]);
  });
});

describe('productFallbackTitleSql', () => {
  const q = productFallbackTitleSql('B000000002');
  it('takes the slot-1 title from the keyword side for this ASIN', () => {
    expect(q.values).toEqual(['B000000002']);
    expect(q.text).toContain('FROM keyword_top_asins k');
    expect(q.text).toContain('JOIN keyword_current_summary kcs ON kcs.search_term_id = k.search_term_id');
    expect(q.text).toContain('k.asin = $1');
    expect(q.text).toContain('k.slot = 1');
    expect(q.text).toContain('kcs.top_clicked_product_1_title_current IS NOT NULL');
    expect(q.text).toMatch(/LIMIT 1$/);
    expect([...selectNames(q.text)]).toEqual(['title']);
  });
  it('only takes a title that belongs to this ASIN: the summary is refreshed hours after the reverse table is built, so its slot-1 product can still be last week\'s', () => {
    expect(q.text).toContain('kcs.top_clicked_product_1_asin_current = k.asin');
  });
  it('names only real columns', () => {
    expect(aliasCols(q.text, 'k').size).toBeGreaterThan(1);
    expect(aliasCols(q.text, 'kcs').size).toBeGreaterThan(2);
    expect(notIn(aliasCols(q.text, 'k'), dbCols(keywordTopAsins))).toEqual([]);
    expect(notIn(aliasCols(q.text, 'kcs'), dbCols(keywordCurrentSummary))).toEqual([]);
  });
});

describe('productTrackedSql', () => {
  const q = productTrackedSql('B000000003');
  it('asks whether the reverse table has the ASIN at all', () => {
    expect(q.values).toEqual(['B000000003']);
    expect(q.text).toBe('SELECT 1 FROM keyword_top_asins k WHERE k.asin = $1 LIMIT 1');
  });
  it('names only real columns', () => {
    expect(aliasCols(q.text, 'k').size).toBeGreaterThan(0);
    expect(notIn(aliasCols(q.text, 'k'), dbCols(keywordTopAsins))).toEqual([]);
  });
});

/** A fully populated catalog row, as the facts statement returns it. */
const rawRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  asin: 'B000000001', title: 'Bamboo Desk Lamp', brand: 'Acme', image_url: 'https://m.media-amazon.com/images/I/lamp.jpg',
  category_path: 'Home & Kitchen › Lighting › Desk Lamps', listed_since: '2026-08-01', tracking_since: '2026-07-20',
  current_price_cents: 1999, avg30_price_cents: 2001, avg90_price_cents: 2002, avg180_price_cents: 2003, avg365_price_cents: 2004,
  sales_rank: 1234, avg30_sales_rank: 1900, avg90_sales_rank: 2100, rank_ratio_x100: 65,
  review_count: 120, average_rating_x10: 44, last_rating_update: '2026-10-01',
  monthly_sold: 1000, keepa_updated_at: '2026-10-08', new_offer_count: 4, fba_offer_count: 3, fbm_offer_count: 1, amazon_availability: -1,
  enrichment_status: 'active', last_fetched_at: new Date('2026-10-08T14:03:21.123Z'), fetch_count: 7, in_scope: true, best_rank: 812, tier: 1,
  ...over,
});

const ACTIVE: ProductFacts = {
  asin: 'B000000001', title: 'Bamboo Desk Lamp', brand: 'Acme', imageUrl: 'https://m.media-amazon.com/images/I/lamp.jpg',
  categoryPath: 'Home & Kitchen › Lighting › Desk Lamps', listedSince: '2026-08-01', trackingSince: '2026-07-20',
  currentPriceCents: 1999, avg30PriceCents: 2001, avg90PriceCents: 2002, avg180PriceCents: 2003, avg365PriceCents: 2004,
  salesRank: 1234, avg30SalesRank: 1900, avg90SalesRank: 2100, rankRatioX100: 65,
  reviewCount: 120, averageRatingX10: 44, lastRatingUpdate: '2026-10-01',
  monthlySold: 1000, keepaUpdatedAt: '2026-10-08', newOfferCount: 4, fbaOfferCount: 3, fbmOfferCount: 1, amazonAvailability: -1,
  enrichmentStatus: 'active', inCatalog: true, fetched: true, lastFetchedAt: '2026-10-08T14:03:21.123Z', fetchCount: 7, inScope: true, bestRank: 812, tier: 1,
};
const PRICES = ['currentPriceCents', 'avg30PriceCents', 'avg90PriceCents', 'avg180PriceCents', 'avg365PriceCents'];
const POINT_IN_TIME = ['salesRank', 'avg30SalesRank', 'avg90SalesRank', 'rankRatioX100', 'monthlySold', 'newOfferCount', 'fbaOfferCount', 'fbmOfferCount', 'amazonAvailability'];
const nulled = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, null]));

/** A catalog row the service has seeded but never fetched: only the queue columns are set. */
const NEVER_FETCHED_RAW = {
  ...Object.fromEntries(Object.keys(rawRow()).map((k) => [k, null])),
  asin: 'B000000002', fetch_count: 0, in_scope: true, best_rank: 4321, tier: 2,
};
const NEVER_FETCHED: ProductFacts = {
  asin: 'B000000002', title: null, brand: null, imageUrl: null, categoryPath: null, listedSince: null, trackingSince: null,
  currentPriceCents: null, avg30PriceCents: null, avg90PriceCents: null, avg180PriceCents: null, avg365PriceCents: null,
  salesRank: null, avg30SalesRank: null, avg90SalesRank: null, rankRatioX100: null,
  reviewCount: null, averageRatingX10: null, lastRatingUpdate: null,
  monthlySold: null, keepaUpdatedAt: null, newOfferCount: null, fbaOfferCount: null, fbmOfferCount: null, amazonAvailability: null,
  enrichmentStatus: null, inCatalog: true, fetched: false, lastFetchedAt: null, fetchCount: 0, inScope: true, bestRank: 4321, tier: 2,
};

/** An ASIN only the keyword side knows (the catalog has no row for it, e.g. an excluded category): no facts at all. */
const UNTRACKED: ProductFacts = {
  asin: 'B000000003', title: null, brand: null, imageUrl: null, categoryPath: null, listedSince: null, trackingSince: null,
  currentPriceCents: null, avg30PriceCents: null, avg90PriceCents: null, avg180PriceCents: null, avg365PriceCents: null,
  salesRank: null, avg30SalesRank: null, avg90SalesRank: null, rankRatioX100: null,
  reviewCount: null, averageRatingX10: null, lastRatingUpdate: null,
  monthlySold: null, keepaUpdatedAt: null, newOfferCount: null, fbaOfferCount: null, fbmOfferCount: null, amazonAvailability: null,
  enrichmentStatus: null, inCatalog: false, fetched: false, lastFetchedAt: null, fetchCount: 0, inScope: false, bestRank: null, tier: 0,
};

describe('loadProduct', () => {
  it('maps an active row: camelCase, dates as strings, the fetch time as an ISO string', async () => {
    const { run, calls } = fakeRun({ facts: [rawRow()] });
    await expect(loadProduct(run, 'B000000001')).resolves.toEqual(ACTIVE);
    expect(calls).toHaveLength(1); // the catalog has the title: no keyword-side read
    expect(calls[0].values).toEqual(['B000000001']);
  });

  it('accepts the fetch time as a string too', async () => {
    const { run } = fakeRun({ facts: [rawRow({ last_fetched_at: '2026-10-08T14:03:21.123Z' })] });
    expect((await loadProduct(run, 'B000000001'))?.lastFetchedAt).toBe('2026-10-08T14:03:21.123Z');
  });

  it.each([
    ['a string', 'not a time'],
    ['an Invalid Date', new Date('nope')],
  ])('reads %s as the fetch time as null instead of throwing, still counting the ASIN as fetched', async (_name, bad) => {
    const { run } = fakeRun({ facts: [rawRow({ last_fetched_at: bad })] });
    await expect(loadProduct(run, 'B000000001')).resolves.toEqual({ ...ACTIVE, fetched: true, lastFetchedAt: null });
  });

  it('hides every price and the point-in-time facts of a delisted row, keeping the historical ones', async () => {
    // A delisted write keeps the last fetch's facts in the catalog; the reader hides them.
    const { run } = fakeRun({ facts: [rawRow({ enrichment_status: 'delisted' })] });
    const f = await loadProduct(run, 'B000000001');
    expect(f).toEqual({ ...ACTIVE, enrichmentStatus: 'delisted', ...nulled([...PRICES, ...POINT_IN_TIME]) });
    expect(f).toMatchObject({
      title: 'Bamboo Desk Lamp', brand: 'Acme', imageUrl: 'https://m.media-amazon.com/images/I/lamp.jpg', categoryPath: 'Home & Kitchen › Lighting › Desk Lamps',
      listedSince: '2026-08-01', trackingSince: '2026-07-20', keepaUpdatedAt: '2026-10-08',
      reviewCount: 120, averageRatingX10: 44, lastRatingUpdate: '2026-10-01', fetched: true, fetchCount: 7,
    });
  });

  it('shows no price for a no_price row but keeps its rank, ratio and counts', async () => {
    const { run } = fakeRun({ facts: [rawRow({ enrichment_status: 'no_price' })] });
    await expect(loadProduct(run, 'B000000001')).resolves.toEqual({ ...ACTIVE, enrichmentStatus: 'no_price', ...nulled(PRICES) });
  });

  it('reads a never-fetched catalog row: in the catalog, fetched false, no facts, the title from the keyword side', async () => {
    const { run, calls } = fakeRun({ facts: [NEVER_FETCHED_RAW], fallback: [{ title: 'Keyword Side Title' }] });
    await expect(loadProduct(run, 'B000000002')).resolves.toEqual({ ...NEVER_FETCHED, title: 'Keyword Side Title' });
    expect(calls.map((c) => c.text)).toEqual([FACTS_TEXT, FALLBACK_TEXT]); // a catalog row is never checked against the reverse table
    expect(calls.map((c) => c.values)).toEqual([['B000000002'], ['B000000002']]);
  });

  it('keeps a null title when the keyword side has none either (the page shows the bare ASIN)', async () => {
    const { run } = fakeRun({ facts: [NEVER_FETCHED_RAW], fallback: [] });
    await expect(loadProduct(run, 'B000000002')).resolves.toEqual(NEVER_FETCHED);
  });

  it('treats a blank catalog title as missing', async () => {
    const { run, calls } = fakeRun({ facts: [rawRow({ title: '   ' })], fallback: [{ title: 'Keyword Side Title' }] });
    expect((await loadProduct(run, 'B000000001'))?.title).toBe('Keyword Side Title');
    expect(calls).toHaveLength(2);
  });

  it('reads an ASIN the catalog lacks but the reverse table has as a stub: not in the catalog, no facts, the keyword-side title', async () => {
    const { run, calls } = fakeRun({ facts: [], tracked: [{ '?column?': 1 }], fallback: [{ title: 'Keyword Side Title' }] });
    await expect(loadProduct(run, 'B000000003')).resolves.toEqual({ ...UNTRACKED, title: 'Keyword Side Title' });
    expect(calls.map((c) => c.text)).toEqual([FACTS_TEXT, TRACKED_TEXT, FALLBACK_TEXT]);
    expect(calls.map((c) => c.values)).toEqual([['B000000003'], ['B000000003'], ['B000000003']]);
  });

  it('keeps a null title on the stub when the keyword side has none (the ASIN is only in slots 2 or 3, or its title is empty)', async () => {
    const { run } = fakeRun({ facts: [], tracked: [{ '?column?': 1 }], fallback: [] });
    await expect(loadProduct(run, 'B000000003')).resolves.toEqual(UNTRACKED);
  });

  it('returns null only for an ASIN that is in neither table, without looking for a title', async () => {
    const { run, calls } = fakeRun({ facts: [], tracked: [] });
    await expect(loadProduct(run, 'B0NOTFOUND')).resolves.toBeNull();
    expect(calls.map((c) => c.text)).toEqual([FACTS_TEXT, TRACKED_TEXT]);
  });

  it('reads exactly the columns the facts statement selects', async () => {
    const { row, read } = recordingRow(rawRow());
    await loadProduct(async () => [row], 'B000000001');
    const selected = selectNames(productFactsSql('B000000001').text);
    expect(notIn(read, selected)).toEqual([]); // read but never selected: it would silently map to null
    expect(notIn(selected, read)).toEqual([]); // selected but never read: wasted
  });
});

describe('productHistorySql', () => {
  const q = productHistorySql('B000000001', 400);
  it('reads the newest snapshots of the ASIN, newest first, capped by a bound limit', () => {
    expect(q.values).toEqual(['B000000001', 400]);
    expect(q.text).toContain('FROM asin_snapshots s');
    expect(q.text).toContain('WHERE s.asin = $1');
    expect(q.text).toContain('ORDER BY s.fetched_at DESC');
    expect(q.text).toContain('LIMIT $2');
    expect(q.text).toContain('s.enrichment_status::text AS enrichment_status');
    expect(productHistorySql('B000000001', 25).values).toEqual(['B000000001', 25]);
  });
  it('selects the snapshot columns the charts use', () => {
    expect([...selectNames(q.text)]).toEqual([
      'fetched_at', 'current_price_cents', 'sales_rank', 'review_count', 'average_rating_x10',
      'monthly_sold', 'new_offer_count', 'fba_offer_count', 'fbm_offer_count', 'enrichment_status',
    ]);
  });
  it('names only real columns', () => {
    expect(aliasCols(q.text, 's').size).toBeGreaterThan(8);
    expect(notIn(aliasCols(q.text, 's'), dbCols(asinSnapshots))).toEqual([]);
  });
});

describe('loadProductHistory', () => {
  const snap = (fetchedAt: Date | string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
    fetched_at: fetchedAt, current_price_cents: 1999, sales_rank: 1234, review_count: 120, average_rating_x10: 44,
    monthly_sold: 1000, new_offer_count: 4, fba_offer_count: 3, fbm_offer_count: 1, enrichment_status: 'active', ...over,
  });
  const point = (fetchedAt: string, over: Partial<HistoryPoint> = {}): HistoryPoint => ({
    fetchedAt, currentPriceCents: 1999, salesRank: 1234, reviewCount: 120, averageRatingX10: 44,
    monthlySold: 1000, newOfferCount: 4, fbaOfferCount: 3, fbmOfferCount: 1, enrichmentStatus: 'active', ...over,
  });

  it('caps the read at 400 newest snapshots', async () => {
    const { run, calls } = recordingRunner(() => []);
    await loadProductHistory(run, 'B000000001');
    expect(PRODUCT_HISTORY_CAP).toBe(400);
    expect(calls).toEqual([productHistorySql('B000000001', 400)]);
  });

  it('returns the points oldest first, with ISO timestamps and nulls kept', async () => {
    // The statement returns the newest rows first (so the cap keeps the newest); the charts want time order.
    const rows = [
      snap(new Date('2026-10-08T14:00:00.000Z')),
      snap('2026-10-01T14:00:00.000Z', { sales_rank: 1500 }),
      snap(new Date('2026-09-24T14:00:00.000Z'), { enrichment_status: 'no_price', current_price_cents: null, monthly_sold: null }),
    ];
    const points = await loadProductHistory(async () => rows, 'B000000001');
    expect(points).toEqual([
      point('2026-09-24T14:00:00.000Z', { enrichmentStatus: 'no_price', currentPriceCents: null, monthlySold: null }),
      point('2026-10-01T14:00:00.000Z', { salesRank: 1500 }),
      point('2026-10-08T14:00:00.000Z'),
    ]);
  });

  it('drops a snapshot whose time cannot be read instead of throwing (it could not be placed on a time axis)', async () => {
    const rows = [
      snap(new Date('2026-10-08T14:00:00.000Z')),
      snap('not a time'),
      snap(new Date('nope')),
      snap(new Date('2026-09-24T14:00:00.000Z')),
    ];
    const points = await loadProductHistory(async () => rows, 'B000000001');
    expect(points.map((p) => p.fetchedAt)).toEqual(['2026-09-24T14:00:00.000Z', '2026-10-08T14:00:00.000Z']);
  });

  it('returns an empty list for an ASIN with no snapshots', async () => {
    await expect(loadProductHistory(async () => [], 'B000000001')).resolves.toEqual([]);
  });

  it('reads exactly the columns the history statement selects', async () => {
    const { row, read } = recordingRow(snap(new Date('2026-10-08T14:00:00.000Z')));
    await loadProductHistory(async () => [row], 'B000000001');
    const selected = selectNames(productHistorySql('B000000001', 400).text);
    expect(notIn(read, selected)).toEqual([]);
    expect(notIn(selected, read)).toEqual([]);
  });
});
