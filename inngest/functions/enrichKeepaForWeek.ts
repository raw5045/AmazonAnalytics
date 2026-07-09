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

// Note (2026-05-21): the previous implementation also tripped 'orphaned'
// when heartbeat_at was > 10 min stale. That check was the source of
// false-positive orphan markings — observed on both the 5/19 and 5/20
// runs, where the orchestrator marked the run orphaned while the worker
// was actively writing batch updates. Root cause never fully diagnosed
// (suspected Inngest step.run replay or event-filter interaction). The
// defensive fix: trust ONLY the explicit DB status fields and the
// poll-budget timeout. Orphan detection still happens via:
//   - MAX_POLLS budget exhaustion (24h cap) — orchestrator marks orphaned
//   - claimEnrichmentRun on the next event-fire — if a previous run's
//     heartbeat is stale, that path marks it orphaned and creates a new
//     run (so re-firing after any worker death naturally heals)
// We accept slower orphan detection in exchange for no false positives.

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
    const { weekEndDate, mode: rawMode } = event.data as {
      weekEndDate: string;
      mode?: 'full' | 'diff';
    };
    // Default to 'diff' — the fast carry-forward path used for normal
    // weekly maintenance. 'full' is only set by the monthly admin
    // button + manual CLI flag.
    const mode: 'full' | 'diff' = rawMode === 'full' ? 'full' : 'diff';

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
      const result = startKeepaEnrichmentJob(runId, weekEndDate, mode);
      return { started: result.started, reason: result.reason ?? null };
    });

    // Step 3: poll loop. Short waitForEvents punctuated by DB status
    // checks. The break conditions are explicit DB status values only —
    // no heartbeat-staleness check (see the note above on the false-
    // positive history).
    let outcome: 'completed' | 'failed' | 'orphaned' | 'timeout' = 'timeout';
    let pollIter = 0;

    while (pollIter < MAX_POLLS) {
      const status = await step.run(`status-${pollIter}`, async () => {
        const row = await getRunStatus(runId);
        return row
          ? {
              status: row.status,
              processedAsins: row.processedAsins,
              totalAsins: row.totalAsins,
            }
          : null;
      });

      if (!status) {
        // Row deleted? Shouldn't happen. Treat as failure for safety.
        console.warn(`[enrichKeepaForWeek] status row missing for runId=${runId} at iter ${pollIter}`);
        outcome = 'failed';
        break;
      }

      if (status.status === 'completed') {
        outcome = 'completed';
        break;
      }
      if (status.status === 'failed') {
        outcome = 'failed';
        break;
      }
      if (status.status === 'orphaned') {
        // Worker won't reach this state on its own — it'd happen if a
        // separate orchestrator instance marked our run orphaned. Rare
        // (concurrency:1 + DB partial index guard) but possible. Defer.
        outcome = 'orphaned';
        break;
      }

      // Wait for the completion event or a 5-minute timeout. If it fires
      // we'll catch status=completed/failed on the next iteration's DB
      // check (the worker writes status BEFORE firing the event).
      await step.waitForEvent(`await-${pollIter}`, {
        event: 'keepa/enrich.completed',
        if: `async.data.runId == "${runId}"`,
        timeout: POLL_INTERVAL,
      });

      pollIter++;
    }

    // Step 4: handle the only soft outcome — poll-budget timeout.
    // CAS-style: only flip to orphaned if status is still 'running'.
    // If the worker raced and completed/failed between our last check
    // and now, respect that.
    if (outcome === 'timeout') {
      const reason = `Orchestrator poll budget exhausted (${MAX_POLLS} × ${POLL_INTERVAL})`;
      const marked = await step.run('mark-orphaned-timeout', () =>
        markRunOrphanedByOrchestrator(runId, reason),
      );
      if (marked) {
        outcome = 'orphaned';
      } else {
        // Worker won the race — re-read for actual terminal state.
        const final = await step.run('recheck-after-cas-loss', async () => {
          const row = await getRunStatus(runId);
          return row ? { status: row.status } : null;
        });
        if (final?.status === 'completed') outcome = 'completed';
        else if (final?.status === 'failed') outcome = 'failed';
        else outcome = 'orphaned';
      }
    }

    // Step 4b: if enrichment SUCCEEDED, fire the post-enrichment
    // kcs Keepa-aggregate sync. Done as a fire-and-forget event so
    // the sync runs in its own orchestrator + detached worker without
    // blocking the email step here. The sync brings fresh Keepa data
    // for newly-enriched ASINs into the explorer's precomputed
    // columns (lowest/highest price, reviews, leaf category) — without
    // waiting for the next weekly refresh.
    if (outcome === 'completed') {
      await step.sendEvent('trigger-kcs-keepa-sync', {
        name: 'keepa/aggregates-sync-requested',
        data: { weekEndDate },
      });
    }

    // Step 5: send the appropriate-variant email. The outcome variable
    // determines subject/color/wording (completed / failed / orphaned).
    await step.run('send-completion-email', async () => {
      const final = await getRunStatus(runId);
      const counts = await readStatusHistogram(weekEndDate);
      const durationMs = final?.startedAt
        ? (final.completedAt ?? new Date()).getTime() - final.startedAt.getTime()
        : 0;
      const tokensSpent = (final?.processedAsins ?? 0) * 2;
      // A "completed" run that fetched zero ASINs is a no-op (the week was
      // already covered) — flag it so the email can't masquerade as a fresh
      // enrichment. (The 2026-07-08 full-refresh no-op looked like success.)
      const noop = outcome === 'completed' && (final?.totalAsins ?? 0) === 0;
      // outcome is statically narrowed to completed | failed | orphaned
      // by the timeout-handling block above (the `if outcome === 'timeout'`
      // path always reassigns outcome).
      await sendEnrichmentEmail({
        outcome,
        weekEndDate,
        counts,
        durationMs,
        tokensSpent,
        errorMessage: final?.errorMessage ?? undefined,
        noop,
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
