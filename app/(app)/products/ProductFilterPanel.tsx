'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition, type FormEvent, type ReactNode } from 'react';
import {
  PRODUCT_AGES,
  PRODUCT_DEFAULTS,
  PRODUCT_SORTS,
  productFiltersToSearchParams,
  type ProductFilters,
  type ProductSort,
} from '@/lib/products/filters';
import { SORT_KEY_LABEL, sortHidesNullKey } from '@/lib/products/searchProducts';
import { formatBadge } from '@/lib/products/format';
import { LeafCategoryTypeahead } from '@/app/(app)/explorer/LeafCategoryTypeahead';
import { LoadingOverlay } from '@/app/(app)/explorer/LoadingOverlay';

/** "Bought in past month" badge floors offered as the monthly-sold minimum. */
export const SOLD_BUCKETS: readonly number[] = [50, 100, 200, 300, 400, 500, 1000, 2000, 5000, 10000];
/** rank_ratio_x100 caps offered for "BSR vs 30-day avg": 90 = ranked at least 10% better than its 30-day average. */
const RATIO_PRESETS: readonly number[] = [90, 70, 50];

export const SORT_LABEL: Readonly<Record<ProductSort, string>> = {
  sold: 'Monthly sold', listed: 'Listing date', reviews: 'Review count', price: 'Price', bsr: 'BSR', ratio: 'BSR vs 30-day avg', keywords: 'Top-3 keywords',
};

/** How each sort reads in each direction: the direction select's options, and the table headers' link titles. */
export const SORT_DIR_LABEL: Readonly<Record<ProductSort, Readonly<Record<ProductFilters['dir'], string>>>> = {
  sold: { desc: 'Most sold first', asc: 'Least sold first' },
  listed: { desc: 'Newest first', asc: 'Oldest first' },
  reviews: { desc: 'Most reviews first', asc: 'Fewest reviews first' },
  price: { desc: 'Highest price first', asc: 'Lowest price first' },
  bsr: { desc: 'Worst rank first', asc: 'Best rank first' },
  ratio: { desc: 'Least improved first', asc: 'Most improved first' },
  keywords: { desc: 'Most keywords first', asc: 'Fewest keywords first' },
};

/**
 * The line shown under the sort control and above the table for every sort that hides products
 * whose sort key is missing (sortHidesNullKey, the rule the search statement applies), so a sort
 * never drops rows without the page saying so.
 */
export function sortHint(sort: ProductSort): string | null {
  return sortHidesNullKey(sort) ? `Products without a ${SORT_KEY_LABEL[sort]} are hidden under this sort.` : null;
}

/** "BSR vs 30-day avg" option text for a rank_ratio_x100 cap. */
function ratioLabel(ratioMax: number): string {
  if (ratioMax < 100) return `At least ${100 - ratioMax}% better`;
  if (ratioMax === 100) return 'No worse than average';
  return `At most ${ratioMax - 100}% worse`;
}

/** The panel's editable state: inputs as typed (stars, dollars), selects as their option values ('' = Any). */
export interface PendingProductFilters {
  age: string;
  soldMin: string;
  reviewsMax: string;
  ratingMin: string;
  ratingMax: string;
  priceMin: string;
  priceMax: string;
  bsrMin: string;
  bsrMax: string;
  ratioMax: string;
  cat: string | null;
  fba: '' | 'yes' | 'no';
  amazon: '' | 'yes' | 'no';
  sort: ProductSort;
  dir: ProductFilters['dir'];
}

const asText = (n: number | null): string => (n === null ? '' : String(n));
/** 40 → "4.0" stars. */
const asStars = (x10: number | null): string => (x10 === null ? '' : (x10 / 10).toFixed(1));
/** 999 → "9.99", 3000 → "30": the URL's own dollar form. */
const asDollars = (cents: number | null): string => (cents === null ? '' : (cents / 100).toFixed(2).replace(/\.00$/, ''));

export function filtersToPending(f: ProductFilters): PendingProductFilters {
  return {
    age: asText(f.age),
    soldMin: asText(f.soldMin),
    reviewsMax: asText(f.reviewsMax),
    ratingMin: asStars(f.ratingMin),
    ratingMax: asStars(f.ratingMax),
    priceMin: asDollars(f.priceMinCents),
    priceMax: asDollars(f.priceMaxCents),
    bsrMin: asText(f.bsrMin),
    bsrMax: asText(f.bsrMax),
    ratioMax: asText(f.ratioMax),
    cat: f.cat,
    fba: f.fba ?? '',
    amazon: f.amazon ?? '',
    sort: f.sort,
    dir: f.dir,
  };
}

/** The typed number, or null when blank or not a number. */
function toNumber(s: string): number | null {
  const t = s.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Stars → ×10, dollars → cents. */
function toScaled(s: string, factor: number): number | null {
  const n = toNumber(s);
  return n === null ? null : Math.round(n * factor);
}

/**
 * The ProductFilters the pending state stands for, on page 1. It converts and validates nothing:
 * the URL it becomes goes through parseProductFilters on the server, where a value outside a
 * field's bounds falls back to that field's default and every other filter is kept.
 */
export function pendingToFilters(p: PendingProductFilters): ProductFilters {
  return {
    age: PRODUCT_AGES.find((a) => String(a) === p.age) ?? null,
    soldMin: toNumber(p.soldMin),
    reviewsMax: toNumber(p.reviewsMax),
    ratingMin: toScaled(p.ratingMin, 10),
    ratingMax: toScaled(p.ratingMax, 10),
    priceMinCents: toScaled(p.priceMin, 100),
    priceMaxCents: toScaled(p.priceMax, 100),
    bsrMin: toNumber(p.bsrMin),
    bsrMax: toNumber(p.bsrMax),
    ratioMax: toNumber(p.ratioMax),
    cat: p.cat,
    fba: p.fba === '' ? null : p.fba,
    amazon: p.amazon === '' ? null : p.amazon,
    sort: p.sort,
    dir: p.dir,
    page: 1,
  };
}

/** A select's preset values plus the current one when a hand-edited URL holds a value the presets lack. */
function withCurrent(presets: readonly number[], current: string, order: (a: number, b: number) => number): number[] {
  const n = toNumber(current);
  return n === null || presets.includes(n) ? [...presets] : [...presets, n].sort(order);
}

/** Same look as the explorer sidebar's .filter-input; red while the browser reads the value as invalid. */
const INPUT =
  'w-full min-w-0 rounded-lg border border-slate-300 bg-white px-[9px] py-[5px] text-[13px] focus:outline-2 focus:-outline-offset-1 focus:outline-blue-500 invalid:border-rose-400';
const LABEL = 'mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500';
const HINT = 'mt-1 text-xs text-gray-500';

/**
 * Filter panel for /products (spec 2026-10-09 §5.1), built like the explorer's FilterSidebar: local
 * state seeded from the applied filters (the page keys it by them, so a header re-sort re-seeds it),
 * Apply / Reset inside a transition with the LoadingOverlay. Apply builds a ProductFilters object
 * and replaces the URL with productFiltersToSearchParams of it, back on page 1.
 */
export function ProductFilterPanel({ filters, leafCategories }: { filters: ProductFilters; leafCategories: string[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [pending, setPending] = useState<PendingProductFilters>(() => filtersToPending(filters));

  const set = <K extends keyof PendingProductFilters>(key: K, value: PendingProductFilters[K]) => {
    setPending((p) => ({ ...p, [key]: value }));
  };

  // Dirty = the URL Apply would produce differs from the applied one (so "4" vs "4.0" is no change).
  const appliedQuery = productFiltersToSearchParams({ ...filters, page: 1 }).toString();
  const nextQuery = productFiltersToSearchParams(pendingToFilters(pending)).toString();
  const dirty = nextQuery !== appliedQuery;

  const apply = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!dirty || isPending) return;
    startTransition(() => {
      router.replace(nextQuery ? `/products?${nextQuery}` : '/products', { scroll: false });
    });
  };

  const reset = () => {
    setPending(filtersToPending(PRODUCT_DEFAULTS));
    startTransition(() => {
      router.replace('/products', { scroll: false });
    });
  };

  const hint = sortHint(pending.sort);
  const soldOptions = withCurrent(SOLD_BUCKETS, pending.soldMin, (a, b) => a - b);
  const ratioOptions = withCurrent(RATIO_PRESETS, pending.ratioMax, (a, b) => b - a);

  return (
    <>
      <LoadingOverlay show={isPending} />
      <aside className="sticky top-[52px] flex h-[calc(100vh-52px)] w-72 shrink-0 flex-col self-start border-r border-slate-200 bg-white">
        {/* noValidate: nothing here blocks Apply; the server parse decides what a value means. */}
        <form noValidate onSubmit={apply} aria-label="Product filters" className="flex min-h-0 flex-1 flex-col">
          <div className="flex-1 space-y-5 overflow-y-auto p-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-700">Filters</h2>
              {isPending && <span className="text-xs text-gray-400">Updating…</span>}
            </div>

            <Field label="Sort" htmlFor="pf-sort">
              <select id="pf-sort" value={pending.sort} onChange={(e) => set('sort', e.target.value as ProductSort)} className={INPUT}>
                {PRODUCT_SORTS.map((s) => (
                  <option key={s} value={s}>
                    {SORT_LABEL[s]}
                  </option>
                ))}
              </select>
              <select
                aria-label="Sort direction"
                value={pending.dir}
                onChange={(e) => set('dir', e.target.value as ProductFilters['dir'])}
                className={`${INPUT} mt-2`}
              >
                <option value="desc">{SORT_DIR_LABEL[pending.sort].desc}</option>
                <option value="asc">{SORT_DIR_LABEL[pending.sort].asc}</option>
              </select>
              {hint && <p className={HINT}>{hint}</p>}
            </Field>

            <Field label="Listing age" htmlFor="pf-age">
              <select id="pf-age" value={pending.age} onChange={(e) => set('age', e.target.value)} className={INPUT}>
                <option value="">Any</option>
                {PRODUCT_AGES.map((days) => (
                  <option key={days} value={String(days)}>
                    {`Listed within ${days} days`}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Monthly sold (at least)" htmlFor="pf-sold">
              <select id="pf-sold" value={pending.soldMin} onChange={(e) => set('soldMin', e.target.value)} className={INPUT}>
                <option value="">Any</option>
                {soldOptions.map((n) => (
                  <option key={n} value={String(n)}>
                    {formatBadge(n)}
                  </option>
                ))}
              </select>
              <p className={HINT}>Amazon&apos;s &ldquo;bought in past month&rdquo; badge.</p>
            </Field>

            <Field label="Reviews (at most)" htmlFor="pf-reviews">
              <input
                id="pf-reviews"
                type="number"
                min={0}
                step={1}
                value={pending.reviewsMax}
                onChange={(e) => set('reviewsMax', e.target.value)}
                placeholder="e.g. 300"
                className={INPUT}
              />
            </Field>

            <RangeField id="pf-rating" label="Rating (stars)">
              <input
                type="number"
                min={0}
                max={5}
                step={0.1}
                aria-label="Minimum rating"
                value={pending.ratingMin}
                onChange={(e) => set('ratingMin', e.target.value)}
                placeholder="Min (e.g. 4)"
                className={INPUT}
              />
              <input
                type="number"
                min={0}
                max={5}
                step={0.1}
                aria-label="Maximum rating"
                value={pending.ratingMax}
                onChange={(e) => set('ratingMax', e.target.value)}
                placeholder="Max (5)"
                className={INPUT}
              />
            </RangeField>

            <RangeField id="pf-price" label="Price ($)">
              <input
                type="number"
                min={0}
                step={0.01}
                aria-label="Minimum price"
                value={pending.priceMin}
                onChange={(e) => set('priceMin', e.target.value)}
                placeholder="Min"
                className={INPUT}
              />
              <input
                type="number"
                min={0}
                step={0.01}
                aria-label="Maximum price"
                value={pending.priceMax}
                onChange={(e) => set('priceMax', e.target.value)}
                placeholder="Max"
                className={INPUT}
              />
            </RangeField>

            <RangeField id="pf-bsr" label="BSR (main category)" hint="Best Sellers Rank: lower sells more.">
              <input
                type="number"
                min={1}
                step={1}
                aria-label="Minimum BSR"
                value={pending.bsrMin}
                onChange={(e) => set('bsrMin', e.target.value)}
                placeholder="From (1)"
                className={INPUT}
              />
              <input
                type="number"
                min={1}
                step={1}
                aria-label="Maximum BSR"
                value={pending.bsrMax}
                onChange={(e) => set('bsrMax', e.target.value)}
                placeholder="To (e.g. 50000)"
                className={INPUT}
              />
            </RangeField>

            <Field label="BSR vs 30-day avg" htmlFor="pf-ratio">
              <select id="pf-ratio" value={pending.ratioMax} onChange={(e) => set('ratioMax', e.target.value)} className={INPUT}>
                <option value="">Any</option>
                {ratioOptions.map((r) => (
                  <option key={r} value={String(r)}>
                    {ratioLabel(r)}
                  </option>
                ))}
              </select>
              <p className={HINT}>Today&apos;s BSR against its own 30-day average.</p>
            </Field>

            <Field label="Category">
              <LeafCategoryTypeahead
                options={leafCategories}
                selected={pending.cat ? [pending.cat] : []}
                // One category: the typeahead appends a pick, so the newest pick replaces the old one.
                onChange={(next) => set('cat', next.length > 0 ? next[next.length - 1] : null)}
              />
              <p className={HINT}>One category; picking another replaces it.</p>
            </Field>

            <Field label="FBA offer" htmlFor="pf-fba">
              <select id="pf-fba" value={pending.fba} onChange={(e) => set('fba', e.target.value as PendingProductFilters['fba'])} className={INPUT}>
                <option value="">Any</option>
                <option value="yes">Present</option>
                <option value="no">None</option>
              </select>
            </Field>

            <Field label="Amazon selling" htmlFor="pf-amazon">
              <select
                id="pf-amazon"
                value={pending.amazon}
                onChange={(e) => set('amazon', e.target.value as PendingProductFilters['amazon'])}
                className={INPUT}
              >
                <option value="">Any</option>
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </select>
            </Field>
          </div>

          {/* Sticky footer with Apply / Reset, as in the explorer sidebar. */}
          <div className="flex items-center gap-2 border-t bg-white p-3 shadow-[0_-2px_4px_rgba(0,0,0,0.04)]">
            <button
              type="submit"
              disabled={!dirty || isPending}
              className="flex-1 rounded-full bg-amber-300 px-3 py-2 text-sm font-semibold text-[#0B1E3A] hover:bg-amber-200 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
            >
              {isPending ? 'Applying…' : dirty ? 'Apply filters' : 'Filters applied'}
            </button>
            <button type="button" onClick={reset} className="text-xs text-gray-600 underline hover:text-gray-900">
              Reset
            </button>
          </div>
        </form>
      </aside>
    </>
  );
}

function Field({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div>
      {htmlFor ? (
        <label htmlFor={htmlFor} className={LABEL}>
          {label}
        </label>
      ) : (
        <p className={LABEL}>{label}</p>
      )}
      {children}
    </div>
  );
}

/** A min / max pair under one heading; each input carries its own aria-label. */
function RangeField({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <div role="group" aria-labelledby={id}>
      <p id={id} className={LABEL}>
        {label}
      </p>
      <div className="flex gap-2">{children}</div>
      {hint && <p className={HINT}>{hint}</p>}
    </div>
  );
}
