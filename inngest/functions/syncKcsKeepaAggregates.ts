/**
 * Inngest orchestrator for the post-enrichment Keepa-aggregate sync.
 *
 * Triggered by `keepa/aggregates-sync-requested` (fired automatically
 * from enrichKeepaForWeek when an enrichment run completes
 * successfully). The orchestrator spawns the detached worker in
 * worker/kcsKeepaSyncJobs.ts, then waits for the
 * `keepa/aggregates-sync.completed` event to report results.
 *
 * Cheap orchestration only — the actual UPDATE runs OUTSIDE step.run
 * lifecycle (~5-67 min depending on cache warmth), so it's not subject
 * to Inngest's HTTP step timeout.
 *
 * Concurrency keyed on weekEndDate: at most one sync per week in
 * flight, mirroring the enrichment orchestrator's safety guard.
 */
import { inngest } from '../client';
import { startKcsKeepaSyncJob } from '@/worker/kcsKeepaSyncJobs';

export const syncKcsKeepaAggregates = inngest.createFunction(
  {
    id: 'sync-kcs-keepa-aggregates',
    name: 'Sync kcs Keepa aggregates after enrichment',
    concurrency: { limit: 1, key: 'event.data.weekEndDate' },
    retries: 0,
    triggers: [{ event: 'keepa/aggregates-sync-requested' }],
  },
  async ({ event, step }) => {
    const { weekEndDate } = event.data as { weekEndDate: string };

    const kickoff = await step.run('kickoff', () => {
      const result = startKcsKeepaSyncJob({ weekEndDate });
      return { started: result.started, reason: result.reason ?? null };
    });

    if (!kickoff.started) {
      return { ok: true, skipped: true, reason: kickoff.reason };
    }

    // Wait up to 2 hours for the worker to finish + fire completion.
    // The worker itself has a 1-hour statement timeout, so 2h gives
    // some headroom for both phases + facet rebuild.
    const completion = await step.waitForEvent('wait-completion', {
      event: 'keepa/aggregates-sync.completed',
      if: `async.data.weekEndDate == "${weekEndDate}"`,
      timeout: '2h',
    });

    if (!completion) {
      return { ok: false, weekEndDate, reason: 'timed out waiting for completion event' };
    }
    return { ok: true, weekEndDate, ...completion.data };
  },
);
