# Keepa enrichment throughput — current state and paths to faster

**Date:** 2026-05-18
**Author:** Claude (collaborating with raw5045)
**Status:** Analysis for review — no code changes implied

## TL;DR

Current implementation processes ~85 ASINs/minute against a Keepa quota that allows up to 125 ASINs/minute (at 2 tokens/ASIN, 250 tokens/min tier). For ~140K ASINs per weekly cycle, that's ~26 hours. Acceptable today; not acceptable if the app gets users and we want a freshly-enriched dataset within a few hours of each weekly refresh.

This document explains where the time goes, ranks possible optimizations by impact and cost, and recommends a path to a **5–8 hour target** for 140K ASINs. The headline finding: the single biggest software win is **batching Keepa API calls** (Keepa supports up to 100 ASINs per request — we currently send one). Combined with a tier upgrade and bulk DB inserts, 5–8 hours is achievable without architectural overhaul.

## Context

We're enriching the top-3 clicked ASINs from each keyword in our weekly Amazon SFR data (rank ≤ 100K, excluding 24 non-applicable categories). For each ASIN, we call Keepa's `/product` endpoint with `rating=1` to get title, brand, current price, category breadcrumb, review count, average rating, sales rank, variations, promotions, and image URL — then we INSERT a row into `asin_weekly_data` keyed on `(asin, week_end_date)`.

Volumes:
- ~140,857 distinct top-3 ASINs in scope per week
- 2 tokens/ASIN at the rating=1 setting (verified empirically)
- Keepa plan: 250 tokens/min tier
- Theoretical floor for our workload: 281,714 tokens ÷ 250 tokens/min = **1,127 min = 18.8 h**

Runtime constraint:
- Function runs on an Inngest worker hosted on Railway
- Each `step.run` is bounded by Inngest's HTTP execution window (~60-70s observed)
- Long-running connections between Inngest Cloud and the Railway worker are occasionally reset (TCP RST seen at the ~150-batch mark in one run)
- Function-level retries (5) + step.run-level retries (3) + per-batch try/catch handle most failures

## How the code is structured today

The Inngest function is in `inngest/functions/enrichKeepaForWeek.ts`.

```
async function (event: keepa.enrich-week-requested):
  init step:
    return { startedAt, asins: listScope(weekEndDate) }   // returns ~140K-element string[]

  for each batch of 50 ASINs in asins:
    step.run('batch-NNNN', async () => {
      open pg.Pool
      for each asin in batch:
        await pacer.maybeSleep()
        const r = await callKeepa(asin, { rating: true })  // single HTTP request per ASIN
        pacer.observe(r.tokensLeft)
        const row = parseKeepaProduct(r.data.products[0], asin, weekEndDate)
        await INSERT ... ON CONFLICT DO NOTHING            // single-row INSERT per ASIN
      close pg.Pool
    })

  send-completion-email step:
    read status histogram from DB
    send admin email via Resend
```

Key code locations:
- Inngest function: `inngest/functions/enrichKeepaForWeek.ts`
- Keepa client (one HTTP request per ASIN): `lib/keepa/client.ts`
- Parser: `lib/keepa/parse.ts`
- Existing schema: `db/migrations/0022_asin_weekly_data.sql`, `db/schema/asinWeeklyData.ts`

## Observed pace and where the time goes

Measured pace (real 2026-05-18 run, ~155 batches before infrastructure failure):
- 50 ASINs per batch
- ~25-40 seconds per batch
- ≈ 75-100 ASINs/min (call it 85 on average)
- 2-token consumption ≈ 170 tokens/min average — comfortably below the 250 tokens/min cap

Per-batch time breakdown (estimated from per-call latencies):

| Phase | Cost per 50-ASIN batch | Notes |
|---|---|---|
| Open pg.Pool + connect | 200-400ms | Once per batch, includes TCP + auth |
| 50 × Keepa HTTP requests | 15-25s | Sequential. Each ~300-500ms (Keepa latency from Railway US-East). **Dominant cost.** |
| 50 × `parseKeepaProduct` | <1s | Pure JS, negligible |
| 50 × INSERT round-trips | 4-8s | One-at-a-time INSERTs. ~100ms each via TCP to Neon. |
| pg.Pool teardown | ~100ms | |
| Inngest step.run boundary | 500ms-1s | Per-batch checkpoint round-trip between Cloud and worker |

**Total: ~25-35s for 50 ASINs ≈ 0.5-0.7s per ASIN.**

The big bottleneck: **sequential per-ASIN HTTP fan-out**. We're doing 50 HTTP round-trips when we could be doing 1.

## What's possible — ranked by impact

### 1. Batch Keepa requests (single largest win — ~5-10× throughput improvement)

Keepa's `/product` endpoint accepts a comma-separated list of ASINs in the `asin` query parameter:

```
GET https://api.keepa.com/product?key=...&domain=1&asin=B001,B002,B003,...&rating=1
```

Confirmed behavior (per Keepa docs):
- Up to **100 ASINs per request**
- Same token cost per ASIN (so a 100-ASIN request costs 200 tokens with rating=1)
- Response: `products: [...]` with one entry per requested ASIN (in order, with nulls for missing)
- Single TCP/TLS handshake, single HTTP round-trip

**Impact analysis:**
- Per current 50-ASIN batch: 15-25s of pure HTTP becomes ~1s of pure HTTP
- Effective ASIN throughput jumps from ~125/min ceiling to perhaps 600-1000/min (HTTP-bound to Keepa-bound)
- Token consumption rate goes up proportionally — at 1000 ASINs/min × 2 = 2000 tokens/min — **exceeds the 250/min tier**, so a tier upgrade is required to actually achieve those speeds
- At current 250 tokens/min: max sustained = 125 ASINs/min regardless of how fast our requests are; we'd be HTTP-bound for ~30s every 50 ASINs and then idle waiting for tokens to refill

**Implementation cost:** small. Modify `callKeepa` to accept `string | string[]`, parse the array response, return `tokensLeft` from the response envelope. Update `processBatch` to call once per batch (or every N ASINs).

**Risks:** Keepa's per-request payload is larger; partial-failure semantics need handling (one ASIN's data might be malformed without breaking the others). Both are manageable.

### 2. Bulk INSERT instead of per-ASIN INSERT (modest win — ~10-15% per batch)

Replace 50 individual `INSERT ... VALUES ($1...$21) ON CONFLICT DO NOTHING` calls with one multi-row `INSERT ... VALUES ($1...$21), ($22...$42), ... ON CONFLICT DO NOTHING`.

**Impact:** saves 4-7 seconds per batch (50 round-trips → 1). For 2,800 batches, that's ~3-5 hours of saved DB time per weekly run — not negligible. The savings get bigger as we increase batch size to take advantage of the Keepa multi-ASIN endpoint.

**Implementation cost:** small. ~15 lines of SQL builder code. Postgres supports up to ~65K parameters per query, so even 1000 ASINs (21 fields each) at 21K params is fine.

**Risks:** if any single row's data is malformed, the whole batch INSERT fails. Manageable: validate rows before assembly, or wrap each INSERT in a try/catch with a per-row fallback.

### 3. Share the long-lived `db` pool across batches (small win — ~5% per batch)

We currently open and tear down a fresh `pg.Pool` inside each `step.run`. The codebase already exports a long-lived shared pool from `db/client.ts` for the Railway worker (`USE_PG_TCP=1` path) — drizzle on top of pg with keepalives and pool size 6.

Using it inside our function would:
- Save 200-400ms of per-batch pool setup
- Get TCP keepalive benefits (handles Neon's auto-suspend reconnects)
- Reduce connection churn against Neon's connection pool ceiling

**Implementation cost:** trivial. Import `db` and `asinWeeklyData` from `@/db/schema`, replace raw pg calls with drizzle's `db.insert(asinWeeklyData).values(...)`. Or keep raw SQL but acquire from the shared pool.

**Trade-off:** mixing raw pg.Pool semantics with drizzle's pool means snake_case→camelCase mapping pain we deferred earlier. Doable, just touches more files. Or extract a helper that uses the shared pool for raw queries.

### 4. Increase batch size now that we can fit ~100 ASINs in 1 HTTP request

Once #1 is in place, the bottleneck per `step.run` becomes the DB INSERTs and pacer pauses, not the API call. A batch of 250 ASINs would:
- Take 2-3 HTTP requests to Keepa (100 ASINs each) ≈ 3 seconds
- 250 INSERTs even unbatched ≈ 25 seconds (still a lot — bulk INSERT essential here)
- 250 INSERTs bulked ≈ 1 second
- Total: ~5 seconds per 250-ASIN batch (vs 30 seconds for 50 unbatched currently)

That's ~50 ASINs/sec = 3,000 ASINs/min if Keepa allows the tokens. At 250 tokens/min cap, we'd burn the bucket every ~25 seconds and the `KeepaPacer` would gate us. **Throughput becomes Keepa-tier-limited, not code-limited.**

### 5. Tier upgrade to 500 or 1000 tokens/min

Once the software is no longer the bottleneck (#1, #2, #3), the only constraint is Keepa's rate cap.

| Tier | Tokens/min | ASINs/min (rating=1, 2 tokens each) | 140K ASINs runtime |
|---|---:|---:|---|
| 250/min (current) | 250 | 125 | 18.7 h theoretical |
| 500/min | 500 | 250 | 9.3 h |
| 1000/min | 1000 | 500 | 4.7 h |
| 2000/min | 2000 | 1000 | 2.3 h |

For the **5–8 hour target**, the 500/min or 1000/min tier matches well. Pricing is roughly linear, so this is a budget decision more than a technical one.

### 6. Detached-job pattern (architectural — but eliminates Inngest fragility)

The existing `worker/jobs.ts` pattern, used for CSV imports, dispatches a background Promise outside Inngest's step lifecycle entirely. The Inngest function only does:
- `step.run('start-job', () => startEnrichJob(weekEndDate))` — returns immediately
- `step.waitForEvent('keepa/enrich.completed')` — sleeps server-side until the background job fires the event

The actual work happens in a long-lived async function on the Railway worker, never bound by Inngest's per-step HTTP timeout. Progress is monitored via DB polling (we already have this) and a completion event signals the email step.

**Implementation cost:** ~1 day. Moves the per-batch loop into `worker/keepaJobs.ts`, adds a DB-level lock (similar to import_started_at) so the function knows the job is running and doesn't double-spawn on Inngest retry.

**Win:** the entire 18-19 hour run lives outside Inngest's step.run constraints. Connection resets between Inngest Cloud and Railway only affect the cheap orchestration calls (start-job and the wait-for-event sleep), not the workload. The class of failures we saw with batches 0154 and the original 250-batch timeout simply doesn't apply anymore.

**Cost:** if the Railway worker process dies mid-run (OOM, deploy, restart), the detached Promise dies with it — all in-progress work is lost. We'd need a heartbeat + resume mechanism (similar to the import_heartbeat_at column on uploaded_files) to make it survivable. The CSV import path has this; we'd mirror.

## Recommended path for the 5–8 hour target

A staged approach, each stage independently committable:

**Stage 1 (1-2 hours of work): batched Keepa requests + bulk INSERT + shared pool**
- Modify `callKeepa(asin: string | string[], ...)` to accept a list, parse the array response.
- Update `processBatch` to fire one Keepa request per N ASINs (start with 100).
- Replace per-row INSERTs with one bulk INSERT per batch.
- Replace ad-hoc `new Pool()` with the shared `db` pool from `@/db/client`.
- Bump `BATCH_SIZE` to 250 or 500 (constrained now only by total batch wall time and Inngest step timeout).
- Expected throughput: 200-300 ASINs/min on current tier (Keepa-cap-limited, mostly idle between bursts). At 200/min, 140K ASINs = ~12 hours. Still over target but much better.

**Stage 2 (0 hours of work — budget decision): Keepa tier upgrade**
- Move to 500/min tier: 9.3h theoretical, ~10h realistic = within target.
- Or 1000/min tier: 4.7h theoretical, ~5.5h realistic = comfortably within target.

**Stage 3 (1 day of work, if Stage 1+2 still proves fragile): detached-job pattern**
- Mirror `worker/jobs.ts`. Move the enrichment loop out of Inngest's step lifecycle.
- Heartbeat + resume column on a new `keepa_enrichment_runs` table so worker restarts don't lose progress.
- Removes the entire class of "Inngest infrastructure flakiness" issues. Recommended once the app has real users — the difference between "occasional re-fire" and "fully unattended" matters.

## What we are NOT recommending (and why)

- **Parallel in-process HTTP requests without batching:** firing N parallel `fetch()` calls per batch is a more invasive change for the same effect as the multi-ASIN endpoint (which gives the speedup with one HTTP request). Skip this; use the endpoint that's already designed for the use case.
- **Switching off Inngest entirely:** Inngest's observability, retry semantics, and event-driven model are net positives for the rest of the app. The detached-job pattern preserves Inngest as the orchestrator without putting workload inside its step lifecycle.
- **Caching Keepa responses:** the data we're capturing IS the cache. We refresh weekly; Keepa's own data freshness for these ASINs is typically updated within hours, so caching beyond a week buys little.

## Open questions for review

1. Does the Keepa multi-ASIN endpoint behave exactly as I described — same token cost per ASIN, up to 100 ASINs per request, single response with one entry per requested ASIN? Want to verify against fresh Keepa docs before implementing.
2. Are there per-IP request rate limits in addition to the token bucket? If so, parallel requests across the multi-ASIN endpoint might trip them.
3. For bulk INSERT, is there a meaningful win from `COPY ... FROM STDIN` over multi-row `INSERT ... VALUES (...), (...)`? At 250-500 rows per batch, probably not worth the COPY complexity. Confirming.
4. For the detached-job pattern: is the existing `worker/jobs.ts` heartbeat/lock mechanism easily reusable, or do we need a separate table for Keepa-specific state? Leaning separate table to keep concerns disjoint.

## Appendix: order-of-magnitude check

A back-of-envelope sanity check: if the only thing we're doing is moving bytes between Keepa, our worker, and Neon, what's the floor?

- 140K ASINs × 2 tokens = 280K tokens
- At 1000 tokens/min Keepa tier: 280 minutes = 4.7 hours of pure API time
- At 500/min: 9.3 hours
- At 250/min: 18.7 hours

These are hard floors. Software optimizations only get us asymptotically close to them. Any number much above these on the same tier means software is the bottleneck; anywhere below means we got lucky on Keepa latency.

Today's 26h actual on a 18.7h theoretical floor (250/min tier) is ~38% overhead. Stage 1 optimizations should drop us to 5-10% overhead = ~20h on current tier. A tier upgrade then brings it down proportionally.
