/**
 * Weekly Keepa enrichment — Inngest orchestrator (v2, detached-job pattern).
 *
 * History:
 *  v0  step.run per batch of 250 ASINs → hit Inngest's HTTP execution
 *      timeout (~60-70s observed) on every multi-hour run.
 *  v1  BATCH_SIZE=50 + try/catch + retries:5 → made it 7K-50K ASINs
 *      before "Application failed to respond" or step-limit
 *      exhaustion or TCP reset. Cumulatively got ~42% through 140K
 *      after four failed runs.
 *  v2  (this) detached-job pattern, mirroring worker/jobs.ts +
 *      inngest/functions/importBatch.ts. The Inngest function only
 *      does cheap orchestration (claim → kickoff → wait → email).
 *      The actual enrichment runs as a detached Promise in
 *      worker/keepaJobs.ts, outside any step.run lifecycle. Inngest
 *      HTTP unreliability is no longer in the workload path —
 *      it only affects the cheap orchestration calls, which are
 *      sub-second and rarely fail.
 *
 * Trigger: event `keepa.enrich-week-requested` with payload `{ weekEndDate }`.
 *
 * Safety nets:
 *   - concurrency:{limit:1, key:weekEndDate} prevents parallel orchestrators
 *   - retries:0 prevents Inngest transport-retry re-entry
 *   - DB-level partial unique index (week_end_date) WHERE status='running'
 *     enforces at-most-one-active-run-per-week independently
 *   - Heartbeat-based orphan detection: if heartbeat is stale > 10 min,
 *     orchestrator marks the run orphaned and the next event takes over
 */
import { inngest } from '../client';
import {
  startKeepaEnrichmentJob,
  claimEnrichmentRun,
  getRunStatus,
  markRunOrphanedByOrchestrator,
  readStatusHistogram,
} from '@/worker/keepaJobs';
import { sendEnrichmentEmail } from '@/lib/notifications/sendEnrichmentEmail';

const POLL_INTERVAL = '5m';
const MAX_POLLS = 288; // 288 × 5m = 24 hours total polling budget
// Heartbeat staleness threshold. If heartbeat hasn't ticked in this
// long, the worker is presumed dead. The background runner writes
// heartbeat every 60s AND after every 50-ASIN batch (a few seconds),
// so 10 minutes of silence is well past normal variance.
const HEARTBEAT_STALE_MS = 10 * 60_000;

export const enrichKeepaForWeek = inngest.createFunction(
  {
    id: 'enrich-keepa-for-week',
    name: 'Enrich Keepa data for a week',
    // Single-orchestrator mutex per week (defense in depth — the DB
    // partial unique index is the canonical guard).
    concurrency: { limit: 1, key: 'event.data.weekEndDate' },
    // No function-level retries. Re-entry from Inngest transport
    // retries could spawn a parallel orchestrator that races our
    // claim logic. Recovery for genuinely failed runs is via
    // re-firing the event (which the DB's partial unique index
    // safely handles via the claim's "is it still running?" check).
    retries: 0,
    triggers: [{ event: 'keepa.enrich-week-requested' }],
  },
  async ({ event, step }) => {
    const { weekEndDate } = event.data as { weekEndDate: string };

    // Step 1: claim a run. May create new, may take over orphaned,
    // may skip if a fresh-heartbeat run already exists.
    const claim = await step.run('claim-run', async () => {
      return claimEnrichmentRun(weekEndDate);
    });

    if (!claim.ok) {
      return {
        ok: true,
        skipped: true,
        reason: claim.reason,
        existingRunId: claim.runId ?? null,
      };
    }

    const runId = claim.runId;

    // Step 2: kickoff the detached background job. This returns
    // synchronously after spawning the Promise. The Promise runs
    // OUTSIDE step.run's lifecycle — Inngest's per-step HTTP timeout
    // doesn't apply.
    await step.run('kickoff-background-job', () => {
      const result = startKeepaEnrichmentJob(runId, weekEndDate);
      return { started: result.started, reason: result.reason ?? null };
    });

    // Step 3: poll loop. Short waitForEvents that also check DB state.
    // The background Promise fires `keepa/enrich.completed` when done;
    // if heartbeat goes stale before that, we detect the orphan and
    // bail (rather than waiting the full 24h budget).
    let outcome: 'completed' | 'failed' | 'orphaned' | 'timeout' = 'timeout';
    let pollIter = 0;

    while (pollIter < MAX_POLLS) {
      const status = await step.run(`status-${pollIter}`, async () => {
        const row = await getRunStatus(runId);
        return row
          ? {
              status: row.status,
              heartbeatAt: row.heartbeatAt?.toISOString() ?? null,
              processedAsins: row.processedAsins,
              totalAsins: row.totalAsins,
            }
          : null;
      });

      if (!status) {
        outcome = 'failed'; // shouldn't happen — we just inserted it
        break;
      }

      if (status.status === 'completed') {
        outcome = 'completed';
        break;
      }
      if (status.status === 'failed' || status.status === 'orphaned') {
        outcome = status.status as 'failed' | 'orphaned';
        break;
      }

      // Skip staleness check on iteration 0 — kickoff just happened
      // and the worker may not have written its first heartbeat yet.
      const hbAt = status.heartbeatAt ? new Date(status.heartbeatAt).getTime() : null;
      if (pollIter > 0 && hbAt !== null && Date.now() - hbAt > HEARTBEAT_STALE_MS) {
        outcome = 'orphaned';
        break;
      }

      // Wait for the completion event or a 5-minute timeout, whichever
      // comes first. If the event fires we re-check status next iter
      // (background sets DB before firing). If it doesn't, we re-poll
      // for heartbeat staleness.
      await step.waitForEvent(`await-${pollIter}`, {
        event: 'keepa/enrich.completed',
        if: `async.data.runId == "${runId}"`,
        timeout: POLL_INTERVAL,
      });

      pollIter++;
    }

    // Step 4: handle orphaned/timeout outcomes. CAS-style — only
    // mark orphaned if the run is still 'running'. If the worker
    // raced and completed between our last check and now, respect that.
    if (outcome === 'orphaned' || outcome === 'timeout') {
      const reason =
        outcome === 'orphaned'
          ? `Heartbeat stale > ${HEARTBEAT_STALE_MS / 60_000} min while orchestrator was waiting`
          : `Orchestrator poll budget exhausted (${MAX_POLLS} × ${POLL_INTERVAL})`;
      const marked = await step.run('mark-orphaned', () =>
        markRunOrphanedByOrchestrator(runId, reason),
      );
      if (!marked) {
        // Worker won the race — re-read to get the actual terminal state.
        const final = await step.run('recheck-after-cas-loss', async () => {
          const row = await getRunStatus(runId);
          return row ? { status: row.status } : null;
        });
        if (final?.status === 'completed') outcome = 'completed';
        else if (final?.status === 'failed') outcome = 'failed';
      }
    }

    // Step 5: send completion email regardless of outcome (operator
    // signal — they should know if enrichment ran, succeeded, or
    // failed, especially if they were waiting on the data).
    await step.run('send-completion-email', async () => {
      const final = await getRunStatus(runId);
      const counts = await readStatusHistogram(weekEndDate);
      const durationMs = final?.startedAt
        ? (final.completedAt ?? new Date()).getTime() - final.startedAt.getTime()
        : 0;
      const tokensSpent = (final?.processedAsins ?? 0) * 2;
      await sendEnrichmentEmail({
        weekEndDate,
        counts,
        durationMs,
        tokensSpent,
      });
    });

    return {
      ok: true,
      runId,
      outcome,
      resumed: claim.resumed,
    };
  },
);
