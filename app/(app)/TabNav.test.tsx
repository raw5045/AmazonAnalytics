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

/**
 * A promise `use()` can read synchronously (React's thenable protocol:
 * `status` + `value`). Keeps the streamed watchlist badge from suspending
 * on mount — while a Suspense child is suspended, React holds back the
 * nav's own passive effects, which is exactly what these tests exercise.
 */
function settled(count: number): Promise<number> {
  return Object.assign(Promise.resolve(count), { status: 'fulfilled' as const, value: count });
}

function tabNav(showConnectAi = false) {
  return <TabNav watchlistCountPromise={settled(0)} showConnectAi={showConnectAi} />;
}

function explorerLink() {
  return screen.getByRole('link', { name: 'Explorer' });
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

  describe('remembering the last /explorer URL', () => {
    it('on /explorer, points the Explorer tab at the current URL and saves it', () => {
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

    it('elsewhere, points the Explorer tab at the saved URL', () => {
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
});
