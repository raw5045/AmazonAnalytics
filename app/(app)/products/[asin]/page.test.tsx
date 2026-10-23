import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import type { ProductFacts } from '@/lib/products/loadProduct';

vi.mock('@/lib/env', () => ({ env: { DATABASE_URL: 'postgres://test' } }));
// The page builds its runner from neon(); the loaders are mocked, so no statement ever runs.
const neonMock = vi.hoisted(() => ({ neon: vi.fn(), query: vi.fn() }));
vi.mock('@neondatabase/serverless', () => ({ neon: neonMock.neon }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`redirect:${url}`);
  },
  notFound: () => {
    throw new Error('notFound');
  },
  useRouter: () => ({ back: vi.fn() }),
}));
// The page's gate is "signed in" (spec 2026-10-23 §2): getCurrentUser returns the account, or null when there is no session.
const auth = vi.hoisted(() => ({ user: null as null | { id: string; role: 'admin' | 'standard_user' } }));
vi.mock('@/lib/auth/getCurrentUser', () => ({ getCurrentUser: async () => auth.user }));
const loaders = vi.hoisted(() => ({ product: vi.fn(), history: vi.fn(), keywords: vi.fn() }));
vi.mock('@/lib/products/loadProduct', () => ({ loadProduct: loaders.product }));
vi.mock('@/lib/products/loadProductHistory', async (orig) => ({
  ...(await orig<typeof import('@/lib/products/loadProductHistory')>()),
  loadProductHistory: loaders.history,
}));
vi.mock('@/lib/products/loadProductKeywords', async (orig) => ({
  ...(await orig<typeof import('@/lib/products/loadProductKeywords')>()),
  loadProductKeywords: loaders.keywords,
}));
vi.mock('./LazyHistoryCharts', () => ({ LazyHistoryCharts: () => null, HistorySkeleton: () => null }));
// The usage counter (lib/activity/bump.ts, covered in bump.test.ts) is mocked: the page fires it and never awaits it.
const activity = vi.hoisted(() => ({ bump: vi.fn() }));
vi.mock('@/lib/activity/bump', () => ({ bumpUserActivity: activity.bump }));

import ProductPage from './page';
import { HistorySection, KeywordsSection } from './StreamedProductSections';

const ASIN = 'B0CXYZ1234';
const KW = '3f2a9c1e-5b7d-4e8a-9c3b-1a2b3c4d5e6f';
const NOT_IN_CATALOG = 'Not in the Keepa catalog (usually because its category is excluded from enrichment), so no product facts or history.';

const TITLE = 'Magnesium Glycinate 400 mg, 120 Capsules';
const CATALOG_ROW: ProductFacts = {
  asin: ASIN,
  title: TITLE,
  brand: 'Acme Labs',
  imageUrl: null,
  categoryPath: 'Health & Household › Vitamins, Minerals & Supplements',
  listedSince: '2026-04-12',
  trackingSince: '2026-04-15',
  currentPriceCents: 1999,
  avg30PriceCents: null,
  avg90PriceCents: null,
  avg180PriceCents: null,
  avg365PriceCents: null,
  salesRank: 1234,
  avg30SalesRank: null,
  avg90SalesRank: null,
  rankRatioX100: null,
  reviewCount: 1834,
  averageRatingX10: 45,
  lastRatingUpdate: null,
  monthlySold: 1000,
  keepaUpdatedAt: '2026-10-07',
  newOfferCount: 4,
  fbaOfferCount: 3,
  fbmOfferCount: 1,
  amazonAvailability: -1,
  enrichmentStatus: 'active',
  inCatalog: true,
  fetched: true,
  lastFetchedAt: '2026-10-08T06:30:00.000Z',
  fetchCount: 12,
  inScope: true,
  bestRank: 523,
  tier: 1,
  broadCategory: null,
};

/** loadProduct's stub for an ASIN with keyword rows and no catalog row. */
const STUB: ProductFacts = {
  ...CATALOG_ROW,
  title: null,
  brand: null,
  categoryPath: null,
  listedSince: null,
  trackingSince: null,
  currentPriceCents: null,
  salesRank: null,
  reviewCount: null,
  averageRatingX10: null,
  monthlySold: null,
  keepaUpdatedAt: null,
  newOfferCount: null,
  fbaOfferCount: null,
  fbmOfferCount: null,
  amazonAvailability: null,
  enrichmentStatus: null,
  inCatalog: false,
  fetched: false,
  lastFetchedAt: null,
  fetchCount: 0,
  inScope: false,
  bestRank: null,
  tier: 0,
  broadCategory: null,
};

const KEYWORDS = {
  rows: [
    {
      searchTermId: KW,
      searchTermRaw: 'magnesium glycinate',
      currentRank: 1234,
      estimatedMonthlySearches: 45678,
      slot: 1 as const,
      clickSharePct: 32.5,
      conversionSharePct: 18,
      weeksInTop3: 12,
      streakStartedWeek: '2026-07-18',
    },
  ],
  total: 1,
};

const ASYNC_SECTIONS = new Set<unknown>([HistorySection, KeywordsSection]);

/**
 * Stand-in for the server renderer: React's client renderer cannot render async components, so
 * each streamed section in the page's tree is replaced by its awaited output. Everything else is
 * left for Testing Library to render.
 */
async function resolveSections(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(resolveSections));
  if (!isValidElement(node)) return node;
  const el = node as ReactElement<{ children?: ReactNode }>;
  if (ASYNC_SECTIONS.has(el.type)) {
    const section = el.type as (props: unknown) => Promise<ReactNode>;
    return resolveSections(await section(el.props));
  }
  if (el.props.children === undefined) return el;
  const children = await resolveSections(el.props.children);
  return Array.isArray(children) ? cloneElement(el, undefined, ...children) : cloneElement(el, undefined, children);
}

/** The title band's header: the h1 with the brand, ASIN, status chip and Amazon link beside it. */
function band(): HTMLElement {
  const header = screen.getByRole('heading', { level: 1 }).closest('header');
  if (!header) throw new Error('no title band header');
  return header;
}

function callPage(asin: string, search: { from?: string | string[] } = {}) {
  return ProductPage({ params: Promise.resolve({ asin }), searchParams: Promise.resolve(search) });
}

async function renderPage(asin: string = ASIN, search: { from?: string | string[] } = {}) {
  return render(<>{await resolveSections(await callPage(asin, search))}</>);
}

describe('ProductPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The suite runs as a plain member (users.role 'standard_user'): nothing on this page depends on the role.
    auth.user = { id: 'm1', role: 'standard_user' };
    neonMock.neon.mockReturnValue({ query: neonMock.query });
    loaders.product.mockResolvedValue(CATALOG_ROW);
    loaders.history.mockResolvedValue([]);
    loaders.keywords.mockResolvedValue(KEYWORDS);
    activity.bump.mockResolvedValue(undefined);
  });

  it('redirects a signed-out visitor to /sign-in before any read', async () => {
    auth.user = null;
    await expect(callPage(ASIN)).rejects.toThrow('redirect:/sign-in');
    expect(neonMock.neon).not.toHaveBeenCalled();
    expect(loaders.product).not.toHaveBeenCalled();
    // Nothing is counted for a visitor the gate turned away.
    expect(activity.bump).not.toHaveBeenCalled();
  });

  it.each(['standard_user', 'admin'] as const)('a signed-in %s account gets the page (spec 2026-10-23 §2)', async (role) => {
    auth.user = { id: 'u1', role };
    await renderPage();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(TITLE);
    expect(screen.getByRole('heading', { name: 'Product facts' })).toBeInTheDocument();
    expect(loaders.product).toHaveBeenCalledWith(expect.any(Function), ASIN);
    expect(activity.bump.mock.calls).toEqual([['u1', 'product_view']]);
  });

  it('counts one product_view on the signed-in account, after the gate and the ASIN check and before the read, and never waits for it (spec 2026-10-23 §4)', async () => {
    // Never settles: the page cannot be waiting on the counter.
    activity.bump.mockReturnValue(new Promise<void>(() => {}));
    await renderPage();

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(TITLE);
    expect(activity.bump).toHaveBeenCalledTimes(1);
    expect(activity.bump).toHaveBeenCalledWith('m1', 'product_view');
    const counted = activity.bump.mock.invocationCallOrder[0];
    expect(counted).toBeLessThan(neonMock.neon.mock.invocationCallOrder[0]);
    expect(counted).toBeLessThan(loaders.product.mock.invocationCallOrder[0]);
  });

  it.each(['b0cxyz1234', 'B0CXYZ123', 'B0CXYZ12345', 'B0CXYZ123?', '../explorer'])(
    'a malformed ASIN (%j) is a 404 without a read, and is not counted as a product view',
    async (asin) => {
      await expect(callPage(asin)).rejects.toThrow('notFound');
      expect(loaders.product).not.toHaveBeenCalled();
      expect(activity.bump).not.toHaveBeenCalled();
    },
  );

  it('an ASIN in neither table (the loader returns null) is a 404, still counted: a read ran for it', async () => {
    loaders.product.mockResolvedValue(null);
    await expect(callPage(ASIN)).rejects.toThrow('notFound');
    expect(neonMock.neon).toHaveBeenCalledWith('postgres://test');
    expect(loaders.product).toHaveBeenCalledWith(expect.any(Function), ASIN);
    expect(loaders.history).not.toHaveBeenCalled();
    expect(loaders.keywords).not.toHaveBeenCalled();
    expect(activity.bump.mock.calls).toEqual([['m1', 'product_view']]);
  });

  it('a catalog row: the title band, the facts card, then the history and keywords sections', async () => {
    await renderPage(ASIN, { from: `/explorer/keyword/${KW}` });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(TITLE);
    expect(within(band()).getByText('Acme Labs')).toBeInTheDocument();
    expect(within(band()).getByText(ASIN)).toBeInTheDocument();
    const amazon = within(band()).getByRole('link', { name: 'View on Amazon' });
    expect(amazon).toHaveAttribute('href', `https://www.amazon.com/dp/${ASIN}`);
    expect(amazon).toHaveAttribute('target', '_blank');
    expect(amazon.getAttribute('rel')).toContain('noopener');
    expect(screen.getByRole('link', { name: '← Back to keyword' })).toHaveAttribute('href', `/explorer/keyword/${KW}`);
    expect(screen.getByRole('heading', { name: 'Product facts' })).toBeInTheDocument();
    expect(screen.queryByText(NOT_IN_CATALOG)).toBeNull();
    expect(loaders.history).toHaveBeenCalledWith(expect.any(Function), ASIN);
    expect(screen.getByRole('heading', { name: 'History' })).toBeInTheDocument();
    expect(loaders.keywords).toHaveBeenCalledWith(expect.any(Function), ASIN);
    expect(screen.getByRole('link', { name: 'magnesium glycinate' })).toHaveAttribute('href', `/explorer/keyword/${KW}`);
    // The sections share the page's one runner.
    expect(loaders.history.mock.calls[0][0]).toBe(loaders.product.mock.calls[0][0]);
    expect(loaders.keywords.mock.calls[0][0]).toBe(loaders.product.mock.calls[0][0]);
  });

  it('takes the first of repeated from= values, and an active row shows no status chip', async () => {
    await renderPage(ASIN, { from: ['/products?age=180', `/explorer/keyword/${KW}`] });
    expect(screen.getByRole('link', { name: '← Back to products' })).toHaveAttribute('href', '/products?age=180');
    expect(within(band()).queryByText(/Delisted|No price|Fetch error|Not fetched yet|Not in catalog/)).toBeNull();
  });

  it.each([
    [{ enrichmentStatus: 'delisted' as const }, 'Delisted'],
    [{ enrichmentStatus: 'no_price' as const }, 'No price'],
    [{ enrichmentStatus: 'error' as const }, 'Fetch error'],
    [{ enrichmentStatus: null, fetched: false, lastFetchedAt: null }, 'Not fetched yet'],
  ])('the title band flags %j as "%s"', async (over, chip) => {
    loaders.product.mockResolvedValue({ ...CATALOG_ROW, ...over });
    await renderPage();
    expect(within(band()).getByText(chip)).toBeInTheDocument();
  });

  it('a never-fetched catalog row never calls the history loader', async () => {
    loaders.product.mockResolvedValue({ ...CATALOG_ROW, enrichmentStatus: null, fetched: false, lastFetchedAt: null });
    await renderPage();
    expect(screen.getByText('Not fetched yet', { selector: 'p' })).toBeInTheDocument();
    expect(screen.getByText('No history yet')).toBeInTheDocument();
    expect(loaders.history).not.toHaveBeenCalled();
  });

  it('a stub (keyword rows, no catalog row): the bare ASIN, the not-in-catalog line, no history read, the keywords', async () => {
    loaders.product.mockResolvedValue(STUB);
    await renderPage();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(ASIN);
    expect(within(band()).getByText('Not in catalog')).toBeInTheDocument();
    expect(screen.getByText(NOT_IN_CATALOG)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Product facts' })).toBeNull();
    expect(loaders.history).not.toHaveBeenCalled();
    expect(screen.queryByRole('heading', { name: 'History' })).toBeNull();
    expect(loaders.keywords).toHaveBeenCalledWith(expect.any(Function), ASIN);
    expect(screen.getByRole('link', { name: 'magnesium glycinate' })).toBeInTheDocument();
  });

  it('a stub with a keyword-side title shows that title', async () => {
    loaders.product.mockResolvedValue({ ...STUB, title: 'Magnesium Glycinate Capsules' });
    await renderPage();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Magnesium Glycinate Capsules');
  });
});
