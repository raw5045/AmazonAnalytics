/**
 * Manually fire `keepa.enrich-week-requested` for one week — the exact event
 * importFile.ts sends after a successful post-import refresh. Recovery tool
 * for when the refresh failed and the auto-fire was (correctly) skipped.
 *
 * Run: FIRE_ENRICH_WEEK=2026-06-27 node --env-file=.env.local --import tsx scripts/fireEnrichWeek.ts
 * Optional: FIRE_ENRICH_MODE=full (default: diff)
 */
import { inngest } from '@/inngest/client';

const weekEndDate = process.env.FIRE_ENRICH_WEEK;
const mode = process.env.FIRE_ENRICH_MODE === 'full' ? 'full' : 'diff';

if (!weekEndDate || !/^\d{4}-\d{2}-\d{2}$/.test(weekEndDate)) {
  console.error('Refusing to run: set FIRE_ENRICH_WEEK=YYYY-MM-DD (the kwm week_end_date to enrich).');
  process.exit(1);
}

(async () => {
  const result = await inngest.send({
    name: 'keepa.enrich-week-requested',
    data: { weekEndDate, mode },
  });
  console.log(`✅ sent keepa.enrich-week-requested for ${weekEndDate} (mode=${mode}). ids=${result.ids.join(',')}`);
})();
