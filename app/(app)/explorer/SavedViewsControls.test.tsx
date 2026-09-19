import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { EXPLORER_DEFAULTS } from '@/lib/explorer/parseFilters';
import type { SavedView } from '@/lib/savedViews/types';
import { SavedViewsControls } from './SavedViewsControls';

// A stateful router mock: push() updates the search params the components
// read on their next render, exactly as a real client-side navigation does —
// and, exactly as in the real App Router, it does NOT change the `views` prop
// the layout passed in (that only happens after router.refresh() lands).
const nav = vi.hoisted(() => {
  const state = { params: new URLSearchParams(), pathname: '/explorer' };
  return {
    state,
    push: vi.fn((href: string) => {
      const u = new URL(href, 'http://localhost');
      state.params = u.searchParams;
      state.pathname = u.pathname;
    }),
    refresh: vi.fn(),
  };
});
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: nav.push, refresh: nav.refresh }),
  usePathname: () => nav.state.pathname,
  useSearchParams: () => nav.state.params,
}));

const VIEW_ID = '11111111-1111-4111-8111-111111111111';
const savedView = (over: Partial<SavedView> = {}): SavedView => ({
  id: VIEW_ID,
  name: 'Lamps under 500',
  filters: EXPLORER_DEFAULTS,
  createdAt: '2026-09-18T00:00:00.000Z',
  updatedAt: '2026-09-18T00:00:00.000Z',
  ...over,
});

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status < 300, status, statusText: 'x', json: async () => body } as unknown as Response;
}

async function saveThroughModal(name: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Save view' }));
  const input = screen.getByLabelText('Name');
  fireEvent.change(input, { target: { value: name } });
  fireEvent.submit(input.closest('form')!);
  await waitFor(() => expect(screen.queryByLabelText('Name')).toBeNull());
}

describe('SavedViewsControls', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    nav.state.params = new URLSearchParams();
    nav.state.pathname = '/explorer';
  });
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('shows the new view as the active selection the moment it is saved, before the layout re-fetches', async () => {
    const view = savedView();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { view }));
    render(<SavedViewsControls views={[]} />);
    expect(screen.getByTitle('Pick a saved view')).toBeInTheDocument();

    await saveThroughModal('Lamps under 500');

    expect(nav.push).toHaveBeenCalledWith(`/explorer?view=${VIEW_ID}`);
    expect(nav.refresh).toHaveBeenCalled();
    // The `views` prop is still [] (the layout has not re-fetched), yet the
    // picker already reads the saved name and marks it active.
    expect(screen.getByTitle('Currently loaded: Lamps under 500')).toHaveTextContent('Lamps under 500');
    fireEvent.click(screen.getByTitle('Currently loaded: Lamps under 500'));
    const list = screen.getByRole('listbox');
    expect(within(list).getByText('Lamps under 500')).toBeInTheDocument();
    expect(within(list).getByText('✓')).toBeInTheDocument();
  });

  it('marks the saved view active BEFORE its navigation commits (URL still without the id)', async () => {
    nav.push.mockImplementationOnce(() => {}); // the page fetch is still in flight
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { view: savedView() }));
    render(<SavedViewsControls views={[]} />);
    await saveThroughModal('Lamps under 500');
    expect(nav.state.params.get('view')).toBeNull();
    expect(screen.getByTitle('Currently loaded: Lamps under 500')).toBeInTheDocument();
  });

  it('reads as active from a filtered URL and from a loaded view until the URL moves', async () => {
    nav.state.params = new URLSearchParams('vol_min=10000');
    nav.push.mockImplementationOnce(() => {});
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { view: savedView() }));
    const first = render(<SavedViewsControls views={[]} />);
    await saveThroughModal('Lamps under 500');
    expect(screen.getByTitle('Currently loaded: Lamps under 500')).toBeInTheDocument();
    first.unmount();

    const other = savedView({ id: '22222222-1111-4111-8111-111111111111', name: 'Other view' });
    nav.state.params = new URLSearchParams(`view=${other.id}`);
    nav.push.mockImplementationOnce(() => {});
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { view: savedView({ id: '44444444-1111-4111-8111-111111111111', name: 'Newest' }) }));
    render(<SavedViewsControls views={[other]} />);
    await saveThroughModal('Newest');
    expect(screen.getByTitle('Currently loaded: Newest')).toBeInTheDocument();
  });

  it('ends the active bridge once the URL moves, and it does not come back on returning to that URL', async () => {
    nav.push.mockImplementationOnce(() => {});
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { view: savedView() }));
    const { rerender } = render(<SavedViewsControls views={[]} />);
    await saveThroughModal('Lamps under 500');
    expect(screen.getByTitle('Currently loaded: Lamps under 500')).toBeInTheDocument();

    // The user applies filters (URL gains params, no view tag): URL-truth wins.
    nav.state.params = new URLSearchParams('vol_min=5000');
    rerender(<SavedViewsControls views={[]} />);
    expect(screen.getByTitle('Pick a saved view')).toBeInTheDocument();

    // Back to the exact URL of the save (e.g. Reset filters): still not active.
    nav.state.params = new URLSearchParams();
    rerender(<SavedViewsControls views={[]} />);
    expect(screen.getByTitle('Pick a saved view')).toBeInTheDocument();
    // ...but the view itself is still listed (the overlay outlives the bridge).
    fireEvent.click(screen.getByTitle('Pick a saved view'));
    expect(within(screen.getByRole('listbox')).getByText('Lamps under 500')).toBeInTheDocument();
  });

  it('keeps a single entry once the layout catches up with the same view', async () => {
    const view = savedView();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { view }));
    const { rerender } = render(<SavedViewsControls views={[]} />);
    await saveThroughModal('Lamps under 500');

    rerender(<SavedViewsControls views={[view]} />);
    fireEvent.click(screen.getByTitle('Currently loaded: Lamps under 500'));
    expect(within(screen.getByRole('listbox')).getAllByText('Lamps under 500')).toHaveLength(1);
  });

  it('drops an optimistic view once the server list changes without it (e.g. deleted in another tab)', async () => {
    const view = savedView();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { view }));
    const { rerender } = render(<SavedViewsControls views={[]} />);
    await saveThroughModal('Lamps under 500');
    expect(screen.getByTitle('Currently loaded: Lamps under 500')).toBeInTheDocument();

    const other = savedView({ id: '22222222-1111-4111-8111-111111111111', name: 'Other view' });
    rerender(<SavedViewsControls views={[other]} />);
    expect(screen.getByTitle('Pick a saved view')).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Pick a saved view'));
    const list = screen.getByRole('listbox');
    expect(within(list).queryByText('Lamps under 500')).toBeNull();
    expect(within(list).getByText('Other view')).toBeInTheDocument();
  });

  it('keeps the optimistic view while the server list is unchanged (a discarded refresh)', async () => {
    const view = savedView();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { view }));
    const { rerender } = render(<SavedViewsControls views={[]} />);
    await saveThroughModal('Lamps under 500');

    rerender(<SavedViewsControls views={[]} />);
    expect(screen.getByTitle('Currently loaded: Lamps under 500')).toBeInTheDocument();
  });

  it('does not remount (and so does not close an open picker) when the refreshed list lands', async () => {
    const view = savedView();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { view }));
    const { rerender } = render(<SavedViewsControls views={[]} />);
    await saveThroughModal('Lamps under 500');
    fireEvent.click(screen.getByTitle('Currently loaded: Lamps under 500'));
    expect(screen.getByRole('listbox')).toBeInTheDocument();

    rerender(<SavedViewsControls views={[view]} />);
    // A keyed remount would reset the dropdown's open state here.
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(within(screen.getByRole('listbox')).getAllByText('Lamps under 500')).toHaveLength(1);
  });

  it('drops an optimistic view that is deleted before the layout catches up', async () => {
    const view = savedView();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { view }));
    vi.stubGlobal('confirm', () => true);
    render(<SavedViewsControls views={[]} />);
    await saveThroughModal('Lamps under 500');

    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
    fireEvent.click(screen.getByTitle('Currently loaded: Lamps under 500'));
    fireEvent.click(screen.getByRole('button', { name: 'Options for Lamps under 500' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(nav.push).toHaveBeenLastCalledWith('/explorer'));

    expect(screen.getByTitle('Pick a saved view')).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Pick a saved view'));
    expect(within(screen.getByRole('listbox')).queryByText('Lamps under 500')).toBeNull();
  });

  it('refreshes the layout when the ACTIVE view is deleted, so the list cannot keep a ghost', async () => {
    const view = savedView();
    nav.state.params = new URLSearchParams(`view=${VIEW_ID}`);
    vi.stubGlobal('confirm', () => true);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
    render(<SavedViewsControls views={[view]} />);

    fireEvent.click(screen.getByTitle('Currently loaded: Lamps under 500'));
    fireEvent.click(screen.getByRole('button', { name: 'Options for Lamps under 500' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(nav.push).toHaveBeenLastCalledWith('/explorer'));
    expect(nav.refresh).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenLastCalledWith(`/api/explorer/saved-views/${VIEW_ID}`, { method: 'DELETE' });
  });

  it('renames the optimistic entry in place before the layout catches up', async () => {
    const view = savedView();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { view }));
    render(<SavedViewsControls views={[]} />);
    await saveThroughModal('Lamps under 500');

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { view: { ...view, name: 'Lamps v2' } }));
    fireEvent.click(screen.getByTitle('Currently loaded: Lamps under 500'));
    fireEvent.click(screen.getByRole('button', { name: 'Options for Lamps under 500' }));
    fireEvent.click(screen.getByRole('button', { name: 'Rename…' }));
    const input = screen.getByLabelText('Name');
    fireEvent.change(input, { target: { value: 'Lamps v2' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(screen.queryByLabelText('Name')).toBeNull());

    expect(screen.getByTitle('Currently loaded: Lamps v2')).toBeInTheDocument();
    expect(nav.refresh).toHaveBeenCalledTimes(2);
  });

  it("saves the LOADED view's filters when the URL is the bookmark form, never the defaults", async () => {
    const loaded = savedView({
      id: '33333333-1111-4111-8111-111111111111',
      name: 'Loaded',
      filters: { ...EXPLORER_DEFAULTS, volMin: 25_000, reviewsMax: 250 },
    });
    nav.state.params = new URLSearchParams(`view=${loaded.id}`);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { view: savedView({ name: 'Copy', filters: loaded.filters }) }));
    render(<SavedViewsControls views={[loaded]} />);
    await saveThroughModal('Copy');

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.filters.volMin).toBe(25_000);
    expect(body.filters.reviewsMax).toBe(250);
  });

  it('keeps the URL as the source when it carries filters, preserving repeated leaf params', async () => {
    nav.state.params = new URLSearchParams('leaf=Home+%E2%80%BA+Lamps&leaf=Home+%E2%80%BA+Bulbs&vol_min=10000');
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { view: savedView() }));
    render(<SavedViewsControls views={[]} />);
    await saveThroughModal('Lamps under 500');

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.filters.leafPaths).toEqual(['Home › Lamps', 'Home › Bulbs']);
    expect(body.filters.volMin).toBe(10_000);
  });

  it('counts the optimistic view toward the per-user limit', async () => {
    const existing = [1, 2, 3, 4].map((n) => savedView({ id: `0000000${n}-1111-4111-8111-111111111111`, name: `View ${n}` }));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { view: savedView() }));
    render(<SavedViewsControls views={existing} />);
    expect(screen.getByRole('button', { name: 'Save view' })).toBeEnabled();

    await saveThroughModal('Lamps under 500');
    const button = screen.getByRole('button', { name: 'Save view' });
    expect(button).toBeDisabled();
    // A visible note, not just the hover tooltip, tells the user why Save is off.
    const note = screen.getByText('5 of 5 views saved — delete one to save another.');
    expect(button).toHaveAttribute('aria-describedby', note.id);
  });

  it('shows no cap note below the limit', () => {
    render(<SavedViewsControls views={[savedView()]} />);
    expect(screen.queryByText(/views saved/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Save view' })).toBeEnabled();
  });
});
