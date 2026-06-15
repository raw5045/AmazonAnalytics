import { describe, it, expect } from 'vitest';
import { shouldRestoreViaBack } from './BackToExplorer';

describe('shouldRestoreViaBack', () => {
  it('restores via back() when we came from the explorer and have history', () => {
    expect(shouldRestoreViaBack(true, 2)).toBe(true);
    expect(shouldRestoreViaBack(true, 5)).toBe(true);
  });

  it('does NOT use back() on a direct entry (no history behind us)', () => {
    // historyLength === 1 means this is the first entry — back() would leave
    // the app, so fall back to the <Link>.
    expect(shouldRestoreViaBack(true, 1)).toBe(false);
    expect(shouldRestoreViaBack(true, 0)).toBe(false);
  });

  it('does NOT use back() when we did not come from the explorer', () => {
    // e.g. reached from the watchlist or a bookmarked detail URL — "Back to
    // explorer" should navigate to the explorer, not the previous page.
    expect(shouldRestoreViaBack(false, 5)).toBe(false);
    expect(shouldRestoreViaBack(false, 1)).toBe(false);
  });
});
