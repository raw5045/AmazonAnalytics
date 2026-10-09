/**
 * The ASIN page's facts card (spec 2026-10-09 §6.1): everything the Keepa catalog holds on the
 * product, with the dates each fact is "as of". The loader (lib/products/loadProduct.ts) already
 * applies the hiding rules: prices are null unless the row is active, and a delisted row's
 * point-in-time facts (rank, its averages and ratio, monthly sold, offers, Amazon availability) are
 * null, so each of those reads as a dash here.
 *
 * Three shapes: the full fact list; "Not fetched yet" for a catalog row the service has not fetched
 * (every fact null); one line for an ASIN with keyword rows but no catalog row (usually an excluded
 * category; a failed enqueue phase leaves new ASINs that way too). Pure and clock-free: the page
 * passes `now` for the listing age.
 */
import type { ReactNode } from 'react';
import type { AsinEnrichmentStatus } from '@/db/schema';
import type { ProductFacts as ProductPageFacts } from '@/lib/products/loadProduct';
import { availabilityLabel, formatBadge, formatPriceCents, formatRatio, listingAge } from '@/lib/products/format';

/**
 * loadProduct's facts. `inCatalog` is false for an ASIN with keyword rows but no catalog row; it is
 * optional here until the loader carries it, and an absent value reads as in the catalog.
 */
export type FactsCardFacts = ProductPageFacts & { inCatalog?: boolean };

export const STATUS_LABEL: Readonly<Record<AsinEnrichmentStatus, string>> = {
  active: 'Active',
  no_price: 'No price',
  delisted: 'Delisted',
  error: 'Fetch error',
};

const STATUS_TONE: Readonly<Record<AsinEnrichmentStatus, string>> = {
  active: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  no_price: 'bg-amber-50 text-amber-800 ring-amber-200',
  delisted: 'bg-red-50 text-red-700 ring-red-200',
  error: 'bg-amber-50 text-amber-800 ring-amber-200',
};

export const NOT_IN_CATALOG_LINE =
  'Not in the Keepa catalog (usually because its category is excluded from enrichment), so no product facts or history.';

const DASH = '—';

const finite = (n: number | null): n is number => n !== null && Number.isFinite(n);
const count = (n: number | null): string => (finite(n) ? n.toLocaleString('en-US') : DASH);
const rank = (n: number | null): string => (finite(n) ? `#${n.toLocaleString('en-US')}` : DASH);

export function FactsCard({ facts, now }: { facts: FactsCardFacts; now: Date }) {
  if (!(facts.inCatalog ?? true)) {
    return <p className="card-app px-4 py-3 text-sm text-gray-600">{NOT_IN_CATALOG_LINE}</p>;
  }

  if (!facts.fetched) {
    return (
      <section className="card-app p-4">
        <h2 className="text-sm font-semibold text-gray-700">Product facts</h2>
        <p className="mt-2 text-sm font-medium text-gray-900">Not fetched yet</p>
        <p className="mt-1 text-xs text-gray-500">
          The Keepa service has not fetched this product yet
          {facts.enrichmentStatus === 'error' ? ' (its last attempt failed)' : ''}; its facts and history
          appear after the first fetch.
        </p>
      </section>
    );
  }

  const priceAvgs = [facts.avg30PriceCents, facts.avg90PriceCents, facts.avg180PriceCents, facts.avg365PriceCents];
  const rankAvgs = [facts.avg30SalesRank, facts.avg90SalesRank];
  const offers = [facts.newOfferCount, facts.fbaOfferCount, facts.fbmOfferCount];
  const stars = finite(facts.averageRatingX10) ? `★ ${(facts.averageRatingX10 / 10).toFixed(1)}` : null;
  const reviews = [finite(facts.reviewCount) ? count(facts.reviewCount) : null, stars].filter((s) => s !== null);
  // https URLs only: the catalog's image is an Amazon CDN URL, and nothing else belongs in an <img src>.
  const imageUrl = facts.imageUrl?.startsWith('https://') ? facts.imageUrl : null;

  return (
    <section className="card-app p-4">
      <h2 className="mb-3 text-sm font-semibold text-gray-700">Product facts</h2>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        {imageUrl && (
          // One thumbnail from Amazon's image CDN: next/image would need a remotePatterns entry and the
          // optimizer for a single small image, so a plain lazy <img> with fixed dimensions instead.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={imageUrl}
            alt="Product image"
            width={112}
            height={112}
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            className="h-28 w-28 shrink-0 rounded border border-gray-100 bg-white object-contain"
          />
        )}
        {/* Dense flow: at two columns the wide Category cell would otherwise leave a hole beside Brand. */}
        <dl className="grid min-w-0 flex-1 grid-flow-row-dense grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
          <Fact label="Brand">{facts.brand ?? DASH}</Fact>
          <Fact label="Category" wide>
            {facts.categoryPath ?? DASH}
          </Fact>
          <Fact label="Listed since">
            {facts.listedSince ? `${facts.listedSince} · ${listingAge(facts.listedSince, now)}` : DASH}
          </Fact>
          <Fact label="Tracking since">{facts.trackingSince ?? DASH}</Fact>
          <Fact
            label="Price"
            sub={priceAvgs.some(finite) ? `30d / 90d / 180d / 365d avg ${priceAvgs.map(formatPriceCents).join(' / ')}` : null}
          >
            {formatPriceCents(facts.currentPriceCents)}
          </Fact>
          <Fact label="BSR" sub={rankAvgs.some(finite) ? `30d / 90d avg ${rankAvgs.map(rank).join(' / ')}` : null}>
            {rank(facts.salesRank)}
            {finite(facts.rankRatioX100) && <RatioChip ratioX100={facts.rankRatioX100} />}
          </Fact>
          <Fact label="Reviews" sub={facts.lastRatingUpdate ? `rating updated ${facts.lastRatingUpdate}` : null}>
            {reviews.length > 0 ? reviews.join(' · ') : DASH}
          </Fact>
          <Fact
            label="Monthly sold"
            sub={finite(facts.monthlySold) && facts.keepaUpdatedAt ? `as of ${facts.keepaUpdatedAt}` : null}
          >
            {formatBadge(facts.monthlySold)}
          </Fact>
          <Fact label="Offers">
            {offers.some(finite) ? `new ${count(offers[0])} · FBA ${count(offers[1])} · FBM ${count(offers[2])}` : DASH}
          </Fact>
          <Fact label="Amazon">{availabilityLabel(facts.amazonAvailability)}</Fact>
          <Fact label="Status" sub={fetchedLine(facts)}>
            {facts.enrichmentStatus ? <StatusBadge status={facts.enrichmentStatus} /> : DASH}
          </Fact>
        </dl>
      </div>
    </section>
  );
}

function Fact({ label, sub, wide = false, children }: { label: string; sub?: string | null; wide?: boolean; children: ReactNode }) {
  return (
    <div className={wide ? 'sm:col-span-2' : undefined}>
      <dt className="text-xs text-gray-500">{label}</dt>
      <dd className="mt-0.5 break-words text-sm text-gray-900">
        {children}
        {sub && <div className="mt-0.5 text-xs text-gray-500">{sub}</div>}
      </dd>
    </div>
  );
}

/** Rank against its own 30-day average, e.g. "−35% vs 30d avg" (green: ranked better than usual). */
function RatioChip({ ratioX100 }: { ratioX100: number }) {
  const tone =
    ratioX100 < 100
      ? 'bg-emerald-50 text-emerald-700'
      : ratioX100 > 100
        ? 'bg-red-50 text-red-700'
        : 'bg-gray-100 text-gray-600';
  return (
    <span
      className={`ml-2 inline-block rounded-full px-2 py-0.5 text-xs ${tone}`}
      title={`Rank ÷ its 30-day average × 100 = ${ratioX100} (under 100 = ranked better than its average)`}
    >
      {formatRatio(ratioX100)} vs 30d avg
    </span>
  );
}

function StatusBadge({ status }: { status: AsinEnrichmentStatus }) {
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${STATUS_TONE[status]}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}

/** "fetched 2026-10-08 (12 fetches)": the UTC date of the last fetch and the running count. */
function fetchedLine(facts: FactsCardFacts): string | null {
  if (!facts.lastFetchedAt) return null;
  const n = facts.fetchCount;
  return `fetched ${facts.lastFetchedAt.slice(0, 10)} (${n.toLocaleString('en-US')} ${n === 1 ? 'fetch' : 'fetches'})`;
}
