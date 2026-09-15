/**
 * ET (America/New_York) calendar-day helpers for the activity counters and
 * the abuse digest. `Intl` owns the DST rules; the day arithmetic is pure
 * calendar math on the resulting Y-M-D (in UTC space) so it is immune to
 * 23h/25h ET days.
 */
const ET_DATE_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The ET calendar date of `date`, as 'YYYY-MM-DD'. */
export function etDay(date: Date): string {
  return ET_DATE_FMT.format(date); // en-CA formats as YYYY-MM-DD
}

/** The ET calendar date one day before `date`'s ET calendar date. */
export function previousEtDay(date: Date): string {
  return addDays(etDay(date), -1);
}

/**
 * `day` ('YYYY-MM-DD') shifted by `deltaDays` calendar days, as 'YYYY-MM-DD'.
 * Pure calendar arithmetic in UTC space (Date.UTC normalizes day overflow and
 * underflow across month and year ends), so no timezone or DST rule can make
 * the result anything other than exactly N calendar days away.
 */
export function addDays(day: string, deltaDays: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d + deltaDays));
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(shifted.getUTCDate()).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${mm}-${dd}`;
}
