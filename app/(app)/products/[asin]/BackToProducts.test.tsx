import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const back = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ back }) }));

import { BackToProducts, resolveProductBack, shouldRestoreViaBack } from './BackToProducts';

const KW = '3f2a9c1e-5b7d-4e8a-9c3b-1a2b3c4d5e6f';
const KEYWORD_PAGE = `/explorer/keyword/${KW}`;

/** jsdom has no navigation: stop the anchor's default action after React has seen the click. */
function swallowNavigation(e: Event) {
  e.preventDefault();
}

describe('resolveProductBack', () => {
  it.each(['/products', '/products?age=180&soldMin=1000&reviewsMax=300', '/products?page=2&sort=listed&dir=asc'])(
    'the products list (%s): "Back to products", to that exact URL, restorable via back()',
    (from) => {
      expect(resolveProductBack(from)).toEqual({ href: from, label: 'Back to products', cameFromPage: true });
    },
  );

  it('the keyword page the link-back sends (/explorer/keyword/<uuid>): "Back to keyword", to that page, restorable via back()', () => {
    expect(resolveProductBack(KEYWORD_PAGE)).toEqual({ href: KEYWORD_PAGE, label: 'Back to keyword', cameFromPage: true });
  });

  it.each([
    undefined,
    null,
    '',
    'https://evil.example/products',
    '//evil.example/products',
    '/\\evil.example/products',
    'products',
    '/productsX',
    '/products/',
    '/products/B000000001',
    '/products#top',
    '/explorer',
    '/explorer?q=lamp',
    '/explorer/keyword/not-a-uuid',
    `/explorer/keyword/${KW}/`,
    `/explorer/keyword/${KW}?from=/explorer`,
    `/explorer/keyword/${KW}\n`,
    // never nest from: a from that carries its own from is not accepted
    `/products?from=${encodeURIComponent(KEYWORD_PAGE)}`,
    '/products?age=180&from=/explorer',
  ])('anything else (%j): a plain link to /products, labelled "Back to products"', (from) => {
    expect(resolveProductBack(from)).toEqual({ href: '/products', label: 'Back to products', cameFromPage: false });
  });
});

describe('shouldRestoreViaBack', () => {
  it('only when we came from an accepted page and there is a history entry behind us', () => {
    expect(shouldRestoreViaBack(true, 2)).toBe(true);
    expect(shouldRestoreViaBack(true, 1)).toBe(false); // direct entry / new tab: back() would leave the app
    expect(shouldRestoreViaBack(false, 5)).toBe(false);
  });
});

describe('BackToProducts', () => {
  beforeEach(() => {
    back.mockReset();
    vi.spyOn(History.prototype, 'length', 'get').mockReturnValue(3);
    document.addEventListener('click', swallowNavigation);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    document.removeEventListener('click', swallowNavigation);
  });

  it('from the keyword page: "Back to keyword" links to it, and a plain click restores it with router.back()', () => {
    render(<BackToProducts from={KEYWORD_PAGE} />);
    const link = screen.getByRole('link', { name: '← Back to keyword' });
    expect(link).toHaveAttribute('href', KEYWORD_PAGE);
    fireEvent.click(link);
    expect(back).toHaveBeenCalledTimes(1);
  });

  it('from the products list: "Back to products" links to the filtered list, and a plain click uses router.back()', () => {
    const from = '/products?age=180&soldMin=1000';
    render(<BackToProducts from={from} />);
    const link = screen.getByRole('link', { name: '← Back to products' });
    expect(link).toHaveAttribute('href', from);
    fireEvent.click(link);
    expect(back).toHaveBeenCalledTimes(1);
  });

  it('a modified click (new tab) is left to the browser', () => {
    render(<BackToProducts from={KEYWORD_PAGE} />);
    fireEvent.click(screen.getByRole('link', { name: '← Back to keyword' }), { ctrlKey: true });
    expect(back).not.toHaveBeenCalled();
  });

  it('no history behind us (direct entry): the link navigates instead of calling back()', () => {
    vi.spyOn(History.prototype, 'length', 'get').mockReturnValue(1);
    render(<BackToProducts from={KEYWORD_PAGE} />);
    fireEvent.click(screen.getByRole('link', { name: '← Back to keyword' }));
    expect(back).not.toHaveBeenCalled();
  });

  it.each([undefined, 'https://evil.example/', '/explorer'])(
    'anything else (%j): a plain "Back to products" link to /products that never calls back()',
    (from) => {
      render(<BackToProducts from={from} />);
      const link = screen.getByRole('link', { name: '← Back to products' });
      expect(link).toHaveAttribute('href', '/products');
      fireEvent.click(link);
      expect(back).not.toHaveBeenCalled();
    },
  );
});
