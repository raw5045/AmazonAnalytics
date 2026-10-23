// lib/products/format.ts
/**
 * Display formatters shared by the Products page, the ASIN page and the research tools (spec
 * 2026-10-09 §5.2, §6). Pure: no React, no I/O, no clock (listingAge takes `now`). A missing value
 * is a dash. Counts use explicit en-US separators so the server and the browser render the same text.
 */
const DASH = '—';
const MINUS = String.fromCodePoint(0x2212); // the real minus sign, not a hyphen
const DAY_MS = 86_400_000;

const finite = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n);

/** Amazon's "bought in past month" badge is a floor: 1000 → "1,000+". */
export function formatBadge(n: number | null): string {
  return finite(n) ? `${n.toLocaleString('en-US')}+` : DASH;
}

/**
 * Sales rank against its own 30-day average, from rank_ratio_x100 (100 × rank ÷ average): the
 * percentage change, so 65 → "−35%" (ranked 35 % better than its average), 130 → "+30%".
 */
export function formatRatio(ratioX100: number | null): string {
  if (!finite(ratioX100)) return DASH;
  const change = Math.round(ratioX100) - 100;
  if (change === 0) return '0%';
  return `${change < 0 ? MINUS : '+'}${Math.abs(change).toLocaleString('en-US')}%`;
}

const AVAILABILITY = new Map<number, string>([
  [-1, 'No Amazon offer'],
  [0, 'In stock'],
  [1, 'Pre-order'],
  [2, 'Unknown'],
  [3, 'Back-order'],
  [4, 'Delayed'],
]);

/** Keepa's Amazon-offer availability code as text. A missing value is a dash; a code Keepa has not documented is "Unknown". */
export function availabilityLabel(code: number | null): string {
  return finite(code) ? (AVAILABILITY.get(code) ?? 'Unknown') : DASH;
}

/**
 * How long ago a listing started, as of `now` (spec 2026-10-23 listing age §1): "245 days" under a
 * year; from a year on, whole calendar years since the listing date and the days since that
 * anniversary, "1 year, 245 days", or just "2 years" on the anniversary itself. `date` is a
 * YYYY-MM-DD string; a date after `now` reads as 0 days (never negative); null, a value not starting
 * YYYY-MM-DD, or an invalid `now` reads as the dash. A Feb 29 listing takes Mar 1 as its anniversary
 * in a non-leap year (what Date.UTC does with day 29 of February).
 *
 * Days are counted on the UTC calendar. That agrees with the Products page's age filter
 * (`listed_since >= current_date - N`) on one assumption: `current_date` there is evaluated in the
 * database session's time zone, which is UTC on Neon. If that ever changed, this count and the
 * filter would disagree by a day for part of each day.
 */
export function listingAge(date: string | null, now: Date): string {
  const m = date === null ? null : /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!m) return DASH;
  const year = Number(m[1]);
  const month = Number(m[2]) - 1;
  const day = Number(m[3]);
  const listed = Date.UTC(year, month, day);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (!Number.isFinite(listed) || !Number.isFinite(today)) return DASH;
  if (today <= listed) return '0 days';
  let years = now.getUTCFullYear() - year;
  let anniversary = Date.UTC(year + years, month, day);
  if (anniversary > today) {
    years -= 1;
    anniversary = Date.UTC(year + years, month, day);
  }
  const days = Math.round((today - anniversary) / DAY_MS);
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (years <= 0) return unit(days, 'day');
  return days === 0 ? unit(years, 'year') : `${unit(years, 'year')}, ${unit(days, 'day')}`;
}

/** 1999 → "$19.99". */
export function formatPriceCents(cents: number | null): string {
  if (!finite(cents)) return DASH;
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Compact review count: 1834 → "1.8k", 1.2 million → "1.2M"; under a thousand it is the plain count. */
export function formatReviewCount(n: number | null): string {
  if (!finite(n)) return DASH;
  if (n < 1000) return n.toLocaleString('en-US');
  // 999,950 and up would round to "1000.0k" at one decimal, so they read as millions.
  return n < 999_950 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * Estimated monthly searches in the keyword page's headline format (its local formatHeadlineVolume,
 * app/(app)/explorer/keyword/[id]/page.tsx), so a volume reads the same on both pages: the exact
 * count with thousands separators, then " / mo". The original formats with the runtime's default
 * locale (en-US on the server); this one pins en-US so the server and the browser agree. The caller
 * adds the "~" that marks an estimate, as the keyword page does. A missing estimate is a dash.
 */
export function formatVolume(n: number | null): string {
  return finite(n) ? `${n.toLocaleString('en-US')} / mo` : DASH;
}
