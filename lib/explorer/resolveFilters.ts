import { parseExplorerFilters, type SearchParamsLike } from './parseFilters';
import type { ExplorerFilters } from './types';
import type { SavedView } from '@/lib/savedViews/types';

/**
 * URL keys that OVERLAY a saved view instead of replacing it. SortableHeader,
 * PaginationControls and JumpToPage keep the current URL and set one of these, so
 * `/explorer?view=<id>&sort=imp` must still mean "the view, sorted" and
 * `?view=<id>&page=2` "the view, page 2". Any other key is a filter param: the
 * member changed the view's criteria (FilterSidebar's Apply drops the view tag),
 * or a hybrid URL arrived from elsewhere — in both cases the URL is the source of
 * truth and the view tag is metadata only. (Until 2026-10-01 the page read `sort`
 * as a filter — the whole catalogue, sorted, under the view's name — and dropped
 * `page` in favour of the stored `page: 1`.)
 */
export const VIEW_OVERLAY_KEYS = ['sort', 'page', 'per_page'] as const;

export interface ResolvedExplorerFilters {
  filters: ExplorerFilters;
  /** True when `filters` came from the view's stored JSON (with overlays applied). */
  fromView: boolean;
}

/** Pure: no I/O. `activeView` is the already-loaded, owner-scoped view for `sp.view`, or null. */
export function resolveExplorerFilters(sp: SearchParamsLike, activeView: SavedView | null): ResolvedExplorerFilters {
  const extraKeys = Object.keys(sp).filter((k) => k !== 'view' && sp[k] !== undefined);
  const onlyOverlays = extraKeys.every((k) => (VIEW_OVERLAY_KEYS as readonly string[]).includes(k));
  if (!activeView || !onlyOverlays) return { filters: parseExplorerFilters(sp), fromView: false };
  // The overlays go through the same parser as a full URL, so they are validated the
  // same way (bad sort → default sort). The page is clamped to MAX_EXPLORER_OFFSET
  // against the page size the result uses — the URL's per_page if present, else the
  // view's own — so the clamp holds whatever page size the view stores.
  const overlay = parseExplorerFilters({ ...sp, per_page: sp.per_page ?? String(activeView.filters.perPage) });
  return {
    filters: {
      ...activeView.filters,
      ...(sp.sort !== undefined ? { sort: overlay.sort } : {}),
      ...(sp.page !== undefined ? { page: overlay.page } : {}),
      ...(sp.per_page !== undefined ? { perPage: overlay.perPage } : {}),
    },
    fromView: true,
  };
}
