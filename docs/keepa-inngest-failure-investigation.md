# Keepa enrichment via Inngest — failure investigation and current state

**Date:** 2026-05-19
**Status:** Active investigation. Four architectural iterations completed; current architecture (v2, detached-job pattern) detects failures cleanly but the underlying worker process keeps dying at ~1-1.5h intervals.
**Author:** Claude (collaborator: raw5045)

---

## 1. Background — what we're trying to do

We have an Amazon SFR (Search Frequency Rank) analytics app. The dataset is ~3M keywords with 52 weeks of historical SFR data each. For each keyword, the dataset includes the top 3 most-clicked ASINs (Amazon product IDs).

For each of those top-3 ASINs (~140K distinct per week, after rank ≤ 100K + category exclusions), we want to call Keepa's `/product` API to enrich them with: title, brand, image URL, current price, sales rank, review count, average rating, 30/90/180/365-day average prices, variations, promotions, and full category breadcrumb.

Token economics:
- Keepa plan: 250 tokens/min tier
- Cost: 2 tokens per ASIN (with `rating=1` parameter to get reviews)
- Theoretical minimum runtime: 140,857 ASINs × 2 tokens ÷ 250 tokens/min = **18.8 hours**
- This is a hard floor — no parallelism helps because the rate cap is per-account, not per-connection.

So we're trying to run a sustained ~19-hour workload of ~140K sequential HTTP requests, with each ASIN's response getting parsed and INSERTed into a Postgres table (`asin_weekly_data`).

## 2. Infrastructure setup

- **Database:** Neon Postgres (serverless, auto-suspending compute)
- **App:** Next.js 16 on Vercel (UI, file uploads, dashboards — not relevant to this issue except as context for shared codebase)
- **Background worker:** Railway-hosted Node.js process running `worker/index.ts`. Long-lived; restarted on git push to main or on platform events.
- **Job orchestration:** Inngest Cloud (Pro tier as of 2026-05-17). Inngest's serverless model sends HTTP requests to the Railway worker's `/api/inngest` endpoint to execute steps.

The Railway worker is the same process that handles two other long-running flows:
- CSV file imports (5-15 min each, sometimes 2+ hours under load)
- Keyword summary refreshes (~30 min)

Those flows have been stable for months. They use a "detached-job" pattern documented in `worker/jobs.ts` to bypass Inngest's per-step HTTP timeout (~2-5 min for non-streaming HTTP execution).

## 3. The actual problem

The Keepa enrichment workload has now been attempted four times with progressively more sophisticated architectures. Each attempt has failed at a different point with a different specific error, but the cumulative pattern is:

**The worker keeps making meaningful progress, then dying.** Whether the death is observed at the Inngest layer (HTTP timeout, connection reset, step limit) or the worker layer (silent process exit, heartbeat stale), the underlying issue seems to be that the Railway worker process can't sustain a multi-hour continuous workload, even when the workload is just sequential HTTP calls + Postgres INSERTs.

After four attempts, cumulative progress is ~66K of 140K ASINs (47%).

---

## 4. Architectural timeline

### v0 — Initial implementation (BATCH_SIZE=250, no resilience)

**Configuration:**
- Inngest function `enrichKeepaForWeek` with `concurrency: { limit: 1, key: 'event.data.weekEndDate' }`, `retries: 0`
- Function body: `step.run('init')` to list candidates, then a for-loop of `step.run('batch-NNNN')` where each batch processes 250 ASINs sequentially
- Inside each batch: open pg.Pool, loop ASINs (HTTP call → parse → INSERT), close pool
- Each ASIN ~0.5s end-to-end (HTTP latency dominant) → 250 ASINs = ~2 min per batch
- ~560 batches expected for full 140K backfill

**What happened:** Failed after 71 seconds with Inngest dashboard showing `"Application failed to respond"`. Database showed 140 ASINs had been inserted before death.

**Diagnosis:** Each `step.run` is a separate HTTP request from Inngest Cloud to the Railway worker. The HTTP execution window allows ~60-70s for the worker to return a response. Our 250-ASIN batches take ~2 min, blowing past that. After Inngest's internal retries (3 default), the function fails.

**Fix:** Reduce `BATCH_SIZE` from 250 to 50.

---

### v1 — Smaller batches (BATCH_SIZE=50)

**Configuration:** Same as v0, but `BATCH_SIZE = 50` (each batch ~25-30s, well under the HTTP window).

**What happened:** Ran for **9 hours**, made it through ~640 batches (~32K ASINs), then failed with `"The function run exceeded the step limit of 1000 steps"`.

**Diagnosis:** Inngest's Hobby tier has a 1000-step ceiling per function execution. With 2,800 batches each as its own `step.run`, we hit the ceiling around the 1000th step.

**Fix:** User upgraded to Inngest Pro tier (higher limit).

---

### v1.1 — Pro tier + try/catch + function-level retries

**Configuration:**
- `BATCH_SIZE = 50`
- `retries: 5` at function level (was 0)
- `try/catch` wrapper around each `step.run('batch-NNNN')` — if a batch fails after Inngest's internal retries, log + continue; failed batch's ASINs naturally reappear on next `listScope` since they weren't inserted
- Inngest Pro tier active

**What happened:** Ran for ~1.5 hours, processed ~7,750 ASINs (~155 batches), then failed with `"Your server reset the connection while we were sending the request"`. Inngest dashboard showed the function as failed with `"Application failed to respond"`.

**Diagnosis:** The error is at the **infrastructure layer** between Inngest Cloud and the Railway worker — TCP connection reset. Our try/catch is inside the function body, so when Inngest can't reach the worker at all, our resilience code never executes. Inngest retried 3 times internally, all reset, then gave up. Function-level retries of 5 then kicked in, but the same condition persisted, so all retries eventually failed.

This was the diagnostic turning point: our resilience layers (try/catch, retries, smaller batches) were all *inside* code that runs after Inngest successfully calls the worker. None of them help when the call itself can't complete.

**Fix:** Move the entire workload out of Inngest's step.run lifecycle via the detached-job pattern.

---

### v2 — Detached-job pattern (current architecture)

**Configuration:** This is a substantial refactor. The Inngest function is now thin orchestration; all real work happens in a detached Promise in the worker process.

New file structure:

```
worker/keepaJobs.ts                          (~340 lines, new)
  startKeepaEnrichmentJob(runId, weekEndDate)
    → spawns detached IIFE Promise
    → Promise: runEnrichment() does ALL the work
    → on completion: fires `keepa/enrich.completed` event
  claimEnrichmentRun(weekEndDate) → check + create row in DB
  getRunStatus(runId)
  markRunOrphanedByOrchestrator(runId, reason) — CAS-style
  readStatusHistogram(weekEndDate)
  // private:
  runEnrichment() — open pool, heartbeat ticker, batch loop
  listScope() — candidate query
  insertRow() — single INSERT

inngest/functions/enrichKeepaForWeek.ts      (refactored, much smaller)
  Thin orchestrator:
    step.run('claim-run')                    DB INSERT (~10ms)
    step.run('kickoff-background-job')       spawn Promise (~5ms)
    poll loop (288 × 5min = 24h budget):
      step.run('status-N')                   read run row
      step.waitForEvent('keepa/enrich.completed', timeout: 5m)
    step.run('mark-orphaned')                CAS-style if needed
    step.run('send-completion-email')

db/migrations/0023_keepa_enrichment_runs.sql (new table)
  Tracks: status, started_at, heartbeat_at, completed_at,
          owner_boot_id (worker process UUID),
          total_asins, processed_asins, *_count columns
  Partial unique index (week_end_date) WHERE status='running'
    → enforces at-most-one-active-run-per-week at the DB layer
```

**Key safety mechanisms:**
- Background Promise lives in Node memory, completely outside Inngest's step.run lifecycle. Inngest HTTP unreliability cannot affect the workload.
- Heartbeat updated every 60s via a `setInterval`, plus after every 50-ASIN batch (so heartbeat freshness is at most ~10s during steady-state).
- If heartbeat goes stale > 10 min, orchestrator marks the run "orphaned" via CAS-style UPDATE (only if status still 'running' — defensive against worker winning the race).
- One running run per week enforced via partial unique index — independent guard at the DB layer.
- Worker process exposes a `BOOT_ID` (UUID per process start) stored on the run row. New orchestrators can detect "the worker that started this run is gone" by comparing BOOT_IDs.

**This pattern is proven elsewhere in the codebase.** `worker/jobs.ts` + `inngest/functions/importBatch.ts` use the exact same shape for CSV imports (which routinely run 2+ hours). The import flow has been stable for months. We mirrored its design verbatim.

**What happened tonight (2026-05-19):**

The detached-job machinery itself worked exactly as designed. The orchestrator:
1. Claimed a run (id `4579f492...`)
2. Kicked off the background Promise
3. Polled status every 5 minutes
4. Detected heartbeat staleness after 10 min
5. Marked the run orphaned via CAS
6. Sent the completion email

The background Promise:
1. Ran for **1 hour 23 minutes**
2. Processed **7,000 ASINs** with **zero errors** (clean work)
3. Then stopped writing heartbeats — the process apparently died

So the architecture is correct, but **the worker process keeps dying**.

---

## 5. The current open question

The detached-job pattern hides the failure mode behind orphan detection, but the underlying issue is: **the Railway worker process can't sustain a multi-hour continuous workload of HTTP calls + Postgres INSERTs.**

Pattern across all four attempts:

| Attempt | Architecture | Time before death | ASINs processed | Death signature |
|---|---|---|---:|---|
| v0 | step.run, 250-batch | 71 seconds | 140 | Inngest HTTP timeout |
| v1 | step.run, 50-batch | 9 hours | ~32,000 | Inngest 1000-step limit |
| v1.1 | step.run + try/catch + retries:5 | ~1.5 hours | ~7,750 | TCP connection reset |
| v2 | detached Promise | ~1h 23min | 7,000 | Worker process died silently (heartbeat stale) |

**Notable: v0, v1.1, and v2 all died at roughly the 1-1.5 hour mark.** v1 made it 9 hours, but it might have been making slower progress per batch, hitting the step limit rather than a time limit.

If we ignore v1 (which died for a different, now-fixed reason), the worker process appears to consistently die after 1-1.5 hours of sustained activity.

## 5b. KEY NEW DATA POINT — Railway outage correlated with v2 failure

**Added after initial doc was drafted.**

At 2026-05-19 22:29 UTC, Railway formally declared a Major Outage:
> "Edge Network – Investigating: We are investigating a widespread
> service disruption affecting Railway. Users may be experiencing
> errors including 'no healthy upstream', 'unconditional drop overload',
> login failures, and inability to access the dashboard."
>
> 22:43 UTC — "We have identified the cause of the disruption.
> Access to our upstream cloud provider has been restored and we
> are working on a fix."

Our v2 run died at ~21:36 UTC — **53 minutes before** Railway formally
declared the outage. Upstream cloud provider issues commonly cause
silent connection drops, container instability, and other partial
failures for an extended period before a platform's status page
catches up.

This is almost certainly NOT coincidence. The leading edge of the
outage probably explains the v2 worker death.

**Reframed interpretation of the full pattern:**

| Run | Time before death | Likely cause given new data |
|---|---|---|
| v0 | 71 sec | Genuine HTTP timeout (BATCH_SIZE too large) |
| v1 | 9 hours | Ran during stable platform window; hit step limit |
| v1.1 | ~1.5h | **Probably** platform instability (an earlier mini-outage) |
| v2 | ~1.5h | **Almost certainly** the current Railway outage |

The "sometimes 1h, sometimes 9h" pattern across attempts is much more
consistent with **variable platform stability** than with OOM or
async-error theories (both of which would manifest consistently).

**What this means for the priority of diagnostic effort:**

- The Tier-1 Railway dashboard data (memory, deploy events, restart
  events around failure times) becomes the highest-leverage item to
  pull. We want to see if the worker process exit time correlates
  with Railway-side platform events even when no formal outage is
  declared.
- If we can correlate previous worker deaths to non-public Railway
  hiccups, the architecture-level conclusion shifts from "fix
  something in our code" to "either harden against intermittent
  platform unreliability OR move off Railway for this workload."

**Implication for current architecture:**

The detached-job pattern (v2) was designed to survive Inngest HTTP
unreliability. It DID survive the Inngest-layer issues that killed
v0 and v1.1 — the orphan-detection mechanism worked exactly as
designed when the worker died tonight. What it doesn't survive is
the worker process itself being killed by the host platform.

To handle this case, the orchestrator could be extended to detect
"orphaned" status and automatically claim a new run + re-kickoff,
rather than ending with a notification email. This makes the
workload self-healing across worker deaths — finishing the backfill
becomes a matter of "enough cumulative uptime over the next N
days," regardless of how many individual worker deaths occur.

Risks of auto-restart-on-orphan:
- Could mask genuine systematic bugs by self-healing them out of
  visibility — important to keep alerting (the email) so we know
  when orphans happen.
- Infinite restart loop if the same death happens immediately each
  time. Mitigation: cap at N restarts within a 24h window (say, 10);
  beyond that, give up and email the operator for manual intervention.

## 6. Hypotheses for why the worker dies

Ordered roughly by my subjective likelihood:

### 6.1 Memory leak or accumulating heap pressure → eventually OOM

The Keepa response per ASIN is large (one we captured was 180KB — the `variations`, `promotions`, `csv` arrays in particular). We parse the response, build an `EnrichmentRow`, INSERT it, then drop references. **In theory** the old objects are garbage-collected, but in practice Node's GC can lag under sustained allocation pressure.

Over 7,000 ASINs × 180KB = ~1.2 GB of allocations within 1.5 hours. Even with aggressive GC, if any subtle reference is held (closures, async stack traces, etc.), the heap could grow.

Railway's free / starter tiers have memory limits (512 MB on starter — easy to blow past). Our plan is Hobby+ (whichever has more), but we don't actually know the exact memory ceiling.

**Test:** monitor `process.memoryUsage()` periodically during the run; log to console; cross-reference with worker death time.

### 6.2 Railway platform-level periodic restart or scaling event

Some platforms (Heroku style) periodically restart workers. Railway documentation suggests this shouldn't happen unless we're being scaled, but we haven't verified.

**Test:** check Railway dashboard for the worker service. Look for "restart events," uptime stats, deploy history during the run window.

### 6.3 Unhandled async error killing the process

Our background Promise has try/catch around the batch loop, but `setInterval` callbacks (the heartbeat ticker) don't have one. If `updateHeartbeat()` throws an error that propagates up the setInterval call stack, Node's default behavior is to crash the process (process.on('uncaughtException') default = exit 1).

Our code:
```typescript
const heartbeatTicker = setInterval(() => {
  updateHeartbeat(runId).catch((e) => {
    console.warn(`heartbeat write failed:`, e);
  });
}, HEARTBEAT_INTERVAL_MS);
```

`.catch()` should handle the async error, but there's a subtle case: if `updateHeartbeat()` throws synchronously (before returning a Promise — e.g., the `db` object itself is in a bad state), the synchronous throw isn't caught by `.catch()`. Wrapping the whole interval body in a try would help.

**Test:** check Railway logs for any uncaught error messages around the time of worker death.

### 6.4 Inngest connection from worker to Cloud failing

The worker has a long-lived connection to Inngest Cloud for receiving events and reporting step results. If that connection drops and the SDK can't reconnect, the worker might hang or exit.

We use `inngest@4.2.4`. The SDK reconnect behavior is opaque to us.

**Test:** check worker logs for `[inngest]` warnings/errors. Add periodic Inngest health pings.

### 6.5 Neon Postgres compute auto-suspend during a long idle gap

Our background Promise makes constant DB writes during the batch loop, so Neon's compute shouldn't auto-suspend during work. But the heartbeat ticker is the only thing keeping the DB connection warm during long Keepa fetches. If the Keepa API has a slow response (say, 5+ seconds), the DB connection could be idle long enough for Neon's load balancer to close it.

We have TCP keepalives on the pg.Pool:
```typescript
keepAlive: true,
keepAliveInitialDelayMillis: 10_000,
```

This *should* prevent idle closures, but Neon's serverless infrastructure may be more aggressive than typical Postgres.

**Test:** add explicit "SELECT 1" pings every 30s; log on any pg client error events; correlate with worker death.

### 6.6 KeepaPacer or Keepa API rate-limit edge case

If we hit a Keepa rate-limit response (HTTP 429 or similar) that throws, and our error handling somehow misses it, the unhandled throw could bubble up and kill the process. Our `callKeepa` does throw on non-200 responses:

```typescript
if (!res.ok) {
  throw new Error(`Keepa HTTP ${res.status} for ${asin}`);
}
```

The throw happens inside `processBatch`'s try/catch which would catch it and record as an `error` status row. **But** if the `error` count in our last failed run was 0 (it was), we didn't hit this path. So Keepa errors don't seem to be the cause.

---

## 7. What we'd want GPT to weigh in on

1. **Which hypothesis is most likely?** Based on the timing pattern (1-1.5h consistently), the lack of error-status rows (suggesting no JS errors are being caught), and Railway being our worker host — what's the most likely root cause?

2. **What diagnostic data should we collect first?**
   We can:
   - Read Railway worker logs (verbose, will need filtering for relevant events)
   - Add `process.memoryUsage()` logging every 5 minutes
   - Add `process.on('uncaughtException')` and `process.on('unhandledRejection')` handlers with structured logging before exit
   - Add periodic Inngest connection state pings
   - Monitor Neon dashboard for connection drop events

3. **Resilience improvements to the orchestrator while we diagnose.**
   Currently when the orchestrator detects orphan, it ends with status=orphaned and stops. A more aggressive strategy: detect orphan → claim a new run → re-kickoff → keep going. This would make multi-hour workloads survive worker restarts entirely. Risks: infinite restart loops if the underlying bug is consistent. Mitigation: cap the number of self-restarts (e.g., max 5 within a 24h window).

4. **Are we missing a Railway-specific configuration?**
   For long-running Node workloads on Railway, are there:
   - Memory limit tunings we should request?
   - Pinning / dedicated CPU options?
   - Worker liveness probe configurations that might prevent kills?

5. **Architecture-level alternatives if Railway is the constraint.**
   - Move just the Keepa worker to a different host (fly.io? Render? a small VPS)?
   - Use a queue-based design (SQS / equivalent) where each ASIN is a discrete unit, and many short-lived workers process the queue in parallel — eliminating the need for any single worker to survive multi-hour workloads?
   - Use Inngest's "delayed" event triggers to break the 19h workload into 19 separate 1-hour Inngest function runs that each handle one chunk?

6. **The "resume safely after worker death" property** — is it strong enough?
   When the worker dies, the next event-fire correctly picks up where the last left off (via `listScope` excluding already-enriched ASINs in `asin_weekly_data`). Cumulative progress is preserved even across many failures. This means even without fixing the underlying death, we *can* finish the backfill via many manual refires. But it's ugly. Worth fixing, but not blocking.

---

## 8. Reference code locations

For someone reading this without our codebase, the relevant files:

```
inngest/functions/enrichKeepaForWeek.ts    — Inngest orchestrator (thin)
worker/keepaJobs.ts                        — detached background runner
worker/jobs.ts                             — same pattern for CSV imports (stable)
worker/index.ts                            — Railway worker entry, has BOOT_ID + health endpoint
inngest/functions/importBatch.ts           — orchestrator for the CSV import flow
db/migrations/0022_asin_weekly_data.sql    — destination table for enriched data
db/migrations/0023_keepa_enrichment_runs.sql — run-state tracking table
lib/keepa/client.ts                        — fetch wrapper + KeepaPacer (token-bucket)
lib/keepa/parse.ts                         — pure parser for Keepa response
lib/keepa/types.ts                         — shared types (EnrichmentRow, etc.)
db/client.ts                               — drizzle ORM + pg.Pool config
railway.json                               — Railway deploy config
```

The worker config in `railway.json`:
```json
{
  "build": { "builder": "NIXPACKS" },
  "deploy": {
    "startCommand": "pnpm tsx worker/index.ts",
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 10,
    "healthcheckPath": "/",
    "healthcheckTimeout": 300
  }
}
```

The pg.Pool config in `db/client.ts`:
```typescript
const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 6,
  idleTimeoutMillis: 30_000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
  connectionTimeoutMillis: 20_000,
});
```

In the workload (`worker/keepaJobs.ts`):
```typescript
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
  connectionTimeoutMillis: 20_000,
  statement_timeout: 300_000,
  max: 2,
});
```

---

## 9. The honest assessment

The CSV import flow has worked reliably on this exact infrastructure for months — including 2+ hour runs. So the platform CAN sustain long workloads. The Keepa enrichment has a different shape (high HTTP throughput, large response payloads, sustained allocations) that exposes some fragility the CSV flow doesn't.

Our four iterations have each successfully addressed the failure mode they were designed for. The current iteration (v2) is the same pattern the stable CSV flow uses, so we'd expect it to work — but we're hitting a different failure mode (silent worker death) that the CSV flow apparently doesn't.

The most actionable next steps:
1. **Diagnose** what's killing the worker (memory? platform restart? uncaught exception?).
2. **Add auto-restart-on-orphan** to the orchestrator so the workload self-heals across worker deaths during the diagnosis period.
3. **Re-evaluate architecture** if we can't keep the worker alive for multi-hour stretches.

Without knowing why the worker dies, any fix is a guess. Getting visibility into Railway worker behavior is the highest-leverage next step.
