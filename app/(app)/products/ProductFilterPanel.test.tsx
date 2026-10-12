import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { PRODUCT_DEFAULTS, PRODUCT_SORTS, productFiltersToSearchParams, sortHidesNullKey, type ProductFilters } from '@/lib/products/filterParams';
import { ProductFilterPanel, SORT_DIR_LABEL, SORT_FIRST_DIR, filtersToPending, pendingToFilters, sortHint } from './ProductFilterPanel';

const { replace } = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }));

const LEAVES = [
  'Home & Kitchen › Lighting › Desk Lamps',
  'Home & Kitchen › Lighting › Floor Lamps',
  'Toys & Games › Puzzles › Jigsaw Puzzles',
];
const DEPARTMENTS = ['Home & Kitchen', 'Pet Supplies', 'Toys & Games'];
const BROAD = ['Apparel', 'Home', 'Pet Supplies'];
const CUSTOM = [
  { id: '11111111-1111-4111-8111-000000000001', name: 'Lamps', leafPaths: [LEAVES[0], LEAVES[1]] },
  { id: '22222222-2222-4222-8222-000000000002', name: 'Puzzles & lamps', leafPaths: [LEAVES[1], LEAVES[2]] },
];

/** Every filter set to a non-default value, on page 3 (leaf mode: picks, no custom ids). */
const SEEDED: ProductFilters = {
  age: 180, soldMin: 1000, reviewsMax: 300, ratingMin: 40, ratingMax: 48, priceMinCents: 999, priceMaxCents: 3000,
  bsrMin: 1, bsrMax: 50_000, ratioMax: 70, dept: 'Home & Kitchen', broadCategory: 'Home', leafPaths: [LEAVES[0]], customCategoryIds: [], fba: 'yes', amazon: 'no', sort: 'listed', dir: 'asc', page: 3,
};

function renderPanel(filters: ProductFilters = PRODUCT_DEFAULTS, customCategories = CUSTOM) {
  return render(<ProductFilterPanel filters={filters} departments={DEPARTMENTS} broadCategories={BROAD} leafCategories={LEAVES} customCategories={customCategories} />);
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
    expect(optionTexts('Monthly sold (at least)')).toEqual([
      'Any', '50+', '100+', '200+', '300+', '400+', '500+', '1,000+', '2,000+', '5,000+', '10,000+', '20,000+', '50,000+', '100,000+',
    ]);
    for (const label of ['Reviews (at most)', 'Minimum rating', 'Maximum rating', 'Minimum price', 'Maximum price', 'Minimum BSR', 'Maximum BSR']) {
      expect(control(label), label).toHaveValue(null);
    }
    expect(control('BSR vs 30-day avg')).toHaveDisplayValue('Any');
    expect(optionTexts('BSR vs 30-day avg')).toEqual(['Any', 'At least 10% better', 'At least 30% better', 'At least 50% better']);
    expect(control('Department')).toHaveDisplayValue('All departments');
    expect(optionTexts('Department')).toEqual(['All departments', ...DEPARTMENTS]);
    expect(control('Broad category')).toHaveDisplayValue('All broad categories');
    expect(optionTexts('Broad category')).toEqual(['All broad categories', ...BROAD]);
    expect(screen.getByRole('button', { name: 'Leaf' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Custom' })).toHaveAttribute('aria-pressed', 'false');
    expect(within(screen.getByRole('group', { name: 'Leaf categories' })).getByLabelText('Add leaf category')).toBeInTheDocument();
    expect(screen.getByText(/3 categories — type to search/)).toBeInTheDocument();
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
    expect(control('Department')).toHaveDisplayValue('Home & Kitchen');
    expect(control('Broad category')).toHaveDisplayValue('Home');
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

  it("picking a sort opens it at that sort's first direction (BSR on the best rank, as its header does)", () => {
    renderPanel({ ...PRODUCT_DEFAULTS, sort: 'price', dir: 'desc' });
    change('Sort', 'bsr');
    expect(control('Sort direction')).toHaveDisplayValue('Best rank first');
    for (const sort of PRODUCT_SORTS) {
      change('Sort', sort);
      expect(control('Sort direction'), sort).toHaveDisplayValue(SORT_DIR_LABEL[sort][SORT_FIRST_DIR[sort]]);
    }
    expect(SORT_FIRST_DIR).toEqual({ sold: 'desc', listed: 'desc', reviews: 'asc', price: 'asc', bsr: 'asc', ratio: 'asc', keywords: 'desc' });
  });

  it('a direction picked after the sort is kept, and Apply sends both', () => {
    renderPanel();
    change('Sort', 'bsr');
    fireEvent.click(applyButton());
    expect(replace).toHaveBeenLastCalledWith('/products?sort=bsr&dir=asc', { scroll: false });
    change('Sort direction', 'desc');
    fireEvent.click(applyButton());
    expect(replace).toHaveBeenLastCalledWith('/products?sort=bsr', { scroll: false });
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
    expect(control('Department')).toHaveDisplayValue('All departments');
    expect(control('Broad category')).toHaveDisplayValue('All broad categories');
    expect(screen.queryByRole('button', { name: /^Remove / })).not.toBeInTheDocument();
    expect(control('Sort')).toHaveDisplayValue('Monthly sold');
    expect(control('Sort direction')).toHaveDisplayValue('Most sold first');
  });
});

describe('ProductFilterPanel categories (spec 2026-10-12 §5.1)', () => {
  beforeEach(() => replace.mockClear());

  it('leaf picks accumulate as chips and apply as repeated leaf params, with the department', () => {
    renderPanel();
    change('Department', 'Home & Kitchen');
    pickCategory('Desk Lamps');
    pickCategory('Jigsaw Puzzles');
    expect(screen.getAllByRole('button', { name: /^Remove / })).toHaveLength(2);
    fireEvent.click(applyButton());
    expect(replace).toHaveBeenLastCalledWith(
      `/products?${productFiltersToSearchParams({ ...PRODUCT_DEFAULTS, dept: 'Home & Kitchen', leafPaths: [LEAVES[0], LEAVES[2]] })}`,
      { scroll: false },
    );
    fireEvent.click(screen.getByRole('button', { name: `Remove ${LEAVES[0]}` }));
    expect(screen.getAllByRole('button', { name: /^Remove / })).toHaveLength(1);
  });

  it('a department the list lacks (from the URL) still shows as the selected option', () => {
    renderPanel({ ...PRODUCT_DEFAULTS, dept: 'Appliances' });
    expect(control('Department')).toHaveDisplayValue('Appliances');
    expect(optionTexts('Department')).toEqual(['All departments', ...DEPARTMENTS, 'Appliances']);
  });

  it('seeds the Broad category select from the applied filters (spec 2026-10-12 broad category §7)', () => {
    renderPanel({ ...PRODUCT_DEFAULTS, broadCategory: 'Home' });
    expect(control('Broad category')).toHaveDisplayValue('Home');
  });

  it('a broad category the list lacks (from the URL) still shows as the selected option', () => {
    renderPanel({ ...PRODUCT_DEFAULTS, broadCategory: 'Ebook' });
    expect(control('Broad category')).toHaveDisplayValue('Ebook');
    expect(optionTexts('Broad category')).toEqual(['All broad categories', ...BROAD, 'Ebook']);
  });

  it('picking a broad category dirties the form and Apply writes broad= beside dept=', () => {
    renderPanel({ ...PRODUCT_DEFAULTS, dept: 'Pet Supplies' });
    expect(applyButton()).toBeDisabled();
    change('Broad category', 'Home');
    expect(applyButton()).toBeEnabled();
    fireEvent.click(applyButton());
    expect(replace).toHaveBeenLastCalledWith('/products?dept=Pet+Supplies&broad=Home', { scroll: false });
  });

  it('Reset clears the broad category with everything else', () => {
    renderPanel({ ...PRODUCT_DEFAULTS, broadCategory: 'Home' });
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(control('Broad category')).toHaveDisplayValue('All broad categories');
    expect(replace).toHaveBeenLastCalledWith('/products', { scroll: false });
  });

  it('Custom mode lists the custom categories with their leaf counts; checked ones apply as the custom param and drop the leaf picks', () => {
    renderPanel(SEEDED);
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    expect(screen.getByRole('button', { name: 'Custom' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByLabelText('Add leaf category')).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Lamps (2)' })).not.toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Lamps (2)' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Puzzles & lamps (2)' }));
    expect(screen.getByText('2 selected → 3 leaves')).toBeInTheDocument();
    fireEvent.click(applyButton());
    expect(replace).toHaveBeenLastCalledWith(
      `/products?${productFiltersToSearchParams({ ...SEEDED, leafPaths: [], customCategoryIds: [CUSTOM[0].id, CUSTOM[1].id], page: 1 })}`,
      { scroll: false },
    );
  });

  it('opens in Custom mode when the applied filters carry custom ids, with those boxes checked', () => {
    renderPanel({ ...PRODUCT_DEFAULTS, customCategoryIds: [CUSTOM[1].id] });
    expect(screen.getByRole('button', { name: 'Custom' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('checkbox', { name: 'Puzzles & lamps (2)' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Lamps (2)' })).not.toBeChecked();
    expect(screen.getByText('1 selected → 2 leaves')).toBeInTheDocument();
    expect(applyButton()).toBeDisabled();
  });

  it('switching back to Leaf mode applies the picks and drops the custom ids', () => {
    renderPanel({ ...PRODUCT_DEFAULTS, customCategoryIds: [CUSTOM[0].id] });
    fireEvent.click(screen.getByRole('button', { name: 'Leaf' }));
    pickCategory('Floor Lamps');
    fireEvent.click(applyButton());
    expect(replace).toHaveBeenLastCalledWith(`/products?${productFiltersToSearchParams({ ...PRODUCT_DEFAULTS, leafPaths: [LEAVES[1]] })}`, { scroll: false });
  });

  it('says where to build one when the account has no custom categories', () => {
    renderPanel(PRODUCT_DEFAULTS, []);
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    expect(screen.getByText(/No custom categories yet — build one in the Category Builder tab/)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('a department + leaf URL is not dirty on load, and its picks show as chips', () => {
    renderPanel({ ...PRODUCT_DEFAULTS, dept: 'Pet Supplies', leafPaths: [LEAVES[0], LEAVES[2]] });
    expect(control('Department')).toHaveDisplayValue('Pet Supplies');
    expect(screen.getAllByRole('button', { name: /^Remove / })).toHaveLength(2);
    expect(applyButton()).toBeDisabled();
  });

  it('Custom mode with no box checked applies neither leaf picks nor custom ids', () => {
    renderPanel({ ...PRODUCT_DEFAULTS, dept: 'Pet Supplies', leafPaths: [LEAVES[0]] });
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    expect(applyButton()).toBeEnabled();
    fireEvent.click(applyButton());
    expect(replace).toHaveBeenLastCalledWith('/products?dept=Pet+Supplies', { scroll: false });
  });

  it('unchecking a box drops that custom id and keeps the others', () => {
    renderPanel({ ...PRODUCT_DEFAULTS, customCategoryIds: [CUSTOM[0].id, CUSTOM[1].id] });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Lamps (2)' }));
    expect(screen.getByRole('checkbox', { name: 'Lamps (2)' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Puzzles & lamps (2)' })).toBeChecked();
    expect(screen.getByText('1 selected → 2 leaves')).toBeInTheDocument();
    fireEvent.click(applyButton());
    expect(replace).toHaveBeenLastCalledWith(`/products?${productFiltersToSearchParams({ ...PRODUCT_DEFAULTS, customCategoryIds: [CUSTOM[1].id] })}`, { scroll: false });
  });

  it('Leaf → Custom → Leaf without Apply keeps the chips and is no change', () => {
    renderPanel({ ...PRODUCT_DEFAULTS, leafPaths: [LEAVES[0], LEAVES[2]] });
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    expect(applyButton()).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Leaf' }));
    expect(screen.getAllByRole('button', { name: /^Remove / })).toHaveLength(2);
    expect(applyButton()).toBeDisabled();
  });

  it('Reset from Custom mode returns to Leaf mode', () => {
    renderPanel({ ...PRODUCT_DEFAULTS, customCategoryIds: [CUSTOM[0].id] });
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(screen.getByRole('button', { name: 'Leaf' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Custom' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('the dirty check ignores the order of the custom ids: unchecking and re-checking a box is no change', () => {
    renderPanel({ ...PRODUCT_DEFAULTS, customCategoryIds: [CUSTOM[0].id, CUSTOM[1].id] });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Lamps (2)' }));
    expect(applyButton()).toBeEnabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Lamps (2)' }));
    expect(applyButton()).toBeDisabled();
  });

  it('the dirty check ignores the order of the leaf picks, while Apply keeps the order they were picked in', () => {
    const applied: ProductFilters = { ...PRODUCT_DEFAULTS, leafPaths: [LEAVES[0], LEAVES[1]] };
    renderPanel(applied);
    fireEvent.click(screen.getByRole('button', { name: `Remove ${LEAVES[0]}` }));
    expect(applyButton()).toBeEnabled();
    pickCategory('Desk Lamps');
    expect(applyButton()).toBeDisabled();
    change('Listing age', '90');
    fireEvent.click(applyButton());
    expect(replace).toHaveBeenLastCalledWith(`/products?${productFiltersToSearchParams({ ...applied, age: 90, leafPaths: [LEAVES[1], LEAVES[0]] })}`, { scroll: false });
  });
});

describe('ProductFilterPanel custom ids with no custom category behind them', () => {
  beforeEach(() => replace.mockClear());
  /** Not one of CUSTOM's ids: deleted since, or never this user's. */
  const MISSING = ['33333333-3333-4333-8333-000000000003', '44444444-4444-4444-8444-000000000004'];

  it('are called out under the list, and Clear drops them, so Apply would too', () => {
    renderPanel({ ...PRODUCT_DEFAULTS, customCategoryIds: [MISSING[0]] });
    expect(screen.getByText('1 selected custom category no longer exists and matches nothing.')).toBeInTheDocument();
    expect(applyButton()).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Clear missing custom categories' }));
    expect(screen.queryByText(/no longer exist/)).not.toBeInTheDocument();
    expect(applyButton()).toBeEnabled();
    fireEvent.click(applyButton());
    expect(replace).toHaveBeenLastCalledWith('/products', { scroll: false });
  });

  it('are called out under the empty state too, when the account has no custom categories at all', () => {
    renderPanel({ ...PRODUCT_DEFAULTS, customCategoryIds: [MISSING[0]] }, []);
    expect(screen.getByText(/No custom categories yet — build one in the Category Builder tab/)).toBeInTheDocument();
    expect(screen.getByText('1 selected custom category no longer exists and matches nothing.')).toBeInTheDocument();
    expect(applyButton()).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Clear missing custom categories' }));
    expect(screen.queryByText(/no longer exist/)).not.toBeInTheDocument();
    expect(screen.getByText(/No custom categories yet/)).toBeInTheDocument();
    expect(applyButton()).toBeEnabled();
  });

  it('are counted in the plural, and Clear keeps the selected ones that still exist', () => {
    renderPanel({ ...PRODUCT_DEFAULTS, customCategoryIds: [CUSTOM[0].id, ...MISSING] });
    expect(screen.getByText('2 selected custom categories no longer exist and match nothing.')).toBeInTheDocument();
    expect(screen.getByText('1 selected → 2 leaves')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear missing custom categories' }));
    expect(screen.getByRole('checkbox', { name: 'Lamps (2)' })).toBeChecked();
    fireEvent.click(applyButton());
    expect(replace).toHaveBeenLastCalledWith(`/products?${productFiltersToSearchParams({ ...PRODUCT_DEFAULTS, customCategoryIds: [CUSTOM[0].id] })}`, { scroll: false });
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

  it('derives the mode from the applied filters, and the active mode wins on the way back (custom ids drop leaf picks and vice versa)', () => {
    expect(filtersToPending(SEEDED).leafMode).toBe('leaf');
    expect(filtersToPending({ ...PRODUCT_DEFAULTS, customCategoryIds: [CUSTOM[0].id] }).leafMode).toBe('custom');
    const hybrid = { ...PRODUCT_DEFAULTS, leafPaths: [LEAVES[0]], customCategoryIds: [CUSTOM[0].id] };
    expect(pendingToFilters(filtersToPending(hybrid))).toEqual({ ...PRODUCT_DEFAULTS, customCategoryIds: [CUSTOM[0].id] });
    expect(pendingToFilters({ ...filtersToPending(hybrid), leafMode: 'leaf' })).toEqual({ ...PRODUCT_DEFAULTS, leafPaths: [LEAVES[0]] });
    const tools = filtersToPending({ ...PRODUCT_DEFAULTS, dept: 'Tools' });
    expect(pendingToFilters(tools).dept).toBe('Tools');
    expect(pendingToFilters({ ...tools, dept: '' }).dept).toBeNull();
    const home = filtersToPending({ ...PRODUCT_DEFAULTS, broadCategory: 'Home' });
    expect(home.broad).toBe('Home');
    expect(pendingToFilters(home).broadCategory).toBe('Home');
    expect(pendingToFilters({ ...home, broad: '' }).broadCategory).toBeNull();
  });

  // PRODUCT_DEFAULTS' arrays are shared (Object.freeze is shallow); the pending state must never alias them.
  it('copies the array fields, so editing the pending state can never touch the applied filters or the defaults', () => {
    const p = filtersToPending(PRODUCT_DEFAULTS);
    expect(p.leafPaths).not.toBe(PRODUCT_DEFAULTS.leafPaths);
    expect(p.customCategoryIds).not.toBe(PRODUCT_DEFAULTS.customCategoryIds);
    const q = filtersToPending(SEEDED);
    expect(q.leafPaths).toEqual(SEEDED.leafPaths);
    expect(q.leafPaths).not.toBe(SEEDED.leafPaths);
  });
});
