'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';

/**
 * The ASIN page's back control: BackToExplorer's mechanics (app/(app)/explorer/keyword/[id]/
 * BackToExplorer.tsx) for the two pages that open an ASIN page.
 *
 * `?from=` is accepted in two same-origin shapes only:
 *  - the products list, `/products` or `/products?…` → "Back to products";
 *  - a keyword page, exactly `/explorer/keyword/<uuid>` (what the keyword page's link-back sends,
 *    percent-encoded) → "Back to keyword".
 * Anything else (absent, another origin, another path, or a `from` that carries its own `from`) is
 * a plain link to `/products`. `from` is never nested: an accepted value carries no `from` of its
 * own, and the href is the accepted value as is.
 */

// Case-sensitive path, hex digits of either case in the uuid (the keyword page's own id check is case-insensitive).
const KEYWORD_PAGE_RE =
  /^\/explorer\/keyword\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const PRODUCTS_LIST = '/products';

export interface ProductBackTarget {
  href: string;
  label: 'Back to products' | 'Back to keyword';
  /** True when `from` names a page we accept, so router.back() returns to it. */
  cameFromPage: boolean;
}

const FALLBACK: ProductBackTarget = { href: PRODUCTS_LIST, label: 'Back to products', cameFromPage: false };

export function resolveProductBack(from: string | null | undefined): ProductBackTarget {
  if (typeof from !== 'string') return FALLBACK;
  if (KEYWORD_PAGE_RE.test(from)) return { href: from, label: 'Back to keyword', cameFromPage: true };
  if (from === PRODUCTS_LIST) return { href: from, label: 'Back to products', cameFromPage: true };
  if (from.startsWith(`${PRODUCTS_LIST}?`) && !new URLSearchParams(from.slice(PRODUCTS_LIST.length + 1)).has('from')) {
    return { href: from, label: 'Back to products', cameFromPage: true };
  }
  return FALLBACK;
}

/**
 * Whether a history entry sits behind the current one. The Navigation API's `canGoBack` knows the
 * current entry's position: a page opened in a new tab (the Products list's links do that), then a
 * same-tab hop to a keyword page and the browser's Back, is at the first entry with
 * `history.length` 2, where router.back() would do nothing. Where the API is missing (it is not in
 * TypeScript's DOM types yet, hence the structural parameter), `history.length > 1` is the guess.
 */
export function canGoBack(win: { navigation?: { canGoBack?: boolean }; history: { length: number } }): boolean {
  return win.navigation?.canGoBack ?? win.history.length > 1;
}

/**
 * Restore the previous page with router.back() (instant, from the client cache, like the browser's
 * back button) instead of a fresh navigation that re-runs its server query, but only when we came
 * from an accepted page and a history entry sits behind us (a direct entry or a new tab has none,
 * so back() would leave the app or do nothing); otherwise the plain link navigates.
 */
export function shouldRestoreViaBack(cameFromPage: boolean, hasEntryBehind: boolean): boolean {
  return cameFromPage && hasEntryBehind;
}

/**
 * A real `<Link href>`, so SSR, no-JS and modifier clicks (open in a new tab) keep working with the
 * right fallback URL; a plain left click upgrades to router.back() when shouldRestoreViaBack says so.
 */
export function BackToProducts({ from }: { from?: string }) {
  const router = useRouter();
  const target = resolveProductBack(from);

  function handleClick(e: React.MouseEvent<HTMLAnchorElement>) {
    // Leave modified and non-primary clicks (new tab, download, …) to the browser.
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (shouldRestoreViaBack(target.cameFromPage, canGoBack(window))) {
      e.preventDefault();
      router.back();
    }
  }

  return (
    <Link
      href={target.href}
      onClick={handleClick}
      prefetch={false}
      className="text-sm text-slate-300 underline hover:text-white"
    >
      ← {target.label}
    </Link>
  );
}
