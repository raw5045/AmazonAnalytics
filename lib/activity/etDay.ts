/**
 * ET (America/New_York) calendar-day helpers for the activity counters and
 * the abuse digest. `Intl` owns the DST rules; `previousEtDay` does pure
 * calendar arithmetic on the resulting Y-M-D (in UTC space) so it is
 * immune to 23h/25h ET days.
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
  const [y, m, d] = etDay(date).split('-').map(Number);
  const prev = new Date(Date.UTC(y, m - 1, d) - 24 * 60 * 60 * 1000);
  const mm = String(prev.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(prev.getUTCDate()).padStart(2, '0');
  return `${prev.getUTCFullYear()}-${mm}-${dd}`;
}
