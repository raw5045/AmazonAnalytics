import { describe, it, expect } from 'vitest';
import { EXPLORER_DEFAULTS } from './parseFilters';
import { resolveExplorerFilters, VIEW_OVERLAY_KEYS } from './resolveFilters';
import type { SavedView } from '@/lib/savedViews/types';

// A view whose stored sort is NOT the Explorer default, so "kept" and "defaulted" are distinguishable.
const stored = { ...EXPLORER_DEFAULTS, q: 'lamp', rankMax: 5000, sort: 'imp' as const, leafPaths: ['Home & Kitchen › Lighting › Lamps'] };
const view: SavedView = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Lamps',
  filters: stored,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

describe('resolveExplorerFilters (saved view vs URL, 2026-10-01)', () => {
  it('names exactly the keys the column headers and the pager write', () => {
    expect([...VIEW_OVERLAY_KEYS]).toEqual(['sort', 'page', 'per_page']);
  });

  it('bookmark form: the view alone → its stored filters, untouched (stored sort kept, not defaulted)', () => {
    expect(resolveExplorerFilters({ view: view.id }, view)).toEqual({ filters: stored, fromView: true });
  });

  it('a column-header sort on a view keeps the view and changes only the sort', () => {
    expect(resolveExplorerFilters({ view: view.id, sort: 'avg_reviews_desc' }, view)).toEqual({
      filters: { ...stored, sort: 'avg_reviews_desc' },
      fromView: true,
    });
  });

  it('paging a view keeps the view and changes only page / perPage', () => {
    expect(resolveExplorerFilters({ view: view.id, page: '3' }, view).filters).toEqual({ ...stored, page: 3 });
    expect(resolveExplorerFilters({ view: view.id, page: '2', per_page: '50' }, view).filters).toEqual({ ...stored, page: 2, perPage: 50 });
  });

  it('an invalid overlay value falls back the way parseExplorerFilters does, never to losing the view', () => {
    expect(resolveExplorerFilters({ view: view.id, sort: 'bogus' }, view).filters).toEqual({ ...stored, sort: EXPLORER_DEFAULTS.sort });
    expect(resolveExplorerFilters({ view: view.id, page: '0' }, view).filters).toEqual({ ...stored, page: EXPLORER_DEFAULTS.page });
  });

  it('a real filter param next to the view tag means the URL is the source of truth', () => {
    const r = resolveExplorerFilters({ view: view.id, sort: 'imp', q: 'desk' }, view);
    expect(r.fromView).toBe(false);
    expect(r.filters).toEqual({ ...EXPLORER_DEFAULTS, sort: 'imp', q: 'desk' });
  });

  it('without a loaded view the URL is parsed as before', () => {
    expect(resolveExplorerFilters({ sort: 'imp' }, null)).toEqual({ filters: { ...EXPLORER_DEFAULTS, sort: 'imp' }, fromView: false });
    expect(resolveExplorerFilters({ view: view.id, sort: 'imp' }, null).fromView).toBe(false);
  });

  it('ignores undefined params (Next passes them for absent keys) and array-valued ones take the first value', () => {
    expect(resolveExplorerFilters({ view: view.id, sort: undefined }, view)).toEqual({ filters: stored, fromView: true });
    expect(resolveExplorerFilters({ view: view.id, page: ['2', '9'] }, view).filters.page).toBe(2);
  });
});
