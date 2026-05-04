/**
 * Run the keyword_current_summary refresh once, manually.
 *
 * Used to seed the table after the fake_volume_severity backfill (Step 2)
 * but before the import pipeline starts auto-running it (Step 4).
 *
 * Usage: pnpm tsx scripts/refreshSummaryOnce.ts
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { refreshKeywordCurrentSummary } from '@/inngest/functions/refreshSummary';

async function main() {
  console.log('Starting keyword_current_summary refresh...');
  console.log('  (Expected: 5-8 minutes on ~4M active terms)\n');

  const startedAt = Date.now();
  const result = await refreshKeywordCurrentSummary();
  const elapsedMin = ((Date.now() - startedAt) / 60_000).toFixed(1);

  console.log(`\n✅ Refresh complete in ${elapsedMin} min`);
  console.log(`   current_week_end_date: ${result.currentWeekEndDate}`);
  console.log(`   rows written: ${result.rowsWritten.toLocaleString()}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
