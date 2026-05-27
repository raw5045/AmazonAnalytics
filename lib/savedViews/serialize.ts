/**
 * URL helpers for saved views.
 *
 * After the v1.1 refactor (chip clears on modify) the only operation
 * left here is building the bookmark URL the dropdown navigates to
 * when a view is picked: `/explorer?view=<id>`.
 *
 * The server (app/explorer/page.tsx) treats that single param as a
 * cue to hydrate filters from the view's stored JSON. Once the user
 * modifies any filter and applies, FilterSidebar produces a URL
 * without the `view=` tag, and the page falls back to URL-as-truth.
 *
 * Earlier helpers (`filtersToSearchParams`, `mergeViewWithUrlParams`,
 * `filtersEqual`) are gone — they belonged to the old "merge baseline
 * + URL overrides" architecture that produced the silent-revert bug
 * the chip-clear behavior obviates.
 */
import type { SavedView } from './types';

/**
 * Construct a `/explorer?view=<id>` href that loads the view in
 * "bookmark form". The server uses the view's stored filters as the
 * source of truth for this URL shape — no inline filter params
 * needed, which keeps the URL clean and unambiguous.
 */
export function buildViewHref(view: Pick<SavedView, 'id'>): string {
  return `/explorer?view=${view.id}`;
}
