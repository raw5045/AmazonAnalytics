// lib/format/date.ts
/**
 * Date display shared by the app's pages (spec 2026-10-21 product page round 1 §2): every stored
 * date (YYYY-MM-DD, or an ISO timestamp) reads as "Oct 17, 2026". Pure and clock-free: the text is
 * read off the string, so the server and the browser render the same thing and no time zone is
 * involved. Anything that does not start with a YYYY-MM-DD whose month is 01–12 comes back
 * unchanged; the day is not range-checked (the inputs are Postgres dates and toISOString() output).
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** "2026-10-17" or "2026-10-17T06:00:00.000Z" → "Oct 17, 2026"; other input unchanged. */
export function formatDay(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?!\d)/.exec(iso);
  const month = m ? MONTHS[Number(m[2]) - 1] : undefined;
  return m && month ? `${month} ${Number(m[3])}, ${m[1]}` : iso;
}

/**
 * A toISOString() timestamp "2026-10-04T06:00:12.345Z" → "Oct 4, 2026 06:00 UTC" (the clock is read
 * as written, so only UTC input is right); a date without a clock → formatDay(iso); input formatDay
 * rejects comes back unchanged.
 */
export function formatFetchTime(iso: string): string {
  const day = formatDay(iso);
  const clock = /^\d{4}-\d{2}-\d{2}T(\d{2}:\d{2})/.exec(iso);
  return clock && day !== iso ? `${day} ${clock[1]} UTC` : day;
}
