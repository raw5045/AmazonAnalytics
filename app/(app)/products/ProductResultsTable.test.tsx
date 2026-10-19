import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { PRODUCT_DEFAULTS, parseProductFilters, type ProductFilters } from '@/lib/products/filters';
import type { ProductSummaryRow } from '@/lib/products/searchProducts';
import { ProductResultsTable } from './ProductResultsTable';
import { resolveProductBack } from './[asin]/BackToProducts';

// next/link as a plain anchor that shows the navigation props it was given, so the tests can see
// which links replace the history entry, keep the scroll position or skip the prefetch.
vi.mock('next/link', async () => {
  const { createElement } = await import('react');
  type Props = { href: string; replace?: boolean; scroll?: boolean; prefetch?: boolean | null; children?: ReactNode } & Record<string, unknown>;
  return {
    default: ({ href, replace, scroll, prefetch, children, ...rest }: Props) =>
      createElement(
        'a',
        {
          href,
          'data-replace': replace === undefined ? undefined : String(replace),
          'data-scroll': scroll === undefined ? undefined : String(scroll),
          'data-prefetch': prefetch === undefined ? undefined : String(prefetch),
          ...rest,
        },
        children,
      ),
    useLinkStatus: () => ({ pending: false }),
  };
});

const NOW = new Date('2026-10-09T15:00:00Z');

/** One fully-populated row. */
function makeRow(over: Partial<ProductSummaryRow> = {}): ProductSummaryRow {
  return {
    asin: 'B000000001', title: 'LED Desk Lamp', brand: 'Acme', categoryPath: 'Home & Kitchen › Lighting › Desk Lamps', listedSince: '2026-08-01', monthlySold: 1000, reviewCount: 120,
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

describe('ProductResultsTable rows (spec 2026-10-19 §8)', () => {
  it('formats one full row in the thirteen columns', () => {
    renderTable({ filters: { ...PRODUCT_DEFAULTS, age: 180 } });
    const cells = bodyCells();
    expect(cells).toHaveLength(13);
    const headers = screen.getAllByRole('columnheader');
    expect(headers).toHaveLength(13);
    expect(headers[0]).toHaveTextContent(/^Open on Amazon$/); // visually hidden
    expect(headers[1]).toHaveTextContent(/^Product$/);
    expect(headers[2]).toHaveTextContent(/^Leaf category$/);
    expect(headers[3]).toHaveTextContent(/Monthly sold/);
    expect(headers[4]).toHaveTextContent(/^Rating$/);
    expect(headers[5]).toHaveTextContent(/Reviews/);
    expect(headers[6]).toHaveTextContent(/Listed/);
    expect(headers[7]).toHaveTextContent(/BSR/);
    expect(headers[8]).toHaveTextContent(/vs 30d avg/);
    expect(headers[9]).toHaveTextContent(/Price/);
    expect(headers[10]).toHaveTextContent(/Keywords/);
    expect(headers[11]).toHaveTextContent(/^FBA$/);
    expect(headers[12]).toHaveTextContent(/^Amazon$/);
    expect(headers[8]).toHaveAttribute('title', 'BSR vs its 30-day average');
    expect(headers[11]).toHaveAttribute('title', 'New offers fulfilled by Amazon; hover a cell for the FBA / FBM counts');
    expect(headers[12]).toHaveAttribute('title', "Amazon's own offer on the listing");
    expect(within(headers[0]).getByText('Open on Amazon')).toHaveClass('sr-only');

    // 1: the magnifier opens the listing on Amazon in a new tab.
    const magnifier = within(cells[0]).getByRole('link', { name: 'Open B000000001 on Amazon' });
    expect(magnifier).toHaveAttribute('href', 'https://www.amazon.com/dp/B000000001');
    expect(magnifier).toHaveAttribute('target', '_blank');
    expect(magnifier).toHaveAttribute('rel', 'noopener noreferrer nofollow');
    expect(magnifier).toHaveAttribute('title', 'Open the listing on Amazon');

    // 2: the title links to the product page (its `from` = this exact list, percent-encoded); brand · ASIN as text.
    const title = within(cells[1]).getByRole('link', { name: 'LED Desk Lamp' });
    expect(title).toHaveAttribute('href', '/products/B000000001?from=%2Fproducts%3Fage%3D180');
    expect(title).toHaveAttribute('target', '_blank');
    expect(title).toHaveAttribute('data-prefetch', 'false');
    expect(title).not.toHaveAttribute('data-replace');
    expect(within(cells[1]).getByText('Acme')).toBeInTheDocument();
    expect(within(cells[1]).getByText('B000000001')).toBeInTheDocument();
    expect(within(cells[1]).queryByRole('link', { name: 'B000000001' })).not.toBeInTheDocument();

    expect(cells[2]).toHaveTextContent(/^Desk Lamps$/);
    expect(cells[2]).toHaveAttribute('title', 'Home & Kitchen › Lighting › Desk Lamps');
    expect(cells[3]).toHaveTextContent(/^1,000\+$/);
    expect(cells[4]).toHaveTextContent(/^★ 4\.4$/);
    expect(cells[5]).toHaveTextContent(/^120$/);
    expect(cells[6]).toHaveTextContent('Aug 1, 2026');
    expect(cells[6]).toHaveTextContent('69 days');
    expect(cells[7]).toHaveTextContent(/^1,234$/);
    expect(cells[8]).toHaveTextContent(/^−35%$/);
    expect(cells[9]).toHaveTextContent(/^\$19\.99$/);
    expect(cells[10]).toHaveTextContent(/^7$/);
    // 12–13: a check reads "Yes", an X reads "No"; the counts and the availability sit in the cells' titles.
    expect(cells[11]).toHaveTextContent(/^Yes$/);
    expect(cells[11]).toHaveAttribute('title', 'FBA 3 / FBM 1');
    expect(cells[12]).toHaveTextContent(/^No$/);
    expect(cells[12]).toHaveAttribute('title', 'No Amazon offer');
    expect(within(cells[11]).getByText('Yes')).toHaveClass('sr-only');
    expect(cells[11].querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('the from param is the bare list URL under the default filters, and carries the page', () => {
    const { unmount } = renderTable();
    expect(within(bodyCells()[1]).getByRole('link', { name: 'LED Desk Lamp' })).toHaveAttribute('href', '/products/B000000001?from=%2Fproducts');
    unmount();
    renderTable({ filters: { ...PRODUCT_DEFAULTS, page: 2 } });
    expect(within(bodyCells()[1]).getByRole('link', { name: 'LED Desk Lamp' })).toHaveAttribute('href', '/products/B000000001?from=%2Fproducts%3Fpage%3D2');
  });

  it("the from it sends is the ASIN page back control's products list: the exact filtered URL, never with a from of its own", () => {
    // A stray from= on the list URL is not a filter, so the parse drops it and it cannot nest.
    const filters = parseProductFilters({ age: '180', leaf: 'Home & Kitchen › Lighting', sort: 'listed', dir: 'asc', page: '2', from: '/explorer' });
    renderTable({ filters });
    const href = within(bodyCells()[1]).getByRole('link', { name: 'LED Desk Lamp' }).getAttribute('href') ?? '';
    const from = new URL(href, 'https://keywordquarry.test').searchParams.get('from') ?? '';
    expect(from).toBe('/products?age=180&leaf=Home+%26+Kitchen+%E2%80%BA+Lighting&sort=listed&dir=asc&page=2');
    expect(new URLSearchParams(from.slice(from.indexOf('?') + 1)).has('from')).toBe(false);
    expect(parseProductFilters(Object.fromEntries(new URLSearchParams(from.slice(from.indexOf('?') + 1))))).toEqual(filters);
    expect(resolveProductBack(from)).toEqual({ href: from, label: 'Back to products', cameFromPage: true });
  });

  it('a value that is not ASIN-shaped gets neither the product-page link (the route would 404 it) nor the magnifier', () => {
    renderTable({ rows: [makeRow({ asin: 'B00BAD#001', title: 'Odd Row' })] });
    const cells = bodyCells();
    expect(within(cells[0]).queryByRole('link')).not.toBeInTheDocument();
    expect(within(cells[1]).queryByRole('link', { name: 'Odd Row' })).not.toBeInTheDocument();
    expect(within(cells[1]).getByText('Odd Row')).toBeInTheDocument();
    expect(within(cells[1]).getByText('B00BAD#001')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /on Amazon/ })).not.toBeInTheDocument();
  });

  it('missing values render as dashes; an untitled product links by its ASIN; the magnifier still shows', () => {
    renderTable({
      rows: [makeRow({
        title: null, brand: null, categoryPath: null, listedSince: null, monthlySold: null, reviewCount: null, averageRatingX10: null, currentPriceCents: null,
        salesRank: null, rankRatioX100: null, fbaOfferCount: null, fbmOfferCount: null, amazonAvailability: null, enrichmentStatus: 'no_price', keywordCount: 0,
      })],
    });
    const cells = bodyCells();
    expect(within(cells[0]).getByRole('link', { name: 'Open B000000001 on Amazon' })).toHaveAttribute('href', 'https://www.amazon.com/dp/B000000001');
    expect(within(cells[1]).getByRole('link', { name: 'B000000001' })).toHaveAttribute('href', '/products/B000000001?from=%2Fproducts');
    for (const i of [2, 3, 4, 5, 6, 7, 8, 9, 11, 12]) expect(cells[i], `column ${i}`).toHaveTextContent(/^—$/);
    expect(cells[2]).not.toHaveAttribute('title');
    expect(cells[11]).not.toHaveAttribute('title');
    expect(cells[12]).not.toHaveAttribute('title');
    expect(cells[10]).toHaveTextContent(/^0$/);
  });

  it('a category path whose last segment is blank shows the whole path', () => {
    renderTable({ rows: [makeRow({ categoryPath: 'Home & Kitchen › ' })] });
    expect(bodyCells()[2]).toHaveTextContent(/^Home & Kitchen ›$/);
    expect(bodyCells()[2]).toHaveAttribute('title', 'Home & Kitchen › ');
  });

  it('the BSR comparison has its own column: a "+" chip above the average, "0%" at it, a dash without one while the rank still shows', () => {
    renderTable({
      rows: [
        makeRow({ asin: 'B000000001', rankRatioX100: 130 }),
        makeRow({ asin: 'B000000002', rankRatioX100: 100 }),
        makeRow({ asin: 'B000000003', rankRatioX100: null }),
      ],
    });
    expect(bodyCells(0)[8]).toHaveTextContent(/^\+30%$/);
    expect(bodyCells(1)[8]).toHaveTextContent(/^0%$/);
    expect(within(bodyCells(1)[8]).getByText('0%')).toHaveAttribute('title', 'BSR vs its 30-day average: at its average');
    expect(within(bodyCells(0)[8]).getByText('+30%')).toHaveAttribute('title', 'BSR vs its 30-day average: ranked worse than its average');
    expect(bodyCells(2)[7]).toHaveTextContent(/^1,234$/);
    expect(bodyCells(2)[8]).toHaveTextContent(/^—$/);
  });

  it('the rating and the reviews are two columns: a dash without a rating, large counts compact', () => {
    renderTable({ rows: [makeRow({ reviewCount: 1834, averageRatingX10: null })] });
    expect(bodyCells()[4]).toHaveTextContent(/^—$/);
    expect(bodyCells()[5]).toHaveTextContent(/^1\.8k$/);
  });

  it.each<[number | null, string, string]>([
    [null, '—', 'FBA — / FBM 1'],
    [0, 'No', 'FBA 0 / FBM 1'],
    [3, 'Yes', 'FBA 3 / FBM 1'],
  ])('FBA %s reads "%s"', (fba, text, title) => {
    renderTable({ rows: [makeRow({ fbaOfferCount: fba, fbmOfferCount: 1 })] });
    expect(bodyCells()[11]).toHaveTextContent(new RegExp(`^${text}$`));
    expect(bodyCells()[11]).toHaveAttribute('title', title);
  });

  it.each<[number | null, string, string | null]>([
    [null, '—', null],
    [-1, 'No', 'No Amazon offer'],
    [0, 'Yes', 'In stock'],
    [2, 'Yes', 'Unknown'],
    [4, 'Yes', 'Delayed'],
  ])('Amazon availability %s reads "%s"', (code, text, title) => {
    renderTable({ rows: [makeRow({ amazonAvailability: code })] });
    const cell = bodyCells()[12];
    expect(cell).toHaveTextContent(new RegExp(`^${text}$`));
    if (title === null) expect(cell).not.toHaveAttribute('title');
    else expect(cell).toHaveAttribute('title', title);
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
    expect(screen.getByRole('link', { name: 'Go to page 1' })).toHaveAttribute('data-replace', 'true');
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

  it('header links replace the history entry and keep the scroll position, like Apply and the pager', () => {
    renderTable({ filters: { ...PRODUCT_DEFAULTS, sort: 'price', dir: 'asc' } });
    for (const name of ['Listed', 'Monthly sold', 'Reviews', 'Price', 'BSR', 'vs 30d avg', 'Keywords']) {
      const link = screen.getByRole('link', { name });
      expect(link, name).toHaveAttribute('data-replace', 'true');
      expect(link, name).toHaveAttribute('data-scroll', 'false');
      expect(link, name).toHaveAttribute('data-prefetch', 'false');
    }
  });

  it('the header links describe the order they switch to', () => {
    renderTable({ filters: { ...PRODUCT_DEFAULTS, sort: 'bsr', dir: 'asc' } });
    expect(screen.getByRole('link', { name: 'BSR' })).toHaveAttribute('title', 'Sort: Worst rank first');
    expect(screen.getByRole('link', { name: 'Listed' })).toHaveAttribute('title', 'Sort: Newest first');
  });
});
