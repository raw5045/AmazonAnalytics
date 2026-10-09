import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const back = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ back }) }));

import { BackToExplorer, shouldRestoreViaBack } from './BackToExplorer';

describe('shouldRestoreViaBack', () => {
  it('restores via back() when we came from the explorer and have history', () => {
    expect(shouldRestoreViaBack(true, true)).toBe(true);
  });

  it('does NOT use back() on a direct entry (no history behind us)', () => {
    // No entry behind the current one — back() would leave the app (or do
    // nothing), so fall back to the <Link>.
    expect(shouldRestoreViaBack(true, false)).toBe(false);
  });

  it('does NOT use back() when we did not come from the explorer', () => {
    // e.g. reached from the watchlist or a bookmarked detail URL — "Back to
    // explorer" should navigate to the explorer, not the previous page.
    expect(shouldRestoreViaBack(false, true)).toBe(false);
    expect(shouldRestoreViaBack(false, false)).toBe(false);
  });
});

// canGoBack itself is pinned in lib/nav/canGoBack.test.ts; the cases below check this component wires it in.
describe('BackToExplorer', () => {
  const HREF = '/explorer?q=lamp&page=2';

  /** Per click: whether our handler had already prevented the link's own navigation. */
  const prevented: boolean[] = [];
  /** jsdom cannot navigate: note whether the click was prevented, then stop the anchor's default action. */
  function swallowNavigation(e: Event) {
    prevented.push(e.defaultPrevented);
    e.preventDefault();
  }

  beforeEach(() => {
    back.mockReset();
    prevented.length = 0;
    vi.spyOn(History.prototype, 'length', 'get').mockReturnValue(3);
    document.addEventListener('click', swallowNavigation);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    document.removeEventListener('click', swallowNavigation);
    delete (window as { navigation?: unknown }).navigation;
  });

  it('came from the explorer: the link points at it, and a plain click restores it with router.back()', () => {
    render(<BackToExplorer href={HREF} cameFromExplorer />);
    const link = screen.getByRole('link', { name: '← Back to explorer' });
    expect(link).toHaveAttribute('href', HREF);
    fireEvent.click(link);
    expect(back).toHaveBeenCalledTimes(1);
    expect(prevented).toEqual([true]); // the link's own navigation is replaced by back()
  });

  it('at the first history entry (Navigation API canGoBack false), the link navigates even with entries ahead', () => {
    // The explorer opens keyword pages in a new tab; a same-tab hop and the browser's Back leave history.length at 3 here.
    Object.defineProperty(window, 'navigation', { configurable: true, value: { canGoBack: false } });
    render(<BackToExplorer href={HREF} cameFromExplorer />);
    fireEvent.click(screen.getByRole('link', { name: '← Back to explorer' }));
    expect(back).not.toHaveBeenCalled();
    expect(prevented).toEqual([false]); // left to the link: it opens the explorer
  });

  it('with the Navigation API saying it can go back, router.back() is used', () => {
    Object.defineProperty(window, 'navigation', { configurable: true, value: { canGoBack: true } });
    render(<BackToExplorer href={HREF} cameFromExplorer />);
    fireEvent.click(screen.getByRole('link', { name: '← Back to explorer' }));
    expect(back).toHaveBeenCalledTimes(1);
  });

  it('no history behind us (direct entry, no Navigation API): the link navigates instead of calling back()', () => {
    vi.spyOn(History.prototype, 'length', 'get').mockReturnValue(1);
    render(<BackToExplorer href={HREF} cameFromExplorer />);
    fireEvent.click(screen.getByRole('link', { name: '← Back to explorer' }));
    expect(back).not.toHaveBeenCalled();
    expect(prevented).toEqual([false]);
  });

  it('did not come from the explorer: the link navigates, whatever the history', () => {
    render(<BackToExplorer href={HREF} cameFromExplorer={false} />);
    fireEvent.click(screen.getByRole('link', { name: '← Back to explorer' }));
    expect(back).not.toHaveBeenCalled();
    expect(prevented).toEqual([false]);
  });

  it('a modified click (new tab) is left to the browser', () => {
    render(<BackToExplorer href={HREF} cameFromExplorer />);
    fireEvent.click(screen.getByRole('link', { name: '← Back to explorer' }), { ctrlKey: true });
    expect(back).not.toHaveBeenCalled();
  });
});
