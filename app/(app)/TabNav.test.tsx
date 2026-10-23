import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderToString } from 'react-dom/server';
import { render, screen } from '@testing-library/react';

const nav = vi.hoisted(() => ({ pathname: '/explorer', search: '' }));
vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
}));

import { TabNav } from './TabNav';

const LAST_EXPLORER_URL_KEY = 'kw-analytics.last-explorer-url';
const LAST_PRODUCTS_URL_KEY = 'kw-analytics.last-products-url';

/**
 * A promise `use()` can read synchronously (React's thenable protocol:
 * `status` + `value`). Keeps the streamed watchlist badge from suspending
 * on mount — while a Suspense child is suspended, React holds back the
 * nav's own passive effects, which is exactly what these tests exercise.
 */
function settled(count: number): Promise<number> {
  return Object.assign(Promise.resolve(count), { status: 'fulfilled' as const, value: count });
}

function tabNav(showConnectAi = false, showAskAi = false, showProducts = false) {
  return (
    <TabNav watchlistCountPromise={settled(0)} showConnectAi={showConnectAi} showAskAi={showAskAi} showProducts={showProducts} />
  );
}

function explorerLink() {
  return screen.getByRole('link', { name: 'Keywords' });
}

function productsLink() {
  return screen.getByRole('link', { name: 'Products' });
}

describe('TabNav', () => {
  beforeEach(() => {
    nav.pathname = '/explorer';
    nav.search = '';
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the Connect AI tab only when the account is eligible', () => {
    const { unmount } = render(tabNav(false));
    expect(screen.queryByRole('link', { name: /connect ai/i })).toBeNull();
    unmount();

    render(tabNav(true));
    expect(screen.getByRole('link', { name: /connect ai/i })).toHaveAttribute('href', '/connect-ai');
  });

  it('shows the Ask AI tab only when eligible, between Category Builder and Connect AI', () => {
    render(tabNav(true, true));
    const names = screen.getAllByRole('link').map((l) => l.textContent?.trim());
    expect(names).toEqual(['Keywords', 'Watchlist', 'Category Builder', 'Ask AI', 'Connect AI', 'Tutorials']);
    expect(screen.getByRole('link', { name: 'Ask AI' })).toHaveAttribute('href', '/ask');
  });
  it('hides the Ask AI tab when not eligible', () => {
    render(tabNav(true, false));
    expect(screen.queryByRole('link', { name: 'Ask AI' })).toBeNull();
  });

  describe('the Products tab (showProducts)', () => {
    // Active = the white label with the amber underline; an inactive tab only has hover:text-white.
    const expectActive = (link: HTMLElement) => expect(link).toHaveClass('text-white', 'after:bg-amber-300');
    const expectInactive = (link: HTMLElement) => {
      expect(link).not.toHaveClass('text-white');
      expect(link).not.toHaveClass('after:bg-amber-300');
    };

    it('shows between Keywords and Watchlist when showProducts is true', () => {
      render(tabNav(true, true, true));
      const names = screen.getAllByRole('link').map((l) => l.textContent?.trim());
      expect(names).toEqual(['Keywords', 'Products', 'Watchlist', 'Category Builder', 'Ask AI', 'Connect AI', 'Tutorials']);
      expect(productsLink()).toHaveAttribute('href', '/products');
    });

    it('is absent when showProducts is false', () => {
      render(tabNav(true, true, false));
      expect(screen.queryByRole('link', { name: 'Products' })).toBeNull();
      expect(document.querySelector('a[href="/products"]')).toBeNull();
    });

    it.each(['/products', '/products/B000000001'])('is the active tab on %s, and Keywords is not', (path) => {
      nav.pathname = path;
      render(tabNav(false, false, true));
      expectActive(productsLink());
      expectInactive(explorerLink());
    });

    it.each(['/explorer', '/watchlist', '/productsearch'])('is not active on %s', (path) => {
      nav.pathname = path;
      render(tabNav(false, false, true));
      expectInactive(productsLink());
    });
  });

  describe('remembering the last /explorer URL', () => {
    it('on /explorer, points the Keywords tab at the current URL and saves it', () => {
      nav.search = 'q=protein&sort=volume';
      render(tabNav());
      expect(explorerLink()).toHaveAttribute('href', '/explorer?q=protein&sort=volume');
      expect(localStorage.getItem(LAST_EXPLORER_URL_KEY)).toBe('/explorer?q=protein&sort=volume');
    });

    it('on /explorer with no query string, saves the bare /explorer', () => {
      render(tabNav());
      expect(explorerLink()).toHaveAttribute('href', '/explorer');
      expect(localStorage.getItem(LAST_EXPLORER_URL_KEY)).toBe('/explorer');
    });

    it('follows filter changes while staying on /explorer', () => {
      nav.search = 'q=zinc';
      const { rerender } = render(tabNav());

      nav.search = 'q=zinc&sort=rank';
      rerender(tabNav());
      expect(explorerLink()).toHaveAttribute('href', '/explorer?q=zinc&sort=rank');
      expect(localStorage.getItem(LAST_EXPLORER_URL_KEY)).toBe('/explorer?q=zinc&sort=rank');
    });

    it('elsewhere, points the Keywords tab at the saved URL', () => {
      localStorage.setItem(LAST_EXPLORER_URL_KEY, '/explorer?q=creatine');
      nav.pathname = '/watchlist';
      render(tabNav());
      expect(explorerLink()).toHaveAttribute('href', '/explorer?q=creatine');
    });

    it('elsewhere with nothing saved, falls back to the bare /explorer', () => {
      nav.pathname = '/watchlist';
      render(tabNav());
      expect(explorerLink()).toHaveAttribute('href', '/explorer');
      expect(localStorage.getItem(LAST_EXPLORER_URL_KEY)).toBeNull();
    });

    it('does not remember keyword detail pages', () => {
      localStorage.setItem(LAST_EXPLORER_URL_KEY, '/explorer?q=creatine');
      nav.pathname = '/explorer/keyword/abc123';
      render(tabNav());
      expect(explorerLink()).toHaveAttribute('href', '/explorer?q=creatine');
      expect(localStorage.getItem(LAST_EXPLORER_URL_KEY)).toBe('/explorer?q=creatine');
    });

    it('restores the filters after switching to another tab without remounting', () => {
      nav.search = 'q=magnesium&page=2';
      const { rerender } = render(tabNav());

      nav.pathname = '/watchlist';
      nav.search = '';
      rerender(tabNav());
      expect(explorerLink()).toHaveAttribute('href', '/explorer?q=magnesium&page=2');
    });

    it('still points at the current URL when localStorage rejects the write', () => {
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('QuotaExceededError');
      });
      nav.search = 'q=zinc';
      render(tabNav());
      expect(explorerLink()).toHaveAttribute('href', '/explorer?q=zinc');
    });

    it('falls back to the bare /explorer when localStorage cannot be read', () => {
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('SecurityError');
      });
      nav.pathname = '/watchlist';
      render(tabNav());
      expect(explorerLink()).toHaveAttribute('href', '/explorer');
    });

    it('server-renders the bare /explorer so hydration matches regardless of localStorage', () => {
      localStorage.setItem(LAST_EXPLORER_URL_KEY, '/explorer?q=creatine');
      nav.pathname = '/watchlist';
      const html = renderToString(tabNav());
      expect(html).toContain('href="/explorer"');
      expect(html).not.toContain('creatine');
    });
  });

  describe('remembering the last /products URL (spec 2026-10-19 §10)', () => {
    it('on /products, points the Products tab at the current URL and saves it; the Keywords memory is neither cleared nor overwritten', () => {
      localStorage.setItem(LAST_EXPLORER_URL_KEY, '/explorer?q=creatine');
      nav.pathname = '/products';
      nav.search = 'dept=Pet+Supplies&sort=listed&page=2';
      render(tabNav(false, false, true));
      expect(productsLink()).toHaveAttribute('href', '/products?dept=Pet+Supplies&sort=listed&page=2');
      expect(localStorage.getItem(LAST_PRODUCTS_URL_KEY)).toBe('/products?dept=Pet+Supplies&sort=listed&page=2');
      expect(localStorage.getItem(LAST_EXPLORER_URL_KEY)).toBe('/explorer?q=creatine');
      expect(explorerLink()).toHaveAttribute('href', '/explorer?q=creatine');
    });

    it('on /products with no query string, saves the bare /products', () => {
      nav.pathname = '/products';
      render(tabNav(false, false, true));
      expect(productsLink()).toHaveAttribute('href', '/products');
      expect(localStorage.getItem(LAST_PRODUCTS_URL_KEY)).toBe('/products');
    });

    it('elsewhere, points the Products tab at the saved URL and the Keywords tab at its own', () => {
      localStorage.setItem(LAST_PRODUCTS_URL_KEY, '/products?broad=Pet+Products');
      localStorage.setItem(LAST_EXPLORER_URL_KEY, '/explorer?q=creatine');
      nav.pathname = '/watchlist';
      render(tabNav(false, false, true));
      expect(productsLink()).toHaveAttribute('href', '/products?broad=Pet+Products');
      expect(explorerLink()).toHaveAttribute('href', '/explorer?q=creatine');
    });

    it('does not remember product (ASIN) pages, and restores the list from one', () => {
      localStorage.setItem(LAST_PRODUCTS_URL_KEY, '/products?broad=Pet+Products');
      nav.pathname = '/products/B000000001';
      nav.search = 'from=%2Fproducts';
      render(tabNav(false, false, true));
      expect(productsLink()).toHaveAttribute('href', '/products?broad=Pet+Products');
      expect(localStorage.getItem(LAST_PRODUCTS_URL_KEY)).toBe('/products?broad=Pet+Products');
    });

    it('restores the filters after switching to the Keywords tab and back without remounting', () => {
      nav.pathname = '/products';
      nav.search = 'dept=Books&page=3';
      const { rerender } = render(tabNav(false, false, true));

      nav.pathname = '/explorer';
      nav.search = 'q=zinc';
      rerender(tabNav(false, false, true));
      expect(productsLink()).toHaveAttribute('href', '/products?dept=Books&page=3');
      expect(explorerLink()).toHaveAttribute('href', '/explorer?q=zinc');
      expect(localStorage.getItem(LAST_PRODUCTS_URL_KEY)).toBe('/products?dept=Books&page=3');

      nav.pathname = '/products';
      nav.search = 'dept=Books&page=3';
      rerender(tabNav(false, false, true));
      expect(productsLink()).toHaveAttribute('href', '/products?dept=Books&page=3');
      expect(explorerLink()).toHaveAttribute('href', '/explorer?q=zinc');
    });

    it('elsewhere with nothing saved, falls back to the bare /products', () => {
      nav.pathname = '/watchlist';
      render(tabNav(false, false, true));
      expect(productsLink()).toHaveAttribute('href', '/products');
      expect(localStorage.getItem(LAST_PRODUCTS_URL_KEY)).toBeNull();
    });

    it('still points at the current URL when localStorage rejects the write', () => {
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('QuotaExceededError');
      });
      nav.pathname = '/products';
      nav.search = 'dept=Books';
      render(tabNav(false, false, true));
      expect(productsLink()).toHaveAttribute('href', '/products?dept=Books');
    });

    it('falls back to the bare /products when localStorage cannot be read', () => {
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('SecurityError');
      });
      nav.pathname = '/watchlist';
      render(tabNav(false, false, true));
      expect(productsLink()).toHaveAttribute('href', '/products');
    });

    it('server-renders the bare /products so hydration matches regardless of localStorage', () => {
      localStorage.setItem(LAST_PRODUCTS_URL_KEY, '/products?broad=Pet+Products');
      nav.pathname = '/watchlist';
      const html = renderToString(tabNav(false, false, true));
      expect(html).toContain('href="/products"');
      expect(html).not.toContain('Pet+Products');
    });
  });
});
