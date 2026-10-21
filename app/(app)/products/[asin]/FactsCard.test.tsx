import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { ProductFacts as ProductPageFacts } from '@/lib/products/loadProduct';
import { FactsCard } from './FactsCard';

const MINUS = String.fromCodePoint(0x2212);
const NOW = new Date('2026-10-09T12:00:00Z');
const CATEGORY = 'Health & Household › Vitamins, Minerals & Supplements › Minerals › Magnesium';

const FULL: ProductPageFacts = {
  asin: 'B0CXYZ1234',
  title: 'Magnesium Glycinate 400 mg, 120 Capsules',
  brand: 'Acme Labs',
  imageUrl: 'https://m.media-amazon.com/images/I/71abcdefgh.jpg',
  categoryPath: CATEGORY,
  listedSince: '2026-04-12',
  trackingSince: '2026-04-15',
  currentPriceCents: 1999,
  avg30PriceCents: 1899,
  avg90PriceCents: 2049,
  avg180PriceCents: 2099,
  avg365PriceCents: null,
  salesRank: 1234,
  avg30SalesRank: 1900,
  avg90SalesRank: 2500,
  rankRatioX100: 65,
  reviewCount: 1834,
  averageRatingX10: 45,
  lastRatingUpdate: '2026-10-01',
  monthlySold: 1000,
  keepaUpdatedAt: '2026-10-07',
  newOfferCount: 4,
  fbaOfferCount: 3,
  fbmOfferCount: 1,
  amazonAvailability: -1,
  enrichmentStatus: 'active',
  fetched: true,
  lastFetchedAt: '2026-10-08T06:30:00.000Z',
  fetchCount: 12,
  inScope: true,
  bestRank: 523,
  tier: 1,
  broadCategory: 'Health & Personal Care',
  inCatalog: true,
};

/** What loadProduct returns for a delisted row: prices (not active) and the point-in-time facts are null. */
const DELISTED: ProductPageFacts = {
  ...FULL,
  enrichmentStatus: 'delisted',
  currentPriceCents: null,
  avg30PriceCents: null,
  avg90PriceCents: null,
  avg180PriceCents: null,
  avg365PriceCents: null,
  salesRank: null,
  avg30SalesRank: null,
  avg90SalesRank: null,
  rankRatioX100: null,
  monthlySold: null,
  newOfferCount: null,
  fbaOfferCount: null,
  fbmOfferCount: null,
  amazonAvailability: null,
};

/**
 * A catalog row the service has not fetched yet: every fact null, the title from the keyword side.
 * broadCategory is inherited from FULL on purpose (NOT_IN_CATALOG spreads this too): the code stays
 * set to prove those shapes never show it.
 */
const NEVER_FETCHED: ProductPageFacts = {
  ...DELISTED,
  title: 'Magnesium Glycinate Capsules',
  brand: null,
  imageUrl: null,
  categoryPath: null,
  listedSince: null,
  trackingSince: null,
  reviewCount: null,
  averageRatingX10: null,
  lastRatingUpdate: null,
  keepaUpdatedAt: null,
  enrichmentStatus: null,
  fetched: false,
  lastFetchedAt: null,
  fetchCount: 0,
  bestRank: 4200,
  tier: 2,
};

/** Keyword rows but no catalog row (usually an excluded category): loadProduct's stub. */
const NOT_IN_CATALOG: ProductPageFacts = { ...NEVER_FETCHED, inScope: false, tier: 0, inCatalog: false };

/** The <dd> beside a fact's <dt> label. */
function fact(label: string): HTMLElement {
  const dd = screen.getByText(label, { selector: 'dt' }).nextElementSibling;
  if (!(dd instanceof HTMLElement) || dd.tagName !== 'DD') throw new Error(`no <dd> beside "${label}"`);
  return dd;
}

describe('FactsCard — a full active row', () => {
  it('renders every label with one value each, dates as "Mon D, YYYY", and the last-fetched stamp', () => {
    render(<FactsCard facts={FULL} now={NOW} />);
    expect(fact('Brand')).toHaveTextContent('Acme Labs');
    expect(fact('Leaf category')).toHaveTextContent(CATEGORY);
    expect(fact('Broad category')).toHaveTextContent('Health & Personal Care');
    expect(fact('Listed since')).toHaveTextContent('Apr 12, 2026 · 180 days');
    expect(fact('Tracking since')).toHaveTextContent('Apr 15, 2026');
    expect(fact('Price')).toHaveTextContent('$19.99');
    expect(fact('Price')).not.toHaveTextContent('avg');
    expect(fact('BSR')).toHaveTextContent('#1,234');
    expect(fact('BSR')).not.toHaveTextContent('30d / 90d avg');
    expect(within(fact('BSR')).getByText(`${MINUS}35% vs 30d avg`)).toBeInTheDocument();
    expect(fact('Reviews')).toHaveTextContent('1,834 · ★ 4.5');
    expect(fact('Reviews')).not.toHaveTextContent('rating updated');
    expect(fact('Monthly sold')).toHaveTextContent('1,000+');
    expect(fact('Monthly sold')).toHaveTextContent("Amazon's 'bought in past month' badge");
    expect(fact('Monthly sold')).not.toHaveTextContent('as of');
    expect(fact('Offers')).toHaveTextContent('new 4 · FBA 3 · FBM 1');
    expect(fact('Amazon')).toHaveTextContent('No Amazon offer');
    expect(within(fact('Status')).getByText('Active')).toBeInTheDocument();
    expect(fact('Status')).not.toHaveTextContent('fetched');
    expect(screen.getByText('Data last fetched Oct 8, 2026')).toBeInTheDocument();
  });

  it('shows one lazy thumbnail with a width and height when the image URL is set, decorative (the h1 names the product)', () => {
    const { container } = render(<FactsCard facts={FULL} now={NOW} />);
    const imgs = container.querySelectorAll('img');
    expect(imgs).toHaveLength(1);
    expect(imgs[0]).toHaveAttribute('src', FULL.imageUrl);
    expect(imgs[0]).toHaveAttribute('alt', '');
    expect(imgs[0]).toHaveAttribute('loading', 'lazy');
    expect(imgs[0]).toHaveAttribute('width');
    expect(imgs[0]).toHaveAttribute('height');
  });

  // Only an https URL becomes an <img src>; anything else renders no image at all.
  it.each([
    null,
    '',
    'http://m.media-amazon.com/images/I/71abcdefgh.jpg',
    'javascript:alert(1)',
    'data:image/svg+xml,<svg onload="alert(1)"/>',
    '//m.media-amazon.com/images/I/71abcdefgh.jpg',
    ' https://m.media-amazon.com/images/I/71abcdefgh.jpg',
  ])('no thumbnail for the image URL %j', (imageUrl) => {
    const { container } = render(<FactsCard facts={{ ...FULL, imageUrl }} now={NOW} />);
    expect(container.querySelector('img')).toBeNull();
    expect(fact('Brand')).toHaveTextContent('Acme Labs'); // the rest of the card still renders
  });

  it('the ratio chip is left out when Keepa has no 30-day average', () => {
    render(<FactsCard facts={{ ...FULL, rankRatioX100: null, avg30SalesRank: null, avg90SalesRank: null }} now={NOW} />);
    expect(fact('BSR')).toHaveTextContent(/^#1,234$/);
  });

  it('a rank worse than its 30-day average reads as a plus', () => {
    render(<FactsCard facts={{ ...FULL, rankRatioX100: 130 }} now={NOW} />);
    expect(within(fact('BSR')).getByText('+30% vs 30d avg')).toBeInTheDocument();
  });

  it('the stamp is omitted when there is no last fetch time', () => {
    render(<FactsCard facts={{ ...FULL, lastFetchedAt: null }} now={NOW} />);
    expect(screen.queryByText(/Data last fetched/)).toBeNull();
  });

  it('a product whose path is unmapped reads a dash for its broad category', () => {
    render(<FactsCard facts={{ ...FULL, broadCategory: null }} now={NOW} />);
    expect(fact('Broad category')).toHaveTextContent(/^—$/);
  });
});

describe('FactsCard — edge states', () => {
  it('a delisted row: a "Delisted" badge and dashes for the hidden point-in-time facts; the rest stays', () => {
    render(<FactsCard facts={DELISTED} now={NOW} />);
    expect(within(fact('Status')).getByText('Delisted')).toBeInTheDocument();
    for (const label of ['Price', 'BSR', 'Offers', 'Amazon']) {
      expect(fact(label)).toHaveTextContent(/^—$/);
    }
    // Monthly sold: the dash, then its static badge note (the note shows whatever the value).
    expect(fact('Monthly sold')).toHaveTextContent(/^—Amazon's 'bought in past month' badge$/);
    expect(fact('Brand')).toHaveTextContent('Acme Labs');
    expect(fact('Leaf category')).toHaveTextContent(CATEGORY);
    expect(fact('Listed since')).toHaveTextContent('Apr 12, 2026 · 180 days');
    expect(fact('Reviews')).toHaveTextContent('1,834 · ★ 4.5');
    expect(screen.getByText('Data last fetched Oct 8, 2026')).toBeInTheDocument();
  });

  it('a never-fetched row: "Not fetched yet" instead of the fact list', () => {
    const { container } = render(<FactsCard facts={NEVER_FETCHED} now={NOW} />);
    expect(screen.getByText('Not fetched yet')).toBeInTheDocument();
    expect(screen.queryByText('Brand', { selector: 'dt' })).toBeNull();
    expect(screen.queryByText('Broad category', { selector: 'dt' })).toBeNull();
    expect(screen.queryByText('Health & Personal Care')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(screen.queryByText(/Not in the Keepa catalog/)).toBeNull();
    expect(screen.queryByText(/Data last fetched/)).toBeNull();
  });

  it('an ASIN with keyword rows but no catalog row: the one "not in the catalog" line, nothing else', () => {
    const { container } = render(<FactsCard facts={NOT_IN_CATALOG} now={NOW} />);
    expect(container).toHaveTextContent(
      /^Not in the Keepa catalog \(usually because its category is excluded from enrichment\), so no product facts or history\.$/,
    );
    expect(screen.queryByText('Not fetched yet')).toBeNull();
    expect(screen.queryByText('Brand', { selector: 'dt' })).toBeNull();
  });
});
