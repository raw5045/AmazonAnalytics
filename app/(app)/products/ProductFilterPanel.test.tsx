import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { PRODUCT_DEFAULTS, PRODUCT_SORTS, productFiltersToSearchParams, type ProductFilters } from '@/lib/products/filters';
import { sortHidesNullKey } from '@/lib/products/searchProducts';
import { ProductFilterPanel, filtersToPending, pendingToFilters, sortHint } from './ProductFilterPanel';

const { replace } = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }));

const LEAVES = [
  'Home & Kitchen › Lighting › Desk Lamps',
  'Home & Kitchen › Lighting › Floor Lamps',
  'Toys & Games › Puzzles › Jigsaw Puzzles',
];

/** Every filter set to a non-default value, on page 3. */
const SEEDED: ProductFilters = {
  age: 180, soldMin: 1000, reviewsMax: 300, ratingMin: 40, ratingMax: 48, priceMinCents: 999, priceMaxCents: 3000,
  bsrMin: 1, bsrMax: 50_000, ratioMax: 70, cat: LEAVES[0], fba: 'yes', amazon: 'no', sort: 'listed', dir: 'asc', page: 3,
};

function renderPanel(filters: ProductFilters = PRODUCT_DEFAULTS) {
  return render(<ProductFilterPanel filters={filters} leafCategories={LEAVES} />);
}

const control = (label: string) => screen.getByLabelText(label);
const optionTexts = (label: string) => within(control(label)).getAllByRole('option').map((o) => o.textContent);
const change = (label: string, value: string) => fireEvent.change(control(label), { target: { value } });
const applyButton = () => screen.getByRole('button', { name: /apply filters|filters applied|applying/i });

/** Types into the category typeahead and picks the option whose text contains `leaf`. */
function pickCategory(leaf: string) {
  const input = control('Add leaf category');
  fireEvent.change(input, { target: { value: leaf } });
  fireEvent.mouseDown(screen.getByRole('option', { name: new RegExp(leaf) }));
}

describe('ProductFilterPanel controls', () => {
  beforeEach(() => replace.mockClear());

  it('renders every control at PRODUCT_DEFAULTS', () => {
    renderPanel();
    expect(control('Sort')).toHaveDisplayValue('Monthly sold');
    expect(optionTexts('Sort')).toEqual(['Monthly sold', 'Listing date', 'Review count', 'Price', 'BSR', 'BSR vs 30-day avg', 'Top-3 keywords']);
    expect(control('Sort direction')).toHaveDisplayValue('Most sold first');
    expect(control('Listing age')).toHaveDisplayValue('Any');
    expect(optionTexts('Listing age')).toEqual(['Any', 'Listed within 60 days', 'Listed within 90 days', 'Listed within 180 days', 'Listed within 365 days']);
    expect(control('Monthly sold (at least)')).toHaveDisplayValue('Any');
    expect(optionTexts('Monthly sold (at least)')).toEqual(['Any', '50+', '100+', '200+', '300+', '400+', '500+', '1,000+', '2,000+', '5,000+', '10,000+']);
    for (const label of ['Reviews (at most)', 'Minimum rating', 'Maximum rating', 'Minimum price', 'Maximum price', 'Minimum BSR', 'Maximum BSR']) {
      expect(control(label), label).toHaveValue(null);
    }
    expect(control('BSR vs 30-day avg')).toHaveDisplayValue('Any');
    expect(optionTexts('BSR vs 30-day avg')).toEqual(['Any', 'At least 10% better', 'At least 30% better', 'At least 50% better']);
    expect(control('Add leaf category')).toHaveValue('');
    expect(screen.queryByRole('button', { name: /^Remove / })).not.toBeInTheDocument();
    expect(control('FBA offer')).toHaveDisplayValue('Any');
    expect(optionTexts('FBA offer')).toEqual(['Any', 'Present', 'None']);
    expect(control('Amazon selling')).toHaveDisplayValue('Any');
    expect(optionTexts('Amazon selling')).toEqual(['Any', 'Yes', 'No']);
    expect(applyButton()).toHaveTextContent('Filters applied');
    expect(applyButton()).toBeDisabled();
  });

  it('seeds every control from the applied filters (stars and dollars from the stored ×10 and cents)', () => {
    renderPanel(SEEDED);
    expect(control('Sort')).toHaveDisplayValue('Listing date');
    expect(control('Sort direction')).toHaveDisplayValue('Oldest first');
    expect(control('Listing age')).toHaveDisplayValue('Listed within 180 days');
    expect(control('Monthly sold (at least)')).toHaveDisplayValue('1,000+');
    expect(control('Reviews (at most)')).toHaveValue(300);
    expect(control('Minimum rating')).toHaveDisplayValue('4.0');
    expect(control('Maximum rating')).toHaveDisplayValue('4.8');
    expect(control('Minimum price')).toHaveDisplayValue('9.99');
    expect(control('Maximum price')).toHaveDisplayValue('30');
    expect(control('Minimum BSR')).toHaveValue(1);
    expect(control('Maximum BSR')).toHaveValue(50_000);
    expect(control('BSR vs 30-day avg')).toHaveDisplayValue('At least 30% better');
    expect(screen.getByRole('button', { name: `Remove ${LEAVES[0]}` })).toBeInTheDocument();
    expect(control('FBA offer')).toHaveDisplayValue('Present');
    expect(control('Amazon selling')).toHaveDisplayValue('No');
    expect(applyButton()).toBeDisabled();
  });

  it('a value the presets lack (from the URL) still shows as the selected option', () => {
    renderPanel({ ...PRODUCT_DEFAULTS, soldMin: 750, ratioMax: 80 });
    expect(control('Monthly sold (at least)')).toHaveDisplayValue('750+');
    expect(control('BSR vs 30-day avg')).toHaveDisplayValue('At least 20% better');
  });

  it('labels a ratio cap at or above the average as a "no worse than" bound', () => {
    const { unmount } = renderPanel({ ...PRODUCT_DEFAULTS, ratioMax: 120 });
    expect(control('BSR vs 30-day avg')).toHaveDisplayValue('At most 20% worse');
    unmount();
    renderPanel({ ...PRODUCT_DEFAULTS, ratioMax: 100 });
    expect(control('BSR vs 30-day avg')).toHaveDisplayValue('No worse than average');
  });

  it('direction labels follow the pending sort', () => {
    renderPanel();
    change('Sort', 'bsr');
    expect(optionTexts('Sort direction')).toEqual(['Worst rank first', 'Best rank first']);
    change('Sort', 'price');
    expect(optionTexts('Sort direction')).toEqual(['Highest price first', 'Lowest price first']);
  });
});

describe('ProductFilterPanel Apply / Reset', () => {
  beforeEach(() => replace.mockClear());

  it('Apply replaces the URL with productFiltersToSearchParams of the edited filters, back on page 1', () => {
    renderPanel({ ...PRODUCT_DEFAULTS, page: 4 });
    change('Listing age', '180');
    change('Monthly sold (at least)', '1000');
    change('Reviews (at most)', '300');
    change('Minimum rating', '4');
    change('Maximum rating', '4.8');
    change('Minimum price', '9.99');
    change('Maximum price', '29.99');
    change('Minimum BSR', '1');
    change('Maximum BSR', '50000');
    change('BSR vs 30-day avg', '70');
    change('FBA offer', 'yes');
    change('Amazon selling', 'no');
    change('Sort', 'listed');
    change('Sort direction', 'asc');
    expect(applyButton()).toHaveTextContent('Apply filters');
    fireEvent.click(applyButton());

    const expected: ProductFilters = {
      ...PRODUCT_DEFAULTS, age: 180, soldMin: 1000, reviewsMax: 300, ratingMin: 40, ratingMax: 48, priceMinCents: 999, priceMaxCents: 2999,
      bsrMin: 1, bsrMax: 50_000, ratioMax: 70, fba: 'yes', amazon: 'no', sort: 'listed', dir: 'asc', page: 1,
    };
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith(`/products?${productFiltersToSearchParams(expected)}`, { scroll: false });
    expect(replace).toHaveBeenCalledWith(
      '/products?age=180&soldMin=1000&reviewsMax=300&ratingMin=40&ratingMax=48&priceMin=9.99&priceMax=29.99&bsrMin=1&bsrMax=50000&ratioMax=70&fba=yes&amazon=no&sort=listed&dir=asc',
      { scroll: false },
    );
  });

  it('Apply after one edit keeps the other applied filters and drops the page', () => {
    renderPanel(SEEDED);
    change('Reviews (at most)', '150');
    fireEvent.click(applyButton());
    expect(replace).toHaveBeenCalledWith(`/products?${productFiltersToSearchParams({ ...SEEDED, reviewsMax: 150, page: 1 })}`, { scroll: false });
  });

  it('clearing every filter applies as the bare /products URL', () => {
    renderPanel({ ...PRODUCT_DEFAULTS, age: 90 });
    change('Listing age', '');
    fireEvent.click(applyButton());
    expect(replace).toHaveBeenCalledWith('/products', { scroll: false });
  });

  it('Apply is disabled until something changes, and again once the edit is undone', () => {
    renderPanel(SEEDED);
    expect(applyButton()).toBeDisabled();
    change('Minimum rating', '4.5');
    expect(applyButton()).toBeEnabled();
    change('Minimum rating', '4');
    expect(applyButton()).toBeDisabled();
  });

  it('Reset replaces the URL with /products and clears every control', () => {
    renderPanel(SEEDED);
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(replace).toHaveBeenCalledWith('/products', { scroll: false });
    expect(control('Listing age')).toHaveDisplayValue('Any');
    expect(control('Reviews (at most)')).toHaveValue(null);
    expect(control('Minimum price')).toHaveValue(null);
    expect(screen.queryByRole('button', { name: /^Remove / })).not.toBeInTheDocument();
    expect(control('Sort')).toHaveDisplayValue('Monthly sold');
    expect(control('Sort direction')).toHaveDisplayValue('Most sold first');
  });
});

describe('ProductFilterPanel category (single selection)', () => {
  beforeEach(() => replace.mockClear());

  it('a pick becomes the category, a second pick replaces it, removing the chip clears it', () => {
    renderPanel();
    pickCategory('Desk Lamps');
    expect(screen.getByRole('button', { name: `Remove ${LEAVES[0]}` })).toBeInTheDocument();
    pickCategory('Jigsaw Puzzles');
    expect(screen.getAllByRole('button', { name: /^Remove / })).toHaveLength(1);
    expect(screen.getByRole('button', { name: `Remove ${LEAVES[2]}` })).toBeInTheDocument();

    fireEvent.click(applyButton());
    expect(replace).toHaveBeenLastCalledWith(`/products?${productFiltersToSearchParams({ ...PRODUCT_DEFAULTS, cat: LEAVES[2] })}`, { scroll: false });

    fireEvent.click(screen.getByRole('button', { name: `Remove ${LEAVES[2]}` }));
    expect(screen.queryByRole('button', { name: /^Remove / })).not.toBeInTheDocument();
  });
});

describe('sort hint (sorts that hide products without the sort key)', () => {
  it('one line for exactly the sorts that hide rows', () => {
    for (const sort of PRODUCT_SORTS) {
      expect(sortHint(sort) !== null, sort).toBe(sortHidesNullKey(sort));
    }
    expect(sortHint('sold')).toBe('Products without a monthly sold badge are hidden under this sort.');
    expect(sortHint('price')).toBe('Products without a price are hidden under this sort.');
    expect(sortHint('keywords')).toBeNull();
  });

  it('shows under the sort control and follows the pending sort before Apply', () => {
    renderPanel();
    expect(screen.getByText('Products without a monthly sold badge are hidden under this sort.')).toBeInTheDocument();
    change('Sort', 'keywords');
    expect(screen.queryByText(/hidden under this sort/)).not.toBeInTheDocument();
    change('Sort', 'ratio');
    expect(screen.getByText('Products without a BSR ratio are hidden under this sort.')).toBeInTheDocument();
  });
});

describe('filtersToPending / pendingToFilters', () => {
  it('round-trip every field, with the page reset to 1', () => {
    expect(pendingToFilters(filtersToPending(SEEDED))).toEqual({ ...SEEDED, page: 1 });
    expect(pendingToFilters(filtersToPending(PRODUCT_DEFAULTS))).toEqual(PRODUCT_DEFAULTS);
  });

  it('build the ProductFilters object without validating it (the server parse is the judge)', () => {
    const p = { ...filtersToPending(PRODUCT_DEFAULTS), reviewsMax: ' 12 ', ratingMin: '4.45', priceMax: '19.999', bsrMin: 'abc' };
    expect(pendingToFilters(p)).toMatchObject({ reviewsMax: 12, ratingMin: 45, priceMaxCents: 2000, bsrMin: null });
  });
});
