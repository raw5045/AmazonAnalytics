import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type {
  CurrentWeekProductSlot,
  EnrichedProduct,
  KeywordProducts,
} from '@/lib/explorer/fetchKeywordDetail';

const fetchKeywordProducts = vi.hoisted(() => vi.fn());
vi.mock('@/lib/explorer/fetchKeywordDetail', () => ({ fetchKeywordProducts }));

import { TopProductsSection } from './TopProductsSection';

const KW = '3f2a9c1e-5b7d-4e8a-9c3b-1a2b3c4d5e6f';
const WEEK = '2026-10-03';

function slot(n: 1 | 2 | 3, asin: string | null, fallbackTitle: string | null): CurrentWeekProductSlot {
  return { slot: n, asin, title: fallbackTitle, clickShare: '32.50', conversionShare: '18.00' };
}

function enriched(asin: string, over: Partial<EnrichedProduct> = {}): EnrichedProduct {
  return {
    asin, title: null, brand: null, imageUrl: null, categoryPath: null, categoryRoot: null, categoryLeaf: null,
    currentPriceCents: null, salesRank: null, reviewCount: null, averageRatingX10: null,
    avg30PriceCents: null, avg90PriceCents: null, avg180PriceCents: null, avg365PriceCents: null,
    enrichmentStatus: 'active', ...over,
  };
}

/** Slots 1–2 carry a Keepa title; slot 3 has no catalog row, so its title is the keyword data's fallback. */
const TITLES = [
  { asin: 'B000000001', title: 'LED Desk Lamp' },
  { asin: 'B000000002', title: 'Clip-On Reading Light' },
  { asin: 'B000000003', title: 'Desk Lamp With USB Port' },
];

function mockProducts(over: Partial<KeywordProducts> = {}): void {
  fetchKeywordProducts.mockResolvedValue({
    currentWeekProductSlots: [slot(1, 'B000000001', null), slot(2, 'B000000002', null), slot(3, 'B000000003', TITLES[2].title)],
    enrichedProductsByAsin: {
      B000000001: enriched('B000000001', { title: TITLES[0].title }),
      B000000002: enriched('B000000002', { title: TITLES[1].title }),
    },
    ...over,
  } satisfies KeywordProducts);
}

async function renderSection(linkProducts: boolean) {
  return render(await TopProductsSection({ id: KW, currentWeekEndDate: WEEK, linkProducts, keywordId: KW }));
}

const fromParam = encodeURIComponent(`/explorer/keyword/${KW}`);

function productHrefs(): string[] {
  return screen.queryAllByRole('link').map((a) => a.getAttribute('href') ?? '').filter((h) => h.startsWith('/products'));
}

describe('TopProductsSection title links (admin link-back to the ASIN page)', () => {
  beforeEach(() => {
    fetchKeywordProducts.mockReset();
    mockProducts();
  });

  it('linkProducts: each title (Keepa or fallback) links to /products/<asin> carrying the keyword page as ?from=', async () => {
    await renderSection(true);
    expect(fetchKeywordProducts).toHaveBeenCalledWith(KW, WEEK);
    for (const { asin, title } of TITLES) {
      expect(screen.getByRole('link', { name: title })).toHaveAttribute('href', `/products/${asin}?from=${fromParam}`);
    }
    expect(productHrefs()).toHaveLength(3);
  });

  it('from is the percent-encoded keyword URL, and decodes back to it', async () => {
    await renderSection(true);
    const href = screen.getByRole('link', { name: TITLES[0].title }).getAttribute('href') ?? '';
    expect(href).toBe(`/products/B000000001?from=%2Fexplorer%2Fkeyword%2F${KW}`);
    expect(new URL(href, 'https://keywordquarry.com').searchParams.get('from')).toBe(`/explorer/keyword/${KW}`);
  });

  it('not linkProducts: titles are plain text, nothing links to /products', async () => {
    await renderSection(false);
    for (const { title } of TITLES) {
      expect(screen.getByText(title).closest('a')).toBeNull();
    }
    expect(productHrefs()).toHaveLength(0);
  });

  it.each([true, false])('the title keeps its truncate wrapper and tooltip (linkProducts=%s)', async (linkProducts) => {
    await renderSection(linkProducts);
    for (const { title } of TITLES) {
      const wrapper = screen.getByText(title).closest('div.truncate');
      expect(wrapper).toHaveAttribute('title', title);
      expect(wrapper).toHaveTextContent(title);
    }
  });

  it.each([true, false])('the ASIN keeps its Amazon link in a new tab (linkProducts=%s)', async (linkProducts) => {
    await renderSection(linkProducts);
    const amazon = screen.getByRole('link', { name: 'B000000001' });
    expect(amazon).toHaveAttribute('href', 'https://www.amazon.com/dp/B000000001');
    expect(amazon).toHaveAttribute('target', '_blank');
    expect(amazon).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('a product with no title anywhere keeps its plain dash: only a title is linked', async () => {
    mockProducts({ currentWeekProductSlots: [slot(1, 'B000000009', null)], enrichedProductsByAsin: {} });
    const { container } = await renderSection(true);
    const wrapper = container.querySelector('div.truncate');
    expect(wrapper).toHaveTextContent('—');
    expect(wrapper?.querySelector('a')).toBeNull();
    expect(productHrefs()).toHaveLength(0);
  });
});
