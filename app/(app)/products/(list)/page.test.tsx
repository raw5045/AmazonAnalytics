import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { EMPTY_CATEGORY_SCOPE } from '@/lib/products/categoryPredicate';
import { PRODUCT_DEFAULTS } from '@/lib/products/filterParams';
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
const auth = vi.hoisted(() => ({ state: 'admin' as 'admin' | 'unauthenticated' | 'forbidden' }));
vi.mock('@/lib/auth/requireAdmin', async () => {
  const { AuthError } = await import('@/lib/auth/AuthError');
  return {
    AuthError,
    requireAdmin: async () => {
      if (auth.state === 'unauthenticated') throw new AuthError('UNAUTHENTICATED', 'Not signed in');
      if (auth.state === 'forbidden') throw new AuthError('FORBIDDEN', 'Admin only');
      return { id: 'a1', role: 'admin' };
    },
  };
});
const data = vi.hoisted(() => ({ search: vi.fn(), departments: vi.fn(), paths: vi.fn(), custom: vi.fn(), expand: vi.fn() }));
vi.mock('@/lib/products/searchProducts', async (orig) => ({
  ...(await orig<typeof import('@/lib/products/searchProducts')>()),
  searchProducts: data.search,
}));
vi.mock('@/lib/products/listCategories', () => ({ listProductDepartments: data.departments, listProductCategoryPaths: data.paths }));
vi.mock('@/lib/customCategories/loadServer', () => ({ listCustomCategoriesForUser: data.custom }));
vi.mock('@/lib/customCategories/expand', () => ({ expandCustomCategories: data.expand }));

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
    auth.state = 'admin';
    neonMock.neon.mockReturnValue({ query: neonMock.query, transaction: neonMock.transaction });
    neonMock.query.mockResolvedValue([]);
    neonMock.transaction.mockResolvedValue([[], []]);
    data.search.mockResolvedValue(RESULT);
    data.departments.mockResolvedValue(['Home & Kitchen', 'Pet Supplies']);
    data.paths.mockResolvedValue(['Home & Kitchen › Lighting › Desk Lamps']);
    data.custom.mockResolvedValue([{ id: '11111111-1111-4111-8111-000000000001', name: 'Lamps', leafPaths: ['Home & Kitchen › Lighting › Desk Lamps'], createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' }]);
    data.expand.mockResolvedValue([]);
  });

  it('redirects a signed-out visitor to /sign-in before any read', async () => {
    auth.state = 'unauthenticated';
    await expect(callPage()).rejects.toThrow('redirect:/sign-in');
    expect(neonMock.neon).not.toHaveBeenCalled();
    expect(data.search).not.toHaveBeenCalled();
    for (const fn of [data.departments, data.paths, data.custom, data.expand]) expect(fn).not.toHaveBeenCalled();
  });

  it('redirects a signed-in non-admin to /explorer before any read', async () => {
    auth.state = 'forbidden';
    await expect(callPage()).rejects.toThrow('redirect:/explorer');
    expect(neonMock.neon).not.toHaveBeenCalled();
    expect(data.search).not.toHaveBeenCalled();
    for (const fn of [data.departments, data.paths, data.custom, data.expand]) expect(fn).not.toHaveBeenCalled();
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
    expect(data.paths).toHaveBeenCalledTimes(1);
    expect(data.custom).toHaveBeenCalledWith('a1');
    expect(data.expand).toHaveBeenCalledWith('a1', [], []);
    expect(screen.getByLabelText('Department')).toHaveDisplayValue('All departments');
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
});
