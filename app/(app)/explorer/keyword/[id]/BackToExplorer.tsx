'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';

/**
 * Should "Back to explorer" restore the previous page from the browser's
 * back/forward cache (`router.back()`, instant) instead of doing a fresh
 * `<Link>` navigation that re-runs the explorer's server query?
 *
 * A fresh navigation to `/explorer?…` re-executes `runExplorerQuery`, which is
 * slow on a cold cache (the same cost the browser back button avoids by
 * restoring the cached page). So we prefer `router.back()` — but ONLY when:
 *  - we actually arrived from the explorer (so `back()` lands there), and
 *  - there's a history entry behind us (not a direct entry / fresh tab, where
 *    `back()` would leave the app entirely).
 */
export function shouldRestoreViaBack(
  cameFromExplorer: boolean,
  historyLength: number,
): boolean {
  return cameFromExplorer && historyLength > 1;
}

/**
 * "← Back to explorer" control on the keyword detail page.
 *
 * Renders a real `<Link href>` so SSR, no-JS, and modifier-click ("open in new
 * tab") all keep working and the fallback URL is correct. On a plain left
 * click, when we know the user came from the explorer, it upgrades to
 * `router.back()` so the explorer is restored instantly from the client cache —
 * matching the browser back button — instead of paying a cold re-render.
 */
export function BackToExplorer({
  href,
  cameFromExplorer,
}: {
  /** Fallback explorer URL — used for direct entry / new tab / no history. */
  href: string;
  /** True when the inbound navigation came from the explorer. */
  cameFromExplorer: boolean;
}) {
  const router = useRouter();

  function handleClick(e: React.MouseEvent<HTMLAnchorElement>) {
    // Let the browser handle modified / non-primary clicks (open in new tab,
    // download, etc.) — only intercept a plain left click.
    if (
      e.defaultPrevented ||
      e.button !== 0 ||
      e.metaKey ||
      e.ctrlKey ||
      e.shiftKey ||
      e.altKey
    ) {
      return;
    }
    if (shouldRestoreViaBack(cameFromExplorer, window.history.length)) {
      e.preventDefault();
      router.back();
    }
  }

  return (
    <Link
      href={href}
      onClick={handleClick}
      prefetch={false}
      className="text-sm underline text-gray-600 hover:text-gray-900"
    >
      ← Back to explorer
    </Link>
  );
}
