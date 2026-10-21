'use client';

import Link, { useLinkStatus } from 'next/link';
import { Check, Search, X } from 'lucide-react';
import type { ReactNode } from 'react';
// Product-filter imports come from filterParams only (./filters carries zod); the row type is a
// type-only import, erased from the bundle.
import { productFiltersToSearchParams, type ProductFilters, type ProductSort } from '@/lib/products/filterParams';
import type { ProductSummaryRow } from '@/lib/products/searchProducts';
import { isAsin } from '@/lib/products/asin';
import { availabilityLabel, formatBadge, formatPriceCents, formatRatio, formatReviewCount, listingAge } from '@/lib/products/format';
import { splitCategoryPath } from '@/lib/categoryBuilder/pathDisplay';
import { formatDay } from '@/lib/format/date';
import { LoadingOverlay } from '@/app/(app)/explorer/LoadingOverlay';
import { SORT_DIR_LABEL, SORT_FIRST_DIR, sortHint } from './ProductFilterPanel';

type Dir = ProductFilters['dir'];
const DASH = '—';

/** The list URL for these filters: the ASIN page's `from`, and the past-the-end "Go to page 1" link. */
function listHref(filters: ProductFilters): string {
  const qs = productFiltersToSearchParams(filters).toString();
  return qs ? `/products?${qs}` : '/products';
}

/** A header's link: the current list with `sort` and `dir` replaced and `page` dropped (a re-sort starts on page 1). */
function sortHref(filters: ProductFilters, sort: ProductSort, dir: Dir): string {
  const params = productFiltersToSearchParams(filters);
  params.set('sort', sort);
  params.set('dir', dir);
  params.delete('page');
  return `/products?${params.toString()}`;
}

/** "1,234 products", "1 product", "10,000+ products" (the count is exact up to PRODUCT_COUNT_CAP). */
function countLabel(total: number, totalIsCapped: boolean): string {
  return `${total.toLocaleString('en-US')}${totalIsCapped ? '+' : ''} ${total === 1 && !totalIsCapped ? 'product' : 'products'}`;
}

/** A formatter's dash in grey, like the explorer's empty cells; any other text as is. */
function orDash(text: string): ReactNode {
  return text === DASH ? <span className="text-gray-400">{DASH}</span> : text;
}

function ariaSort(filters: ProductFilters, sort: ProductSort): 'ascending' | 'descending' | undefined {
  if (filters.sort !== sort) return undefined;
  return filters.dir === 'asc' ? 'ascending' : 'descending';
}

/**
 * Results for /products (spec 2026-10-09 §5.2): the count line, the sort hint, then the table (or
 * the empty state). Thirteen columns in the spec 2026-10-19 §8 order: the magnifier (the row's
 * Amazon link) first, BSR and its 30-day comparison as two columns (a missing comparison is a dash
 * in its own cell), Rating and Reviews as two, and FBA and Amazon as a check / X last. The Leaf
 * category column (spec 2026-10-12 §5.2) shows each product's leaf name, its full path on hover
 * and a dash when unknown, so a filtered list shows why each row is there. A client component only
 * for the sort links' pending overlay (useLinkStatus); the rows arrive as props from the page's
 * server read.
 */
export function ProductResultsTable({
  rows,
  total,
  totalIsCapped,
  filters,
  now,
}: {
  rows: ProductSummaryRow[];
  total: number;
  totalIsCapped: boolean;
  /** The applied filters: the sort headers' state and links, and the product links' `from`. */
  filters: ProductFilters;
  /** The time of the read, for each listing's age. */
  now: Date;
}) {
  const hint = sortHint(filters.sort);
  // The ASIN page's "Back to products" returns to this exact list (page included). Built from the
  // filters alone, so it never carries a `from` of its own.
  const from = encodeURIComponent(listHref(filters));
  return (
    <>
      <div className="mb-3 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <p className="text-sm text-gray-600">{countLabel(total, totalIsCapped)}</p>
        {hint && <p className="text-xs text-gray-500">{hint}</p>}
      </div>
      {rows.length === 0 ? (
        <div className="card-app p-8 text-center text-sm text-gray-500">
          {filters.page > 1 && total > 0 ? (
            <>
              You&apos;re past the last page of results.{' '}
              <Link href={listHref({ ...filters, page: 1 })} replace className="text-blue-700 underline">
                Go to page 1
              </Link>
            </>
          ) : (
            'No products match these filters. Try removing one to broaden the search.'
          )}
        </div>
      ) : (
        <div className="card-app overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-[#F8FAFD] text-left text-slate-500">
              <tr>
                <th className="w-8 p-2">
                  <span className="sr-only">Open on Amazon</span>
                </th>
                <th className="p-2">Product</th>
                <th className="p-2" title="The product's Keepa leaf category; hover a cell for the full path">Leaf category</th>
                <SortHeader filters={filters} sort="sold" label="Monthly sold" align="right" title="Amazon's “bought in past month” badge" />
                <th className="whitespace-nowrap p-2 text-right" title="Average star rating">Rating</th>
                <SortHeader filters={filters} sort="reviews" label="Reviews" align="right" />
                <SortHeader filters={filters} sort="listed" label="Listed" />
                <SortHeader filters={filters} sort="bsr" label="BSR" align="right" title="Best Sellers Rank in the main category" />
                <SortHeader filters={filters} sort="ratio" label="vs 30d avg" align="right" title="BSR vs its 30-day average" />
                <SortHeader filters={filters} sort="price" label="Price" align="right" />
                <SortHeader
                  filters={filters}
                  sort="keywords"
                  label="Keywords"
                  align="right"
                  title="Keywords this product is a top-3 clicked product for this week"
                />
                <th className="p-2 text-center" title="New offers fulfilled by Amazon; hover a cell for the FBA / FBM counts">FBA</th>
                <th className="p-2 text-center" title="Amazon's own offer on the listing">Amazon</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row) => (
                <ProductRow key={row.asin} row={row} from={from} now={now} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function ProductRow({ row, from, now }: { row: ProductSummaryRow; from: string; now: Date }) {
  const name = row.title ?? row.asin;
  // Only an ASIN-shaped value gets links: the ASIN page's route 404s anything else, and /dp/ of a
  // malformed value opens nothing useful.
  const linkable = isAsin(row.asin);
  const offerText = offers(row.fbaOfferCount, row.fbmOfferCount);
  return (
    <tr className="align-top hover:bg-[#F2F7FF]">
      <td className="p-2 text-center">
        {/* The Explorer's magnifier: a plain anchor on purpose (middle-click / ctrl+click stack tabs,
            no popup-blocker involvement); the list stays put. */}
        {linkable && (
          <a
            href={`https://www.amazon.com/dp/${encodeURIComponent(row.asin)}`}
            target="_blank"
            rel="noopener noreferrer nofollow"
            title="Open the listing on Amazon"
            aria-label={`Open ${row.asin} on Amazon`}
            className="inline-flex align-middle text-gray-400 transition-colors hover:text-blue-600"
          >
            <Search className="h-4 w-4" aria-hidden />
          </a>
        )}
      </td>
      <td className="max-w-sm p-2">
        <div className="truncate">
          {/* New tab, like the explorer's keyword links: the filtered list stays put. */}
          {linkable ? (
            <Link
              href={`/products/${row.asin}?from=${from}`}
              target="_blank"
              rel="noopener"
              prefetch={false}
              title={`${name} (opens the product page in a new tab)`}
              className="font-medium text-blue-700 hover:underline focus-visible:underline"
            >
              {name}
            </Link>
          ) : (
            <span className="font-medium text-gray-800" title={name}>
              {name}
            </span>
          )}
        </div>
        <div className="text-xs text-gray-500">
          {row.brand && (
            <>
              <span>{row.brand}</span>
              <span aria-hidden="true"> · </span>
            </>
          )}
          {/* Text, not a link: the magnifier is the row's Amazon link. */}
          <span className="font-mono">{row.asin}</span>
        </div>
      </td>
      <td className="max-w-40 p-2 text-xs text-gray-700" title={row.categoryPath || undefined}>
        {row.categoryPath ? (
          <span className="block truncate leading-5">{splitCategoryPath(row.categoryPath).leaf.trim() || row.categoryPath}</span>
        ) : (
          orDash(DASH)
        )}
      </td>
      <td className="p-2 text-right tabular-nums">{orDash(formatBadge(row.monthlySold))}</td>
      <td className="whitespace-nowrap p-2 text-right tabular-nums">
        <RatingCell ratingX10={row.averageRatingX10} />
      </td>
      <td className="p-2 text-right tabular-nums">{orDash(formatReviewCount(row.reviewCount))}</td>
      <td className="whitespace-nowrap p-2">
        {row.listedSince ? (
          <>
            <div>{formatDay(row.listedSince)}</div>
            <div className="text-xs text-gray-500">{listingAge(row.listedSince, now)}</div>
          </>
        ) : (
          orDash(DASH)
        )}
      </td>
      <td className="p-2 text-right tabular-nums">{row.salesRank === null ? orDash(DASH) : row.salesRank.toLocaleString('en-US')}</td>
      <td className="whitespace-nowrap p-2 text-right tabular-nums">
        <RatioCell ratioX100={row.rankRatioX100} />
      </td>
      <td className="p-2 text-right tabular-nums">{orDash(formatPriceCents(row.currentPriceCents))}</td>
      <td className={`p-2 text-right tabular-nums ${row.keywordCount === 0 ? 'text-gray-400' : ''}`}>{row.keywordCount.toLocaleString('en-US')}</td>
      <td className="p-2 text-center" title={offerText === DASH ? undefined : offerText}>
        <YesNoCell value={row.fbaOfferCount === null ? null : row.fbaOfferCount > 0} />
      </td>
      <td className="p-2 text-center" title={row.amazonAvailability === null ? undefined : availabilityLabel(row.amazonAvailability)}>
        {/* Keepa's code: −1 = no Amazon offer; 0 and above = Amazon has one (in stock, pre-order, unknown, back-order, delayed). */}
        <YesNoCell value={row.amazonAvailability === null ? null : row.amazonAvailability >= 0} />
      </td>
    </tr>
  );
}

/** "★ 4.4" in the keyword page's review style (screen readers skip the star and read "4.4" under the Rating header); a dash without a rating. */
function RatingCell({ ratingX10 }: { ratingX10: number | null }) {
  if (ratingX10 === null) return orDash(DASH);
  return <span className="text-yellow-600"><span aria-hidden="true">★ </span>{(ratingX10 / 10).toFixed(1)}</span>;
}

/** The rank against its 30-day average: a green (better), red (worse) or neutral (at the average) chip; a dash without a comparison. */
function RatioCell({ ratioX100 }: { ratioX100: number | null }) {
  const change = formatRatio(ratioX100);
  if (ratioX100 === null || change === DASH) return orDash(DASH);
  const r = Math.round(ratioX100);
  const tone = r < 100 ? 'bg-emerald-50 text-emerald-700' : r > 100 ? 'bg-rose-50 text-rose-700' : 'bg-slate-100 text-slate-600';
  const reads = r < 100 ? 'ranked better than' : r > 100 ? 'ranked worse than' : 'at';
  return (
    <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${tone}`} title={`BSR vs its 30-day average: ${reads} its average`}>
      {change}
    </span>
  );
}

/** A green check (true), a red X (false) or a dash (unknown); reads as "Yes" / "No" in assistive tech and in tests. */
function YesNoCell({ value }: { value: boolean | null }) {
  if (value === null) return orDash(DASH);
  return value ? (
    <span className="inline-flex align-middle text-emerald-600">
      <Check className="h-4 w-4" aria-hidden />
      <span className="sr-only">Yes</span>
    </span>
  ) : (
    <span className="inline-flex align-middle text-rose-600">
      <X className="h-4 w-4" aria-hidden />
      <span className="sr-only">No</span>
    </span>
  );
}

/** "FBA 3 / FBM 1"; a dash for a count Keepa has not reported. */
function offers(fba: number | null, fbm: number | null): string {
  if (fba === null && fbm === null) return DASH;
  const n = (v: number | null) => (v === null ? DASH : v.toLocaleString('en-US'));
  return `FBA ${n(fba)} / FBM ${n(fbm)}`;
}

function SortHeader({
  filters,
  sort,
  label,
  align = 'left',
  title,
}: {
  filters: ProductFilters;
  sort: ProductSort;
  label: string;
  align?: 'left' | 'right';
  title?: string;
}) {
  return (
    <th className={`whitespace-nowrap p-2 ${align === 'right' ? 'text-right' : ''}`} aria-sort={ariaSort(filters, sort)} title={title}>
      <SortLink filters={filters} sort={sort} label={label} align={align} />
    </th>
  );
}

/**
 * A sortable header as a <Link>: the active column toggles its direction, any other opens at its
 * first direction (SORT_FIRST_DIR, as the panel's sort select does). It replaces the history entry
 * like Apply and the pager. The arrow sits on the label's outer side so numbers stay aligned.
 */
function SortLink({ filters, sort, label, align }: { filters: ProductFilters; sort: ProductSort; label: string; align: 'left' | 'right' }) {
  const active = filters.sort === sort;
  const next: Dir = active ? (filters.dir === 'desc' ? 'asc' : 'desc') : SORT_FIRST_DIR[sort];
  const arrow = (
    <span aria-hidden="true" className={active ? 'font-bold text-blue-700' : 'text-gray-300'}>
      {active ? (filters.dir === 'asc' ? '↑' : '↓') : '↕'}
    </span>
  );
  return (
    <Link
      href={sortHref(filters, sort, next)}
      replace
      scroll={false}
      prefetch={false}
      title={`Sort: ${SORT_DIR_LABEL[sort][next]}`}
      className={`inline-flex items-center gap-1 hover:text-slate-900 ${active ? 'font-semibold text-slate-800' : ''}`}
    >
      {align === 'right' && arrow}
      {label}
      {align !== 'right' && arrow}
      <SortPending />
    </Link>
  );
}

/**
 * While a header's navigation is in flight: the explorer's loading overlay. Click-through
 * (pointer-events-none), since it renders inside the link.
 */
function SortPending() {
  const { pending } = useLinkStatus();
  if (!pending) return null;
  return (
    <span className="pointer-events-none">
      <LoadingOverlay show />
    </span>
  );
}
