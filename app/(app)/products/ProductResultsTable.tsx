'use client';

import Link, { useLinkStatus } from 'next/link';
import type { ReactNode } from 'react';
// Product-filter imports come from filterParams only (./filters carries zod); the row type is a
// type-only import, erased from the bundle.
import { productFiltersToSearchParams, type ProductFilters, type ProductSort } from '@/lib/products/filterParams';
import type { ProductSummaryRow } from '@/lib/products/searchProducts';
import { isAsin } from '@/lib/products/asin';
import { availabilityLabel, formatBadge, formatPriceCents, formatRatio, formatReviewCount, listingAge } from '@/lib/products/format';
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

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "2026-08-01" → "Aug 1, 2026", read off the string (no time zone involved). */
function formatDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  const month = m ? MONTHS[Number(m[2]) - 1] : undefined;
  return m && month ? `${month} ${Number(m[3])}, ${m[1]}` : iso;
}

/** A formatter's dash in grey, like the explorer's empty cells; any other text as is. */
function orDash(text: string): ReactNode {
  return text === DASH ? <span className="text-gray-400">{DASH}</span> : text;
}

function ariaSort(filters: ProductFilters, sorts: ProductSort[]): 'ascending' | 'descending' | undefined {
  if (!sorts.includes(filters.sort)) return undefined;
  return filters.dir === 'asc' ? 'ascending' : 'descending';
}

/**
 * Results for /products (spec 2026-10-09 §5.2): the count line, the sort hint, then the table (or
 * the empty state). A client component only for the sort links' pending overlay (useLinkStatus);
 * the rows arrive as props from the page's server read.
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
                <th className="p-2">Product</th>
                <SortHeader filters={filters} sort="listed" label="Listed" />
                <SortHeader filters={filters} sort="sold" label="Monthly sold" align="right" title="Amazon's “bought in past month” badge" />
                <SortHeader filters={filters} sort="reviews" label="Reviews" align="right" />
                <SortHeader filters={filters} sort="price" label="Price" align="right" />
                <th className="whitespace-nowrap p-2 text-right" aria-sort={ariaSort(filters, ['bsr', 'ratio'])}>
                  <SortLink filters={filters} sort="bsr" label="BSR" align="right" />
                  <span aria-hidden="true" className="mx-1 text-slate-300">·</span>
                  <SortLink filters={filters} sort="ratio" label="vs 30d avg" align="right" />
                </th>
                <th className="p-2" title="New offers: fulfilled by Amazon / by the merchant">Offers</th>
                <th className="p-2" title="Amazon's own offer on the listing">Amazon</th>
                <SortHeader
                  filters={filters}
                  sort="keywords"
                  label="Keywords"
                  align="right"
                  title="Keywords this product is a top-3 clicked product for this week"
                />
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
  return (
    <tr className="align-top hover:bg-[#F2F7FF]">
      <td className="max-w-sm p-2">
        <div className="truncate">
          {/* New tab, like the explorer's keyword links: the filtered list stays put. Only an
              ASIN-shaped value gets the link: the ASIN page's route 404s anything else. */}
          {isAsin(row.asin) ? (
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
          <a
            href={`https://www.amazon.com/dp/${encodeURIComponent(row.asin)}`}
            target="_blank"
            rel="noopener noreferrer"
            title="Open the listing on Amazon"
            className="font-mono hover:underline"
          >
            {row.asin}
          </a>
        </div>
      </td>
      <td className="whitespace-nowrap p-2">
        {row.listedSince ? (
          <>
            <div>{formatDate(row.listedSince)}</div>
            <div className="text-xs text-gray-500">{listingAge(row.listedSince, now)}</div>
          </>
        ) : (
          orDash(DASH)
        )}
      </td>
      <td className="p-2 text-right tabular-nums">{orDash(formatBadge(row.monthlySold))}</td>
      <td className="whitespace-nowrap p-2 text-right tabular-nums">
        <ReviewsCell count={row.reviewCount} ratingX10={row.averageRatingX10} />
      </td>
      <td className="p-2 text-right tabular-nums">{orDash(formatPriceCents(row.currentPriceCents))}</td>
      <td className="whitespace-nowrap p-2 text-right tabular-nums">
        <BsrCell rank={row.salesRank} ratioX100={row.rankRatioX100} />
      </td>
      <td className="whitespace-nowrap p-2 tabular-nums">{orDash(offers(row.fbaOfferCount, row.fbmOfferCount))}</td>
      <td className="p-2 text-gray-700">{orDash(availabilityLabel(row.amazonAvailability))}</td>
      <td className={`p-2 text-right tabular-nums ${row.keywordCount === 0 ? 'text-gray-400' : ''}`}>{row.keywordCount.toLocaleString('en-US')}</td>
    </tr>
  );
}

/** "120 · ★ 4.4", the keyword page's review style; no stars without a rating. */
function ReviewsCell({ count, ratingX10 }: { count: number | null; ratingX10: number | null }) {
  if (count === null) return orDash(DASH);
  return (
    <>
      {formatReviewCount(count)}
      {ratingX10 !== null && (
        <>
          {' · '}
          <span className="text-yellow-600">★ {(ratingX10 / 10).toFixed(1)}</span>
        </>
      )}
    </>
  );
}

/** The rank, plus its change against the 30-day average as a chip: green when better, red when worse, none when level. */
function BsrCell({ rank, ratioX100 }: { rank: number | null; ratioX100: number | null }) {
  const change = formatRatio(ratioX100);
  const chip =
    ratioX100 !== null && change !== DASH && change !== '0%' ? (
      <span
        title="BSR vs its 30-day average"
        className={`ml-1.5 rounded px-1.5 py-0.5 text-xs font-medium ${ratioX100 < 100 ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}
      >
        {change}
      </span>
    ) : null;
  if (rank === null && chip === null) return orDash(DASH);
  return (
    <>
      {rank === null ? orDash(DASH) : rank.toLocaleString('en-US')}
      {chip}
    </>
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
    <th className={`whitespace-nowrap p-2 ${align === 'right' ? 'text-right' : ''}`} aria-sort={ariaSort(filters, [sort])} title={title}>
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
