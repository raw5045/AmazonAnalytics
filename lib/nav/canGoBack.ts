// lib/nav/canGoBack.ts
/**
 * Whether a history entry sits behind the current one, for the back controls that upgrade a link
 * to router.back() (BackToExplorer, BackToProducts). The Navigation API's `canGoBack` knows the
 * current entry's position: a page opened in a new tab (the Explorer's and the Products list's
 * links do that), then a same-tab hop to another page and the browser's Back, is at the first
 * entry with `history.length` 2, where router.back() would do nothing. Where the API is missing
 * (it is not in TypeScript's DOM types yet, hence the structural parameter), `history.length > 1`
 * is the guess. No imports, so client components can use it freely.
 */
export function canGoBack(win: { navigation?: { canGoBack?: boolean }; history: { length: number } }): boolean {
  return win.navigation?.canGoBack ?? win.history.length > 1;
}
