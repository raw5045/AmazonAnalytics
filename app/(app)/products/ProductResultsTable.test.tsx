import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { PRODUCT_DEFAULTS, parseProductFilters, type ProductFilters } from '@/lib/products/filters';
import type { ProductSummaryRow } from '@/lib/products/searchProducts';
import { ProductResultsTable } from './ProductResultsTable';
import { resolveProductBack } from './[asin]/BackToProducts';

const NOW = new Date('2026-10-09T15:00:00Z');

/** One fully-populated row. */
function makeRow(over: Partial<ProductSummaryRow> = {}): ProductSummaryRow {
  return {
    asin: 'B000000001', title: 'LED Desk Lamp', brand: 'Acme', listedSince: '2026-08-01', monthlySold: 1000, reviewCount: 120,
    averageRatingX10: 44, currentPriceCents: 1999, salesRank: 1234, rankRatioX100: 65, fbaOfferCount: 3, fbmOfferCount: 1,
    amazonAvailability: -1, enrichmentStatus: 'active', keywordCount: 7, ...over,
  };
}

function renderTable({
  rows = [makeRow()], total = rows.length, totalIsCapped = false, filters = PRODUCT_DEFAULTS,
}: { rows?: ProductSummaryRow[]; total?: number; totalIsCapped?: boolean; filters?: ProductFilters } = {}) {
  return render(<ProductResultsTable rows={rows} total={total} totalIsCapped={totalIsCapped} filters={filters} now={NOW} />);
}

/** The cells of body row `i` (0-based), in column order. */
const bodyCells = (i = 0) => within(screen.getAllByRole('row')[i + 1]).getAllByRole('cell');

describe('ProductResultsTable rows', () => {
  it('formats one full row', () => {
    renderTable({ filters: { ...PRODUCT_DEFAULTS, age: 180 } });
    const cells = bodyCells();
    expect(cells).toHaveLength(9);

    const title = within(cells[0]).getByRole('link', { name: 'LED Desk Lamp' });
    // The ASIN page's back link returns to this exact list (its `from`, percent-encoded).
    expect(title).toHaveAttribute('href', '/products/B000000001?from=%2Fproducts%3Fage%3D180');
    expect(title).toHaveAttribute('target', '_blank');
    expect(within(cells[0]).getByText('Acme')).toBeInTheDocument();
    const amazon = within(cells[0]).getByRole('link', { name: 'B000000001' });
    expect(amazon).toHaveAttribute('href', 'https://www.amazon.com/dp/B000000001');
    expect(amazon).toHaveAttribute('target', '_blank');

    expect(cells[1]).toHaveTextContent('Aug 1, 2026');
    expect(cells[1]).toHaveTextContent('69 days');
    expect(cells[2]).toHaveTextContent(/^1,000\+$/);
    expect(cells[3]).toHaveTextContent(/^120 · ★ 4\.4$/);
    expect(cells[4]).toHaveTextContent(/^\$19\.99$/);
    expect(cells[5]).toHaveTextContent('1,234');
    expect(within(cells[5]).getByText('−35%')).toHaveAttribute('title', expect.stringMatching(/30-day average/));
    expect(cells[6]).toHaveTextContent(/^FBA 3 \/ FBM 1$/);
    expect(cells[7]).toHaveTextContent(/^No Amazon offer$/);
    expect(cells[8]).toHaveTextContent(/^7$/);
  });

  it('the from param is the bare list URL under the default filters, and carries the page', () => {
    const { unmount } = renderTable();
    expect(within(bodyCells()[0]).getByRole('link', { name: 'LED Desk Lamp' })).toHaveAttribute('href', '/products/B000000001?from=%2Fproducts');
    unmount();
    renderTable({ filters: { ...PRODUCT_DEFAULTS, page: 2 } });
    expect(within(bodyCells()[0]).getByRole('link', { name: 'LED Desk Lamp' })).toHaveAttribute('href', '/products/B000000001?from=%2Fproducts%3Fpage%3D2');
  });

  it("the from it sends is the ASIN page back control's products list: the exact filtered URL, never with a from of its own", () => {
    // A stray from= on the list URL is not a filter, so the parse drops it and it cannot nest.
    const filters = parseProductFilters({ age: '180', cat: 'Home & Kitchen › Lighting', sort: 'listed', dir: 'asc', page: '2', from: '/explorer' });
    renderTable({ filters });
    const href = within(bodyCells()[0]).getByRole('link', { name: 'LED Desk Lamp' }).getAttribute('href') ?? '';
    const from = new URL(href, 'https://keywordquarry.test').searchParams.get('from') ?? '';
    expect(from).toBe('/products?age=180&cat=Home+%26+Kitchen+%E2%80%BA+Lighting&sort=listed&dir=asc&page=2');
    expect(new URLSearchParams(from.slice(from.indexOf('?') + 1)).has('from')).toBe(false);
    expect(parseProductFilters(Object.fromEntries(new URLSearchParams(from.slice(from.indexOf('?') + 1))))).toEqual(filters);
    expect(resolveProductBack(from)).toEqual({ href: from, label: 'Back to products', cameFromPage: true });
  });

  it('a value that is not ASIN-shaped gets no product-page link (the route would 404 it)', () => {
    renderTable({ rows: [makeRow({ asin: 'B00BAD#001', title: 'Odd Row' })] });
    const cell = bodyCells()[0];
    expect(within(cell).queryByRole('link', { name: 'Odd Row' })).not.toBeInTheDocument();
    expect(within(cell).getByText('Odd Row')).toBeInTheDocument();
    expect(within(cell).getByRole('link', { name: 'B00BAD#001' })).toHaveAttribute('href', 'https://www.amazon.com/dp/B00BAD%23001');
  });

  it('missing values render as dashes; an untitled product links by its ASIN', () => {
    renderTable({
      rows: [makeRow({
        title: null, brand: null, listedSince: null, monthlySold: null, reviewCount: null, averageRatingX10: null, currentPriceCents: null,
        salesRank: null, rankRatioX100: null, fbaOfferCount: null, fbmOfferCount: null, amazonAvailability: null, enrichmentStatus: 'no_price', keywordCount: 0,
      })],
    });
    const cells = bodyCells();
    const links = within(cells[0]).getAllByRole('link', { name: 'B000000001' });
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/products/B000000001?from=%2Fproducts', 'https://www.amazon.com/dp/B000000001']);
    for (const i of [1, 2, 3, 4, 5, 6, 7]) expect(cells[i], `column ${i}`).toHaveTextContent(/^—$/);
    expect(cells[8]).toHaveTextContent(/^0$/);
  });

  it('a rank above its 30-day average shows a "+" chip; at the average there is no chip', () => {
    renderTable({ rows: [makeRow({ asin: 'B000000001', rankRatioX100: 130 }), makeRow({ asin: 'B000000002', rankRatioX100: 100 })] });
    expect(within(bodyCells(0)[5]).getByText('+30%')).toBeInTheDocument();
    expect(bodyCells(1)[5]).toHaveTextContent(/^1,234$/);
  });

  it('shows the reviews without stars when the rating is missing, and large counts compactly', () => {
    renderTable({ rows: [makeRow({ reviewCount: 1834, averageRatingX10: null })] });
    expect(bodyCells()[3]).toHaveTextContent(/^1\.8k$/);
  });
});

describe('ProductResultsTable count line, hint and empty state', () => {
  it('counts the matches: exact, singular, and capped at 10,000+', () => {
    const { unmount } = renderTable({ total: 1234 });
    expect(screen.getByText('1,234 products')).toBeInTheDocument();
    unmount();
    const second = renderTable({ total: 1 });
    expect(screen.getByText('1 product')).toBeInTheDocument();
    second.unmount();
    renderTable({ total: 10_000, totalIsCapped: true });
    expect(screen.getByText('10,000+ products')).toBeInTheDocument();
  });

  it('says above the table when the sort hides products without its key', () => {
    const { unmount } = renderTable();
    expect(screen.getByText('Products without a monthly sold badge are hidden under this sort.')).toBeInTheDocument();
    unmount();
    renderTable({ filters: { ...PRODUCT_DEFAULTS, sort: 'keywords' } });
    expect(screen.queryByText(/hidden under this sort/)).not.toBeInTheDocument();
  });

  it('the empty state', () => {
    renderTable({ rows: [], total: 0 });
    expect(screen.getByText(/No products match these filters/)).toBeInTheDocument();
    expect(screen.getByText('0 products')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('past the last page: says so and links back to page 1 of the same filters', () => {
    renderTable({ rows: [], total: 120, filters: { ...PRODUCT_DEFAULTS, age: 180, page: 9 } });
    expect(screen.getByText(/past the last page/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to page 1' })).toHaveAttribute('href', '/products?age=180');
  });
});

describe('ProductResultsTable sortable headers', () => {
  const hrefOf = (name: string) => screen.getByRole('link', { name }).getAttribute('href');

  it('the active column toggles dir; the others open at their first-click direction; both keep the filters and drop the page', () => {
    renderTable({ filters: { ...PRODUCT_DEFAULTS, age: 180, sort: 'price', dir: 'asc', page: 3 } });
    expect(hrefOf('Price')).toBe('/products?age=180&sort=price&dir=desc');
    expect(hrefOf('Listed')).toBe('/products?age=180&sort=listed&dir=desc');
    expect(hrefOf('Monthly sold')).toBe('/products?age=180&sort=sold&dir=desc');
    expect(hrefOf('Reviews')).toBe('/products?age=180&sort=reviews&dir=asc');
    expect(hrefOf('BSR')).toBe('/products?age=180&sort=bsr&dir=asc');
    expect(hrefOf('vs 30d avg')).toBe('/products?age=180&sort=ratio&dir=asc');
    expect(hrefOf('Keywords')).toBe('/products?age=180&sort=keywords&dir=desc');
    expect(screen.getByRole('columnheader', { name: /Price/ })).toHaveAttribute('aria-sort', 'ascending');
    expect(screen.getByRole('columnheader', { name: /Reviews/ })).not.toHaveAttribute('aria-sort');
  });

  it('under the default sort (monthly sold, high to low) its header flips to low to high', () => {
    renderTable();
    expect(hrefOf('Monthly sold')).toBe('/products?sort=sold&dir=asc');
    expect(screen.getByRole('columnheader', { name: /Monthly sold/ })).toHaveAttribute('aria-sort', 'descending');
  });

  it('the header links describe the order they switch to', () => {
    renderTable({ filters: { ...PRODUCT_DEFAULTS, sort: 'bsr', dir: 'asc' } });
    expect(screen.getByRole('link', { name: 'BSR' })).toHaveAttribute('title', 'Sort: Worst rank first');
    expect(screen.getByRole('link', { name: 'Listed' })).toHaveAttribute('title', 'Sort: Newest first');
  });
});
