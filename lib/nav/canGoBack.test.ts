// lib/nav/canGoBack.test.ts
import { describe, it, expect } from 'vitest';
import { canGoBack } from './canGoBack';

describe('canGoBack', () => {
  it("trusts the Navigation API's canGoBack when there is one, whatever history.length says", () => {
    // New tab, same-tab hop to a second page, then the browser's Back: the first entry, one entry ahead.
    expect(canGoBack({ navigation: { canGoBack: false }, history: { length: 2 } })).toBe(false);
    expect(canGoBack({ navigation: { canGoBack: true }, history: { length: 1 } })).toBe(true);
  });

  it('without it, guesses from history.length', () => {
    expect(canGoBack({ history: { length: 2 } })).toBe(true);
    expect(canGoBack({ history: { length: 1 } })).toBe(false);
    expect(canGoBack({ navigation: {}, history: { length: 2 } })).toBe(true);
  });
});
