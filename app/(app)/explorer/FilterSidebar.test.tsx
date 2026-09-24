import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { EXPLORER_DEFAULTS } from '@/lib/explorer/parseFilters';
import { FilterSidebar, filtersToPending, pendingToParams, sortHint } from './FilterSidebar';
import { sortHidesRows } from '@/lib/explorer/sortRules';
import type { SortKey } from '@/lib/explorer/types';

const { replace } = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }));

/** The Rank | Volume toggle on the range card (the Movement card has its own Rank/Volume pair). */
function rangeToggle() {
  return within(screen.getByRole('group', { name: 'Range metric' }));
}

describe('FilterSidebar range metric toggle', () => {
  beforeEach(() => {
    replace.mockClear();
  });

  it('derives the Volume tab when a volume bound is set, Rank otherwise', () => {
    expect(filtersToPending(EXPLORER_DEFAULTS).rangeMetric).toBe('rank');
    expect(filtersToPending({ ...EXPLORER_DEFAULTS, volMin: 10_000 }).rangeMetric).toBe('volume');
    expect(filtersToPending({ ...EXPLORER_DEFAULTS, volMax: 0 }).rangeMetric).toBe('volume');
    expect(filtersToPending({ ...EXPLORER_DEFAULTS, rankMax: 1000 }).rangeMetric).toBe('rank');
  });

  it('emits vol_min / vol_max from pending state and nothing for the rank pair', () => {
    const params = pendingToParams(filtersToPending({ ...EXPLORER_DEFAULTS, volMin: 10_000, volMax: 250_000 }));
    expect(params.get('vol_min')).toBe('10000');
    expect(params.get('vol_max')).toBe('250000');
    expect(params.has('rank_min')).toBe(false);
    expect(params.has('rank_max')).toBe(false);
  });

  it('opens on the Volume tab and switching to Rank clears the volume bound before Apply', () => {
    render(<FilterSidebar filters={{ ...EXPLORER_DEFAULTS, volMin: 10_000 }} categories={[]} leafCategories={[]} />);
    expect(rangeToggle().getByRole('button', { name: 'Volume' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Minimum search volume')).toHaveValue(10_000);

    fireEvent.click(rangeToggle().getByRole('button', { name: 'Rank' }));
    expect(screen.queryByLabelText('Minimum search volume')).toBeNull();
    expect(screen.getByLabelText('Best rank')).toHaveValue(null);

    fireEvent.click(screen.getByRole('button', { name: /apply filters/i }));
    expect(replace).toHaveBeenLastCalledWith('/explorer', { scroll: false });
  });

  it('switching to Volume clears the rank bounds and Apply emits only the volume params', () => {
    render(<FilterSidebar filters={{ ...EXPLORER_DEFAULTS, rankMax: 1000 }} categories={[]} leafCategories={[]} />);
    expect(rangeToggle().getByRole('button', { name: 'Rank' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(rangeToggle().getByRole('button', { name: 'Volume' }));
    fireEvent.change(screen.getByLabelText('Minimum search volume'), { target: { value: '10000' } });
    fireEvent.click(screen.getByRole('button', { name: /apply filters/i }));
    expect(replace).toHaveBeenLastCalledWith('/explorer?vol_min=10000', { scroll: false });
  });

  it('emits vol_max=0 (the string "0" is truthy, so the bound survives)', () => {
    const params = pendingToParams(filtersToPending({ ...EXPLORER_DEFAULTS, volMax: 0 }));
    expect(params.get('vol_max')).toBe('0');
  });

  it('keeps both pairs when a URL carries both, and opens on the Volume tab', () => {
    const pending = filtersToPending({ ...EXPLORER_DEFAULTS, rankMax: 1000, volMin: 10_000 });
    expect(pending.rangeMetric).toBe('volume');
    const params = pendingToParams(pending);
    expect(params.get('rank_max')).toBe('1000');
    expect(params.get('vol_min')).toBe('10000');
  });

  it('flips the card label with the metric', () => {
    render(<FilterSidebar filters={EXPLORER_DEFAULTS} categories={[]} leafCategories={[]} />);
    expect(screen.getByText('Rank range (1 = best)')).toBeInTheDocument();
    fireEvent.click(rangeToggle().getByRole('button', { name: 'Volume' }));
    expect(screen.getByText('Search volume range (est. monthly)')).toBeInTheDocument();
    expect(screen.queryByText('Rank range (1 = best)')).toBeNull();
  });

  it('does not count a bare metric switch as a change to apply', () => {
    render(<FilterSidebar filters={EXPLORER_DEFAULTS} categories={[]} leafCategories={[]} />);
    fireEvent.click(rangeToggle().getByRole('button', { name: 'Volume' }));
    expect(screen.getByRole('button', { name: /filters applied/i })).toBeDisabled();
  });
});

describe('FilterSidebar sort hint (sorts that hide rows without a sort key)', () => {
  it('explains the null-key exclusion under an avg sort and says nothing under rank', () => {
    const { unmount } = render(
      <FilterSidebar filters={{ ...EXPLORER_DEFAULTS, sort: 'avg_reviews_desc' }} categories={[]} leafCategories={[]} />,
    );
    expect(screen.getByText(/no average review count .*hidden under this sort/i)).toBeInTheDocument();
    unmount();
    render(<FilterSidebar filters={EXPLORER_DEFAULTS} categories={[]} leafCategories={[]} />);
    expect(screen.queryByText(/hidden under this sort/i)).not.toBeInTheDocument();
  });

  it('follows the pending sort before Apply, including the volume-movement sorts', () => {
    render(<FilterSidebar filters={EXPLORER_DEFAULTS} categories={[]} leafCategories={[]} />);
    const select = screen.getByDisplayValue('Best current rank');
    fireEvent.change(select, { target: { value: 'avg_price_asc' } });
    expect(screen.getByText(/no average price .*hidden under this sort/i)).toBeInTheDocument();
    fireEvent.change(select, { target: { value: 'imp' } });
    expect(screen.getByText(/volume can't be estimated .*hidden under this sort/i)).toBeInTheDocument();
    fireEvent.change(select, { target: { value: 'rank_desc' } });
    expect(screen.queryByText(/hidden under this sort/i)).not.toBeInTheDocument();
  });
});

/** Exhaustive by construction: adding a SortKey without listing it here is a type error. */
const ALL_SORTS: Record<SortKey, true> = {
  rank: true,
  rank_desc: true,
  imp: true,
  decline: true,
  title_gap: true,
  avg_price_asc: true,
  avg_price_desc: true,
  avg_reviews_asc: true,
  avg_reviews_desc: true,
  added_asc: true,
  added_desc: true,
};

describe('sortHint', () => {
  it('shows a hint for exactly the sorts that hide rows server-side', () => {
    for (const sort of Object.keys(ALL_SORTS) as SortKey[]) {
      expect(sortHint(sort) !== null, `${sort} should ${sortHidesRows(sort) ? '' : 'not '}have a hint`).toBe(sortHidesRows(sort));
    }
  });
});
