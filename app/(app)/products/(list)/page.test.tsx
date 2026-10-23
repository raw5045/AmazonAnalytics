import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { EMPTY_CATEGORY_SCOPE } from '@/lib/products/categoryPredicate';
import { PRODUCT_DEFAULTS, productFiltersToSearchParams, type ProductFilters } from '@/lib/products/filterParams';
import type { ProductSearchResult, SqlRunner } from '@/lib/products/searchProducts';

vi.mock('@/lib/env', () => ({ env: { DATABASE_URL: 'postgres://test' } }));
// The page builds its runner from neon(); the search is mocked, so no statement ever runs.
const neonMock = vi.hoisted(() => ({ neon: vi.fn(), query: vi.fn(), transaction: vi.fn() }));
vi.mock('@neondatabase/serverless', () => ({ neon: neonMock.neon }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`redirect:${url}`);
  },
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
// The page's gate is "signed in" (spec 2026-10-23 §2): getCurrentUser returns the account, or null when there is no session.
const auth = vi.hoisted(() => ({ user: null as null | { id: string; role: 'admin' | 'standard_user' } }));
vi.mock('@/lib/auth/getCurrentUser', () => ({ getCurrentUser: async () => auth.user }));
const data = vi.hoisted(() => ({ search: vi.fn(), departments: vi.fn(), broad: vi.fn(), paths: vi.fn(), custom: vi.fn(), expand: vi.fn() }));
vi.mock('@/lib/products/searchProducts', async (orig) => ({
  ...(await orig<typeof import('@/lib/products/searchProducts')>()),
  searchProducts: data.search,
}));
vi.mock('@/lib/products/listCategories', () => ({ listProductDepartments: data.departments, listProductBroadCategories: data.broad, listProductCategoryPaths: data.paths }));
vi.mock('@/lib/customCategories/loadServer', () => ({ listCustomCategoriesForUser: data.custom }));
vi.mock('@/lib/customCategories/expand', () => ({ expandCustomCategories: data.expand }));
// The recorder is mocked (slowQueries.test.ts covers the insert); the rest of its module is real, so the page
// reads the real SLOW_PRODUCT_SEARCH_MS, and the db client that module imports is a stub that never connects.
const slow = vi.hoisted(() => ({ record: vi.fn() }));
vi.mock('@/db/client', () => ({ db: {} }));
vi.mock('@/lib/products/slowQueries', async (orig) => ({
  ...(await orig<typeof import('@/lib/products/slowQueries')>()),
  recordSlowProductSearch: slow.record,
}));
// after() throws "outside a request scope" in plain vitest; the page's is a mock that captures the callback (as in
// app/api/ask/chat/route.test.ts), so a test runs it the way Next does once the response has finished.
const nextServer = vi.hoisted(() => ({ after: vi.fn() }));
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: nextServer.after }));

import ProductsPage from './page';

const RESULT: ProductSearchResult = {
  rows: [
    {
      asin: 'B000000001', title: 'LED Desk Lamp', brand: 'Acme', categoryPath: 'Home & Kitchen › Lighting › Desk Lamps', listedSince: '2026-08-01', monthlySold: 1000, reviewCount: 120,
      averageRatingX10: 44, currentPriceCents: 1999, salesRank: 1234, rankRatioX100: 65, fbaOfferCount: 3, fbmOfferCount: 1,
      amazonAvailability: -1, enrichmentStatus: 'active', keywordCount: 7,
    },
  ],
  total: 1234,
  totalIsCapped: false,
  page: 1,
  pageSize: 50,
};

/** The two kinds of signed-in account (role values of the users table): only the admin sees the perf panel. */
const ADMIN = { id: 'a1', role: 'admin' } as const;
const MEMBER = { id: 'm1', role: 'standard_user' } as const;

/**
 * Stand-in for the server renderer: React's client renderer cannot render async components, so
 * each one in the page's tree (the results section behind the Suspense) is replaced by its awaited
 * output. The client components are left for Testing Library to render.
 */
async function resolveAsync(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(resolveAsync));
  if (!isValidElement(node)) return node;
  const el = node as ReactElement<{ children?: ReactNode }>;
  if (typeof el.type === 'function' && el.type.constructor.name === 'AsyncFunction') {
    const component = el.type as (props: unknown) => Promise<ReactNode>;
    return resolveAsync(await component(el.props));
  }
  if (el.props.children === undefined) return el;
  const children = await resolveAsync(el.props.children);
  return Array.isArray(children) ? cloneElement(el, undefined, ...children) : cloneElement(el, undefined, children);
}

function callPage(search: Record<string, string> = {}) {
  return ProductsPage({ searchParams: Promise.resolve(search) });
}

describe('ProductsPage (/products)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.user = ADMIN;
    neonMock.neon.mockReturnValue({ query: neonMock.query, transaction: neonMock.transaction });
    neonMock.query.mockResolvedValue([]);
    neonMock.transaction.mockResolvedValue([[], []]);
    data.search.mockResolvedValue(RESULT);
    data.departments.mockResolvedValue(['Home & Kitchen', 'Pet Supplies']);
    data.broad.mockResolvedValue(['Home', 'Pet Supplies']);
    data.paths.mockResolvedValue(['Home & Kitchen › Lighting › Desk Lamps']);
    data.custom.mockResolvedValue([{ id: '11111111-1111-4111-8111-000000000001', name: 'Lamps', leafPaths: ['Home & Kitchen › Lighting › Desk Lamps'], createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' }]);
    data.expand.mockResolvedValue([]);
    slow.record.mockResolvedValue(undefined);
    nextServer.after.mockImplementation(() => undefined);
  });

  it('redirects a signed-out visitor to /sign-in before any read', async () => {
    auth.user = null;
    await expect(callPage()).rejects.toThrow('redirect:/sign-in');
    expect(neonMock.neon).not.toHaveBeenCalled();
    expect(data.search).not.toHaveBeenCalled();
    for (const fn of [data.departments, data.broad, data.paths, data.custom, data.expand]) expect(fn).not.toHaveBeenCalled();
  });

  it('for a signed-in member (not an admin): renders the list on their own account and shows no perf panel (spec 2026-10-23 §2)', async () => {
    auth.user = MEMBER;
    render(<>{await resolveAsync(await callPage())}</>);

    expect(screen.getByText('1,234 products')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'LED Desk Lamp' })).toBeInTheDocument();
    expect(data.search).toHaveBeenCalledTimes(1);
    // The custom-category reads are the member's own: the signed-in account's id, never another one.
    expect(data.custom).toHaveBeenCalledWith('m1');
    expect(data.expand).toHaveBeenCalledWith('m1', [], []);
    // The perf panel is admin-only (its own tests are in PerfPanel.test.tsx): nothing of it renders for a member.
    expect(screen.queryByText(/^perf · /)).not.toBeInTheDocument();
    expect(screen.queryByText(/read before the render/)).not.toBeInTheDocument();
  });

  it('for an admin: searches on the parsed filters through the neon runner and renders the results', async () => {
    render(<>{await resolveAsync(await callPage({ age: '180', sort: 'price', dir: 'asc', junk: 'x' }))}</>);

    expect(screen.getByText('1,234 products')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'LED Desk Lamp' })).toBeInTheDocument();
    expect(screen.getByLabelText('Listing age')).toHaveDisplayValue('Listed within 180 days');
    expect(screen.getByText('Page 1 of 25')).toBeInTheDocument();

    expect(data.search).toHaveBeenCalledTimes(1);
    const [runner, filters, scope] = data.search.mock.calls[0] as [SqlRunner, unknown, unknown];
    expect(filters).toEqual({ ...PRODUCT_DEFAULTS, age: 180, sort: 'price', dir: 'asc' });
    expect(scope).toEqual(EMPTY_CATEGORY_SCOPE);
    expect(neonMock.neon).toHaveBeenCalledWith('postgres://test');
    await runner('SELECT 1', []);
    expect(neonMock.query).toHaveBeenCalledWith('SELECT 1', []);
    // One transaction per statement (the statement timeout itself is pinned in searchProducts.test.ts).
    expect(neonMock.transaction).toHaveBeenCalledTimes(1);
    expect(data.departments).toHaveBeenCalledTimes(1);
    expect(data.broad).toHaveBeenCalledTimes(1);
    expect(data.paths).toHaveBeenCalledTimes(1);
    expect(data.custom).toHaveBeenCalledWith('a1');
    expect(data.expand).toHaveBeenCalledWith('a1', [], []);
    expect(screen.getByLabelText('Department (Keepa)')).toHaveDisplayValue('All departments');
    expect(screen.getByLabelText('Broad category (Brand Analytics)')).toHaveDisplayValue('All broad categories');
    // Two departments, two broad codes and one path in the fixtures: a swapped or an empty list fails one of these.
    // Both option lists are pinned whole: 'Pet Supplies' is in each fixture, so one shared option could not tell them apart.
    expect(within(screen.getByLabelText('Department (Keepa)')).getAllByRole('option').map((o) => o.textContent)).toEqual(['All departments', 'Home & Kitchen', 'Pet Supplies']);
    expect(within(screen.getByLabelText('Broad category (Brand Analytics)')).getAllByRole('option').map((o) => o.textContent)).toEqual(['All broad categories', 'Home', 'Pet Supplies']);
    expect(screen.getByText(/^1 category /)).toBeInTheDocument();
  });

  it('for an admin: the perf panel shows the handler total with the auth and loads steps; the loads note times the five reads, run in parallel, with the path count and size', async () => {
    render(<>{await resolveAsync(await callPage())}</>);
    // The summary line (PerfPanel): total, then one entry per step.
    expect(screen.getByText(/^perf · total=\d+ms · auth=\d+ms · loads=\d+ms$/)).toBeInTheDocument();
    // The loads row's note: the fixture's one path, 38 characters, rounds to 0.0 MB.
    expect(screen.getByText(/^\(parallel: search \d+ · departments \d+ · broad \d+ · paths \d+ \(1 · 0\.0 MB\) · custom \d+ ms\)$/)).toBeInTheDocument();
    expect(screen.getByText(/read before the render/)).toBeInTheDocument();
  });

  it('starts the five reads in parallel: none waits for another to finish', async () => {
    const started: string[] = [];
    let open = () => {};
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const hold = <T,>(name: string, value: T) => async () => { started.push(name); await gate; return value; };
    data.search.mockImplementation(hold('search', RESULT));
    data.departments.mockImplementation(hold('departments', ['Home & Kitchen', 'Pet Supplies']));
    data.broad.mockImplementation(hold('broad', ['Home', 'Pet Supplies']));
    data.paths.mockImplementation(hold('paths', ['Home & Kitchen › Lighting › Desk Lamps']));
    data.custom.mockImplementation(hold('custom', []));
    const page = callPage().then((el) => resolveAsync(el));
    await vi.waitFor(() => expect(started).toHaveLength(5));
    expect([...started].sort()).toEqual(['broad', 'custom', 'departments', 'paths', 'search']);
    open();
    render(<>{await page}</>);
    expect(screen.getByText('1,234 products')).toBeInTheDocument();
  });

  it("expands the admin's custom categories into exact paths for the query and keeps the ids in the filters", async () => {
    const ID = '11111111-1111-4111-8111-000000000001';
    data.expand.mockResolvedValue(['Home & Kitchen › Lighting › Desk Lamps']);
    render(<>{await resolveAsync(await callPage({ dept: 'Home & Kitchen', custom: ID }))}</>);
    const [, filters, scope] = data.search.mock.calls[0] as [SqlRunner, unknown, unknown];
    expect(filters).toEqual({ ...PRODUCT_DEFAULTS, dept: 'Home & Kitchen', customCategoryIds: [ID] });
    expect(scope).toEqual({ dept: 'Home & Kitchen', subtreePaths: [], exactPaths: ['Home & Kitchen › Lighting › Desk Lamps'], scoped: true });
    expect(data.expand).toHaveBeenCalledWith('a1', [ID], []);
    expect(screen.getByRole('checkbox', { name: 'Lamps (1)' })).toBeChecked();
  });

  it('a failed department, broad-category or path read renders empty lists and still searches: the search does not need them', async () => {
    data.departments.mockRejectedValue(new Error('cold'));
    data.broad.mockRejectedValue(new Error('cold'));
    data.paths.mockRejectedValue(new Error('cold'));
    render(<>{await resolveAsync(await callPage())}</>);
    expect(screen.getByRole('link', { name: 'LED Desk Lamp' })).toBeInTheDocument();
    expect(data.search).toHaveBeenCalledTimes(1);
    expect(within(screen.getByLabelText('Department (Keepa)')).getAllByRole('option').map((o) => o.textContent)).toEqual(['All departments']);
    expect(within(screen.getByLabelText('Broad category (Brand Analytics)')).getAllByRole('option').map((o) => o.textContent)).toEqual(['All broad categories']);
    expect(screen.getByText(/^0 categories/)).toBeInTheDocument();
  });

  it('a failed expansion fails the page and never searches', async () => {
    data.expand.mockRejectedValue(new Error('expand failed'));
    await expect(resolveAsync(await callPage({ custom: '11111111-1111-4111-8111-000000000001' }))).rejects.toThrow('expand failed');
    expect(data.search).not.toHaveBeenCalled();
  });

  describe('a slow or timed-out search (spec 2026-10-23 §5 and §5b)', () => {
    const NOTICE = 'This combination took too long to load. Narrow the filters or try again.';
    /** What the neon driver rejects with when the statement cap cancels the rows read, reduced to the field the page reads. */
    const STATEMENT_TIMEOUT = { code: '57014' };
    // A stand-in clock for timed() and the handler timer: only the search mock moves it, by the time the search
    // "takes", so the search's measured ms is exact.
    let clock = 0;
    beforeEach(() => {
      clock = 1_000_000;
      vi.spyOn(Date, 'now').mockImplementation(() => clock);
    });
    afterEach(() => vi.mocked(Date.now).mockRestore());
    /** The search mock: the clock moves `ms` while it runs, then it resolves to RESULT, or rejects with `error` when one is given. */
    const searchTaking = (ms: number, error?: unknown) => async (): Promise<ProductSearchResult> => {
      clock += ms;
      if (error !== undefined) throw error;
      return RESULT;
    };
    /** The query string of the filters the page searched on, the form a recorded row carries. */
    const searchedQueryString = () => productFiltersToSearchParams((data.search.mock.calls[0] as [SqlRunner, ProductFilters, unknown])[1]).toString();
    /** The one callback the page handed to after(); a test calls it the way Next does once the response has finished. */
    const afterCallback = () => {
      expect(nextServer.after).toHaveBeenCalledTimes(1);
      return nextServer.after.mock.calls[0][0] as () => Promise<void>;
    };

    it('a rows read cut off by the statement cap (57014): the notice in place of the table and the pager, the filter and perf panels kept; the timeout goes to after(), recorded only when Next runs it', async () => {
      data.search.mockImplementation(searchTaking(30_000, STATEMENT_TIMEOUT));
      // Never settles: the page cannot be waiting on the recording.
      const pending = new Promise<void>(() => {});
      slow.record.mockReturnValue(pending);
      render(<>{await resolveAsync(await callPage({ broad: 'Home', sort: 'keywords' }))}</>);

      expect(screen.getByText(NOTICE)).toHaveAttribute('role', 'status');
      expect(screen.queryByRole('table')).not.toBeInTheDocument();
      expect(screen.queryByText(/^[\d,]+\+? products?$/)).not.toBeInTheDocument();
      expect(screen.queryByText(/^Page \d+ of /)).not.toBeInTheDocument();
      // The panel stays, seeded from the filters and with its lists loaded: the four other reads still ran.
      expect(screen.getByLabelText('Broad category (Brand Analytics)')).toHaveDisplayValue('Home');
      expect(within(screen.getByLabelText('Department (Keepa)')).getAllByRole('option').map((o) => o.textContent)).toEqual(['All departments', 'Home & Kitchen', 'Pet Supplies']);
      expect(screen.getByText(/^1 category /)).toBeInTheDocument();
      // The admin perf panel stays; its loads note names the timeout.
      expect(screen.getByText(/^\(parallel: search timed out after 30000 · departments \d+ · broad \d+ · paths \d+ \(1 · 0\.0 MB\) · custom \d+ ms\)$/)).toBeInTheDocument();

      // Scheduled once and not run yet: the page is already rendered when Next runs the callback.
      const callback = afterCallback();
      expect(slow.record).not.toHaveBeenCalled();
      // The callback hands Next the recorder's own promise to wait for (pending here).
      expect(callback()).toBe(pending);
      expect(slow.record).toHaveBeenCalledTimes(1);
      expect(slow.record).toHaveBeenCalledWith({ userId: 'a1', queryString: searchedQueryString(), elapsedMs: 30_000, timedOut: true });
      // The filters exactly as the URL carries them.
      expect(searchedQueryString()).toBe('broad=Home&sort=keywords');
    });

    it.each([8_001, 9_000])('a search that completes in %i ms (above SLOW_PRODUCT_SEARCH_MS) renders as usual and goes to after() with timedOut false', async (ms) => {
      data.search.mockImplementation(searchTaking(ms));
      render(<>{await resolveAsync(await callPage({ age: '60', page: '3' }))}</>);

      expect(screen.getByText('1,234 products')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'LED Desk Lamp' })).toBeInTheDocument();
      expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
      const callback = afterCallback();
      expect(slow.record).not.toHaveBeenCalled();
      await callback();
      expect(slow.record).toHaveBeenCalledTimes(1);
      expect(slow.record).toHaveBeenCalledWith({ userId: 'a1', queryString: searchedQueryString(), elapsedMs: ms, timedOut: false });
      expect(searchedQueryString()).toBe('age=60&page=3');
    });

    it.each([0, 8_000])('a search that completes in %i ms (not above SLOW_PRODUCT_SEARCH_MS) renders as usual; nothing is scheduled or recorded', async (ms) => {
      data.search.mockImplementation(searchTaking(ms));
      render(<>{await resolveAsync(await callPage())}</>);

      expect(screen.getByText('1,234 products')).toBeInTheDocument();
      expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
      expect(nextServer.after).not.toHaveBeenCalled();
      expect(slow.record).not.toHaveBeenCalled();
    });

    it('when after() throws (no request scope), the page still renders and the row is recorded directly, never awaited', async () => {
      nextServer.after.mockImplementation(() => {
        throw new Error('`after` was called outside a request scope.');
      });
      data.search.mockImplementation(searchTaking(9_000));
      // Never settles: the direct call is not awaited either.
      slow.record.mockReturnValue(new Promise<void>(() => {}));
      render(<>{await resolveAsync(await callPage({ sort: 'keywords' }))}</>);

      expect(screen.getByText('1,234 products')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'LED Desk Lamp' })).toBeInTheDocument();
      expect(nextServer.after).toHaveBeenCalledTimes(1);
      expect(slow.record).toHaveBeenCalledTimes(1);
      expect(slow.record).toHaveBeenCalledWith({ userId: 'a1', queryString: 'sort=keywords', elapsedMs: 9_000, timedOut: false });
    });

    it('a custom-categories read that rejects after a timed-out search still fails the page, and the timeout was already scheduled', async () => {
      const failure = new Error('custom categories read failed');
      data.search.mockImplementation(searchTaking(30_000, STATEMENT_TIMEOUT));
      // Rejects on a later macrotask: the search settles within microtasks, so it is timed (and scheduled) first.
      data.custom.mockImplementation(() => new Promise<never>((_, reject) => setTimeout(() => reject(failure), 0)));
      await expect(resolveAsync(await callPage({ broad: 'Home' }))).rejects.toBe(failure);

      const callback = afterCallback();
      expect(slow.record).not.toHaveBeenCalled();
      await callback();
      expect(slow.record).toHaveBeenCalledTimes(1);
      expect(slow.record).toHaveBeenCalledWith({ userId: 'a1', queryString: 'broad=Home', elapsedMs: 30_000, timedOut: true });
    });

    it('any other search failure still fails the page; nothing is scheduled or recorded, even when slow', async () => {
      for (const error of [Object.assign(new Error('out of memory'), { code: '53200' }), new Error('fetch failed')]) {
        data.search.mockImplementation(searchTaking(30_000, error));
        await expect(resolveAsync(await callPage())).rejects.toBe(error);
      }
      expect(nextServer.after).not.toHaveBeenCalled();
      expect(slow.record).not.toHaveBeenCalled();
    });
  });
});
