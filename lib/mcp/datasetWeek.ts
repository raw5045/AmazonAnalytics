import { db } from '@/db/client';
import { keywordCurrentSummaryMeta } from '@/db/schema';

/**
 * The week-end date of the current explorer snapshot (the singleton row in
 * keyword_current_summary_meta), or null when the table is empty — the
 * refreshSummary kill switch leaves it empty on purpose.
 */
export async function currentDatasetWeek(): Promise<string | null> {
  const [meta] = await db
    .select({ week: keywordCurrentSummaryMeta.currentWeekEndDate })
    .from(keywordCurrentSummaryMeta)
    .limit(1);
  return meta?.week ?? null;
}
