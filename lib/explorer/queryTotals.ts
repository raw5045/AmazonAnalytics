/**
 * Pure total-resolution helpers for runExplorerQuery, split out so they
 * carry no env/neon import and can be unit-tested directly.
 */
import { COUNT_CAP } from './buildQuery';

/** Apply the pagination display cap. */
export function applyCountCap(rawTotal: number): { total: number; totalIsCapped: boolean } {
  const totalIsCapped = rawTotal > COUNT_CAP;
  return { total: totalIsCapped ? COUNT_CAP : rawTotal, totalIsCapped };
}

/** Read `total` from a COUNT(*) result (bigint may arrive as a string). */
export function extractCount(rows: Array<{ total: number | string }>): number {
  if (!rows || rows.length === 0) return 0;
  const t = rows[0].total;
  return typeof t === 'string' ? parseInt(t, 10) : t;
}

/**
 * Read the window-function total carried on each row of the q-path rows
 * result. null when the page is empty (OFFSET past the end), signalling
 * the caller to run the fallback count.
 */
export function extractWindowTotal(rows: Array<{ total?: number | string }>): number | null {
  if (!rows || rows.length === 0) return null;
  const t = rows[0].total;
  if (t === undefined || t === null) return null;
  return typeof t === 'string' ? parseInt(t, 10) : t;
}
