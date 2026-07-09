/**
 * Detached background runner for the weekly Keepa enrichment.
 *
 * Why this exists (analogue of `worker/jobs.ts` for the import path):
 *   Inngest's step.run lifecycle makes every batch a separate HTTP
 *   round-trip between Inngest Cloud and the Railway worker. Over a
 *   ~19h workload that's thousands of HTTP calls, and the path
 *   periodically fails ("Application failed to respond" / TCP RST /
 *   step-limit exhaustion) regardless of what code-level resilience
 *   we layer on. With ~2,800 batches, even one stray failure aborts
 *   the run.
 *
 * Fix: the Inngest function only orchestrates (claim → kickoff → wait
 * → email), all cheap operations. The actual enrichment runs as a
 * detached Promise inside this module, totally outside Inngest's
 * step.run lifecycle. The Promise's only Inngest interaction is the
 * single `keepa/enrich.completed` event it fires at the end.
 *
 * State lives in `keepa_enrichment_runs`. The Promise:
 *   - INSERTs total_asins after listScope
 *   - heartbeats every 60s
 *   - updates the *_count columns after each batch
 *   - on completion: UPDATE status='completed', completed_at=now()
 *   - on error: UPDATE status='failed', error_message
 *
 * The orchestrator polls `keepa_enrichment_runs` for status changes
 * and uses a heartbeat-staleness threshold to detect orphaned runs
 * (worker died silently).
 */
import { Pool, type PoolClient } from 'pg';
import { eq, sql, and } from 'drizzle-orm';
import { db } from '@/db/client';
import { keepaEnrichmentRuns, type KeepaEnrichmentRunStatus } from '@/db/schema';
import { BOOT_ID } from '@/lib/runtime';
import { inngest } from '@/inngest/client';
import { callKeepa, KeepaPacer } from '@/lib/keepa/client';
import { parseKeepaProduct, emptyRow } from '@/lib/keepa/parse';
import { EXCLUDED_CATEGORIES_ARRAY } from '@/lib/keepa/categoryExclusions';
import type { EnrichmentRow, AsinEnrichmentStatus } from '@/lib/keepa/types';

const BATCH_SIZE = 50;
const HEARTBEAT_INTERVAL_MS = 60_000;

/** In-process dedup so back-to-back kickoff calls don't race. */
const inflight = new Set<string>();

// ============================================================================
// Run lifecycle helpers (called by both this module and the orchestrator)
// ============================================================================

/**
 * Claim a run for the given week. Returns either a new run ID, a
 * "take over" of an orphaned run, or a skip reason if there's already
 * a live run we shouldn't disturb.
 */
export async function claimEnrichmentRun(weekEndDate: string): Promise<
  | { ok: true; runId: string; resumed: boolean }
  | { ok: false; reason: string; runId?: string }
> {
  // Check for an existing 'running' row first.
  const [existing] = await db
    .select()
    .from(keepaEnrichmentRuns)
    .where(and(eq(keepaEnrichmentRuns.weekEndDate, weekEndDate), eq(keepaEnrichmentRuns.status, 'running')))
    .limit(1);

  if (existing) {
    const heartbeatMs = existing.heartbeatAt.getTime();
    const staleness = Date.now() - heartbeatMs;
    // If the existing run's heartbeat is fresh (< 5 min), treat as
    // live — don't claim. The previous orchestrator's poll loop will
    // observe completion.
    if (staleness < 5 * 60_000) {
      return { ok: false, reason: 'already-running-fresh', runId: existing.id };
    }
    // Heartbeat is stale → previous worker died silently. Take over
    // by marking the old run orphaned and inserting a new one. The
    // partial-unique index on (week_end_date) WHERE status='running'
    // forces this transition: we can't have two running runs at once.
    await db.transaction(async (tx) => {
      await tx
        .update(keepaEnrichmentRuns)
        .set({
          status: 'orphaned',
          completedAt: new Date(),
          errorMessage: `Orphaned: heartbeat stale by ${Math.round(staleness / 60_000)} min (likely worker died)`,
        })
        .where(eq(keepaEnrichmentRuns.id, existing.id));
    });
    // Fall through to INSERT a new run below.
  }

  const [inserted] = await db
    .insert(keepaEnrichmentRuns)
    .values({
      weekEndDate,
      status: 'running',
      ownerBootId: BOOT_ID,
    })
    .returning({ id: keepaEnrichmentRuns.id });

  return { ok: true, runId: inserted.id, resumed: !!existing };
}

export async function getRunStatus(runId: string) {
  const [row] = await db
    .select()
    .from(keepaEnrichmentRuns)
    .where(eq(keepaEnrichmentRuns.id, runId))
    .limit(1);
  return row ?? null;
}

export async function markRunOrphanedByOrchestrator(runId: string, reason: string): Promise<boolean> {
  // CAS-style: only mark orphaned if still 'running'. If the worker
  // won the race and already flipped to 'completed' or 'failed',
  // respect that.
  const result = await db.execute(sql`
    UPDATE keepa_enrichment_runs
    SET status = 'orphaned',
        completed_at = NOW(),
        error_message = ${reason}
    WHERE id = ${runId}
      AND status = 'running'
    RETURNING id
  `);
  return result.rows.length > 0;
}

/**
 * Boot-time reclaim: orphan any Keepa enrichment run that a previous worker
 * boot left 'running' with a stale heartbeat (worker died or redeployed
 * mid-run). The durable orchestrator re-reads run status every 5 min, so once
 * a stale run flips to 'orphaned' it observes the change on its next poll and
 * sends the orphaned-variant email — instead of burning its full 24h poll
 * budget waiting for a worker that's never coming back.
 *
 * Gated on heartbeat staleness (>5 min), NOT bare owner_boot_id, so a run
 * still being actively written by a live OLD-deploy worker during a rolling
 * deploy is never falsely reclaimed: the Keepa heartbeat ticks every 60s on a
 * separate connection, so a >5-min-stale heartbeat genuinely means the process
 * is gone. (The import path deliberately has no equivalent sweep — a staleness
 * check there false-orphaned a live import on 2026-05-16; see
 * inngest/functions/importBatch.ts.)
 *
 * Safe to call once at worker startup. CAS-guarded via
 * markRunOrphanedByOrchestrator (only orphans rows still 'running'). Returns
 * the reclaimed run ids.
 */
export async function reclaimStaleKeepaRunsOnBoot(): Promise<string[]> {
  const STALE_MS = 5 * 60_000;
  const cutoff = new Date(Date.now() - STALE_MS);
  const stale = await db
    .select({
      id: keepaEnrichmentRuns.id,
      weekEndDate: keepaEnrichmentRuns.weekEndDate,
      heartbeatAt: keepaEnrichmentRuns.heartbeatAt,
    })
    .from(keepaEnrichmentRuns)
    .where(and(eq(keepaEnrichmentRuns.status, 'running'), sql`${keepaEnrichmentRuns.heartbeatAt} < ${cutoff}`));

  const reclaimed: string[] = [];
  for (const run of stale) {
    const staleMin = Math.round((Date.now() - run.heartbeatAt.getTime()) / 60_000);
    const reason = `Reclaimed on worker boot: heartbeat stale by ${staleMin} min (worker died/redeployed mid-run)`;
    // CAS re-check inside markRunOrphanedByOrchestrator: skip if the worker
    // won a late race and already flipped the run to completed/failed.
    if (await markRunOrphanedByOrchestrator(run.id, reason)) {
      reclaimed.push(run.id);
      console.warn(
        `[keepa-boot-reclaim] orphaned stale run ${run.id.slice(0, 8)} (week ${run.weekEndDate}): stale ${staleMin} min`,
      );
    }
  }
  return reclaimed;
}

async function updateHeartbeat(runId: string): Promise<void> {
  await db.execute(sql`
    UPDATE keepa_enrichment_runs
    SET heartbeat_at = NOW()
    WHERE id = ${runId} AND status = 'running'
  `);
}

async function updateRunTotalAsins(runId: string, total: number): Promise<void> {
  await db
    .update(keepaEnrichmentRuns)
    .set({ totalAsins: total })
    .where(eq(keepaEnrichmentRuns.id, runId));
}

async function updateRunCounts(
  runId: string,
  counts: {
    processedAsins: number;
    activeCount: number;
    noPriceCount: number;
    delistedCount: number;
    errorCount: number;
  },
): Promise<void> {
  await db
    .update(keepaEnrichmentRuns)
    .set({
      processedAsins: counts.processedAsins,
      activeCount: counts.activeCount,
      noPriceCount: counts.noPriceCount,
      delistedCount: counts.delistedCount,
      errorCount: counts.errorCount,
      heartbeatAt: new Date(), // freshness while we're here
    })
    .where(eq(keepaEnrichmentRuns.id, runId));
}

async function markRunCompleted(runId: string): Promise<void> {
  await db
    .update(keepaEnrichmentRuns)
    .set({ status: 'completed', completedAt: new Date() })
    .where(eq(keepaEnrichmentRuns.id, runId));
}

async function markRunFailed(runId: string, errorMessage: string): Promise<void> {
  await db
    .update(keepaEnrichmentRuns)
    .set({
      status: 'failed',
      completedAt: new Date(),
      errorMessage,
    })
    .where(eq(keepaEnrichmentRuns.id, runId));
}

// ============================================================================
// Background runner — dispatches the detached Promise
// ============================================================================

/**
 * Kick off the detached enrichment job. Returns synchronously after
 * spawning the Promise so the calling Inngest step.run can complete
 * immediately. The Promise runs in the worker process and is NOT
 * awaited; its completion is signaled via the
 * `keepa/enrich.completed` event.
 */
export type KeepaEnrichmentMode = 'full' | 'diff';

export function startKeepaEnrichmentJob(
  runId: string,
  weekEndDate: string,
  mode: KeepaEnrichmentMode = 'diff',
): { started: boolean; reason?: string } {
  if (inflight.has(runId)) {
    return { started: false, reason: 'already-inflight' };
  }
  inflight.add(runId);

  (async () => {
    let success = false;
    let errorMessage: string | null = null;
    let portedCount = 0;
    try {
      portedCount = await runEnrichment(runId, weekEndDate, mode);
      success = true;
      console.log(
        `[keepa-job ${runId.slice(0, 8)}] completed for week ${weekEndDate} (mode=${mode}, ported=${portedCount})`,
      );
    } catch (e) {
      errorMessage = e instanceof Error ? e.message : String(e);
      console.error(`[keepa-job ${runId.slice(0, 8)}] failed for week ${weekEndDate}:`, errorMessage);
      try {
        await markRunFailed(runId, errorMessage);
      } catch (updateErr) {
        console.error(
          `[keepa-job ${runId.slice(0, 8)}] also failed to mark run as failed:`,
          updateErr,
        );
      }
    } finally {
      inflight.delete(runId);
      // Fire completion event so the orchestrator's step.waitForEvent
      // unblocks immediately rather than waiting for its next poll.
      try {
        await inngest.send({
          name: 'keepa/enrich.completed',
          data: { runId, weekEndDate, success, error: errorMessage, mode, portedCount },
        });
      } catch (sendErr) {
        console.error(
          `[keepa-job ${runId.slice(0, 8)}] failed to fire completion event:`,
          sendErr,
        );
      }
    }
  })();

  return { started: true };
}

// ============================================================================
// The enrichment loop itself — was previously inside step.run batches
// ============================================================================

/**
 * @returns the number of rows ported over from prior weeks (0 in 'full' mode).
 */
async function runEnrichment(
  runId: string,
  weekEndDate: string,
  mode: KeepaEnrichmentMode,
): Promise<number> {
  // Dedicated pool for this job. One connection across all batches —
  // much cheaper than the per-batch pool open/close in the prior
  // step.run model.
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    connectionTimeoutMillis: 20_000,
    statement_timeout: 300_000,
    max: 2, // workload connection + the occasional heartbeat path
  });
  const workClient = await pool.connect();

  // Heartbeat ticker. Uses the shared db client (not workClient) so a
  // long-running query on workClient never blocks heartbeat writes.
  const heartbeatTicker = setInterval(() => {
    updateHeartbeat(runId).catch((e) => {
      console.warn(`[keepa-job ${runId.slice(0, 8)}] heartbeat write failed:`, e);
    });
  }, HEARTBEAT_INTERVAL_MS);

  let portedCount = 0;
  try {
    // PHASE 0 (diff mode only): port forward most-recent 'active'
    // enrichment per ASIN from prior weeks. This satisfies the
    // listScope diff-mode filter for unchanged ASINs, so the Keepa
    // API only gets called for genuinely new ASINs + any prior
    // 'no_price' / 'delisted' / 'error' rows that get a fresh retry.
    //
    // Skip in 'full' mode — the admin button forces a complete re-fetch
    // (run monthly to refresh prices/reviews/etc). In full mode listScope
    // returns every in-scope ASIN except rows enriched <24h ago, and
    // insertRow upserts over the week's existing rows. At Keepa pacing
    // (~25k ASINs / 5.4h) a full pass over ~135k ASINs runs ~29 hours.
    if (mode === 'diff') {
      portedCount = await portRowsFromPriorWeeks(workClient, weekEndDate);
      console.log(
        `[keepa-job ${runId.slice(0, 8)}] week ${weekEndDate}: ported ${portedCount} rows from prior weeks (diff mode)`,
      );
    } else {
      console.log(`[keepa-job ${runId.slice(0, 8)}] week ${weekEndDate}: FULL mode — no port-over`);
    }

    const asins = await listScope(workClient, weekEndDate, mode);
    console.log(
      `[keepa-job ${runId.slice(0, 8)}] week ${weekEndDate}: ${asins.length} ASINs to enrich via Keepa API`,
    );
    await updateRunTotalAsins(runId, asins.length);

    if (asins.length === 0) {
      // Nothing to do — common case if re-firing for an already-complete week,
      // OR (diff mode) if every in-scope ASIN was already enriched in a prior week.
      await markRunCompleted(runId);
      return portedCount;
    }

    const pacer = new KeepaPacer();
    const totals: Record<AsinEnrichmentStatus, number> = {
      active: 0,
      no_price: 0,
      delisted: 0,
      error: 0,
    };
    let processed = 0;

    for (let batchStart = 0; batchStart < asins.length; batchStart += BATCH_SIZE) {
      const batch = asins.slice(batchStart, batchStart + BATCH_SIZE);
      for (const asin of batch) {
        await pacer.maybeSleep();
        let row: EnrichmentRow;
        try {
          const r = await callKeepa(asin, { rating: true });
          pacer.observe(r.tokensLeft);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          row = parseKeepaProduct((r.data.products as any)?.[0], asin, weekEndDate);
        } catch (fetchErr) {
          row = emptyRow(
            asin,
            weekEndDate,
            'error',
            fetchErr instanceof Error ? fetchErr.message : String(fetchErr),
          );
        }

        try {
          await insertRow(workClient, row);
          totals[row.enrichment_status] += 1;
          processed += 1;
        } catch (insertErr) {
          // DB-side failure on a single row — log and continue. The ASIN
          // will reappear on the next listScope and get retried.
          console.warn(
            `[keepa-job ${runId.slice(0, 8)}] insert failed for ${asin}, skipping:`,
            insertErr instanceof Error ? insertErr.message : insertErr,
          );
        }
      }

      // Per-batch progress update (also serves as a heartbeat).
      await updateRunCounts(runId, {
        processedAsins: processed,
        activeCount: totals.active,
        noPriceCount: totals.no_price,
        delistedCount: totals.delisted,
        errorCount: totals.error,
      });

      // Occasional progress log
      if ((batchStart / BATCH_SIZE) % 20 === 0) {
        console.log(
          `[keepa-job ${runId.slice(0, 8)}] batch ${batchStart / BATCH_SIZE + 1}/${Math.ceil(asins.length / BATCH_SIZE)}` +
            ` — processed=${processed} active=${totals.active} no_price=${totals.no_price} err=${totals.error}`,
        );
      }
    }

    await markRunCompleted(runId);
    return portedCount;
  } finally {
    clearInterval(heartbeatTicker);
    workClient.release();
    await pool.end();
  }
}

/**
 * Port forward most-recent 'active' enrichments from prior weeks into
 * the current week, for any ASIN that's in this week's enrichment
 * scope (top-100k SFR, non-excluded category).
 *
 * Single INSERT … SELECT DISTINCT ON. ON CONFLICT DO NOTHING handles
 * the case where the row was already inserted (e.g., recovery scenarios).
 *
 * Only 'active' rows are ported. Prior 'no_price' / 'delisted' / 'error'
 * rows are intentionally NOT ported so the Keepa worker re-attempts
 * them this week — they're cheap (~5% of total) and self-healing.
 *
 * Returns the count of rows successfully inserted.
 */
async function portRowsFromPriorWeeks(client: PoolClient, weekEndDate: string): Promise<number> {
  const year = new Date(`${weekEndDate}T00:00:00Z`).getUTCFullYear();
  const partition = `keyword_weekly_metrics_${year}`;
  const exclPlaceholders = EXCLUDED_CATEGORIES_ARRAY
    .map((_, i) => `$${i + 2}`)
    .join(',');

  const { rowCount } = await client.query(
    `
    INSERT INTO asin_weekly_data (
      asin, week_end_date,
      title, brand, image_url,
      category_path, category_root, category_leaf,
      current_price_cents, sales_rank, review_count, average_rating_x10,
      last_rating_update,
      avg30_price_cents, avg90_price_cents, avg180_price_cents, avg365_price_cents,
      variations, promotions,
      enrichment_status, enriched_at, error_message
    )
    SELECT DISTINCT ON (a.asin)
      a.asin, $1::date,
      a.title, a.brand, a.image_url,
      a.category_path, a.category_root, a.category_leaf,
      a.current_price_cents, a.sales_rank, a.review_count, a.average_rating_x10,
      a.last_rating_update,
      a.avg30_price_cents, a.avg90_price_cents, a.avg180_price_cents, a.avg365_price_cents,
      a.variations, a.promotions,
      'active'::asin_enrichment_status, NOW(), NULL
    FROM asin_weekly_data a
    JOIN (
      SELECT DISTINCT t.asin
      FROM ${partition} kwm
      CROSS JOIN LATERAL (VALUES
        (kwm.top_clicked_product_1_asin),
        (kwm.top_clicked_product_2_asin),
        (kwm.top_clicked_product_3_asin)
      ) AS t(asin)
      WHERE kwm.week_end_date = $1::date
        AND kwm.actual_rank <= 100000
        AND (
          kwm.top_clicked_category_1 IS NULL
          OR kwm.top_clicked_category_1 NOT IN (${exclPlaceholders})
        )
        AND t.asin IS NOT NULL
    ) target ON a.asin = target.asin
    WHERE a.enrichment_status = 'active'
      AND a.week_end_date < $1::date
    ORDER BY a.asin, a.week_end_date DESC
    ON CONFLICT (asin, week_end_date) DO NOTHING
    `,
    [weekEndDate, ...EXCLUDED_CATEGORIES_ARRAY],
  );
  return rowCount ?? 0;
}

// ============================================================================
// Candidate query + per-row INSERT — moved from inngest/functions/enrichKeepaForWeek.ts
// ============================================================================

/**
 * Candidate ASIN set for a given week:
 *   1. top-3 in-scope ASINs (rank ≤ 100K, NOT excluded category).
 *   2. PLUS: ASINs previously marked 'delisted' whose most-recent
 *      enriched_at is > 30 days old AND that are still in scope this
 *      week. (Task 6 mechanism.)
 *
 * The final filter depends on mode:
 *   diff — skip any ASIN that already has a row for this week (ported
 *          or fetched): only genuinely new ASINs hit the Keepa API.
 *   full — skip only rows enriched within the last 24h, so a full run
 *          RE-FETCHES every carried-forward price/review even though
 *          the week already has rows. The 24h guard makes a crashed
 *          multi-hour run resumable (re-fire skips what it already
 *          refreshed) and makes an immediate re-fire a loud no-op.
 *          (Before 2026-07-09 full mode used the diff filter, so firing
 *          it after the weekly enrichment silently fetched nothing.)
 */
async function listScope(
  client: PoolClient,
  weekEndDate: string,
  mode: KeepaEnrichmentMode,
): Promise<string[]> {
  const year = new Date(`${weekEndDate}T00:00:00Z`).getUTCFullYear();
  const partition = `keyword_weekly_metrics_${year}`;
  const exclPlaceholders = EXCLUDED_CATEGORIES_ARRAY
    .map((_, i) => `$${i + 2}`)
    .join(',');
  const alreadyCoveredCondition =
    mode === 'full'
      ? `a.asin = c.asin AND a.week_end_date = $1::date AND a.enriched_at > NOW() - INTERVAL '24 hours'`
      : `a.asin = c.asin AND a.week_end_date = $1::date`;

  const { rows } = await client.query<{ asin: string }>(
    `
    WITH new_candidates AS (
      SELECT t.asin
      FROM ${partition} kwm
      CROSS JOIN LATERAL (VALUES
        (kwm.top_clicked_product_1_asin),
        (kwm.top_clicked_product_2_asin),
        (kwm.top_clicked_product_3_asin)
      ) AS t(asin)
      WHERE kwm.week_end_date = $1::date
        AND kwm.actual_rank <= 100000
        AND (
          kwm.top_clicked_category_1 IS NULL
          OR kwm.top_clicked_category_1 NOT IN (${exclPlaceholders})
        )
        AND t.asin IS NOT NULL
    ),
    delisted_recheck AS (
      SELECT a.asin
      FROM asin_weekly_data a
      WHERE a.enrichment_status = 'delisted'
        AND a.enriched_at < NOW() - INTERVAL '30 days'
        AND a.asin IN (SELECT asin FROM new_candidates)
        AND NOT EXISTS (
          SELECT 1 FROM asin_weekly_data a2
          WHERE a2.asin = a.asin
            AND a2.enriched_at > a.enriched_at
        )
    ),
    all_candidates AS (
      SELECT asin FROM new_candidates
      UNION
      SELECT asin FROM delisted_recheck
    )
    SELECT DISTINCT c.asin
    FROM all_candidates c
    WHERE NOT EXISTS (
      SELECT 1 FROM asin_weekly_data a
      WHERE ${alreadyCoveredCondition}
    )
    `,
    [weekEndDate, ...EXCLUDED_CATEGORIES_ARRAY],
  );
  return rows.map((r) => r.asin);
}

/**
 * Upsert a fetched row. DO UPDATE (not DO NOTHING) so full-mode re-fetches
 * overwrite the week's carried-forward values with fresh Keepa data, and
 * diff-mode recovery conflicts land the fresher fetch.
 *
 * Downgrade guard: never replace an existing 'active' row with an 'error'
 * row — a transient Keepa failure during a re-fetch must not wipe good
 * (if stale) data. The errored ASIN stays >24h-old, so the next full run
 * retries it.
 */
async function insertRow(client: PoolClient, row: EnrichmentRow): Promise<void> {
  await client.query(
    `
    INSERT INTO asin_weekly_data (
      asin, week_end_date, title, brand, image_url,
      category_path, category_root, category_leaf,
      current_price_cents, sales_rank, review_count, average_rating_x10, last_rating_update,
      avg30_price_cents, avg90_price_cents, avg180_price_cents, avg365_price_cents,
      variations, promotions, enrichment_status, error_message
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
    ON CONFLICT (asin, week_end_date) DO UPDATE SET
      title = EXCLUDED.title,
      brand = EXCLUDED.brand,
      image_url = EXCLUDED.image_url,
      category_path = EXCLUDED.category_path,
      category_root = EXCLUDED.category_root,
      category_leaf = EXCLUDED.category_leaf,
      current_price_cents = EXCLUDED.current_price_cents,
      sales_rank = EXCLUDED.sales_rank,
      review_count = EXCLUDED.review_count,
      average_rating_x10 = EXCLUDED.average_rating_x10,
      last_rating_update = EXCLUDED.last_rating_update,
      avg30_price_cents = EXCLUDED.avg30_price_cents,
      avg90_price_cents = EXCLUDED.avg90_price_cents,
      avg180_price_cents = EXCLUDED.avg180_price_cents,
      avg365_price_cents = EXCLUDED.avg365_price_cents,
      variations = EXCLUDED.variations,
      promotions = EXCLUDED.promotions,
      enrichment_status = EXCLUDED.enrichment_status,
      error_message = EXCLUDED.error_message,
      enriched_at = NOW()
    WHERE NOT (
      asin_weekly_data.enrichment_status = 'active'
      AND EXCLUDED.enrichment_status = 'error'
    )
    `,
    [
      row.asin,
      row.week_end_date,
      row.title,
      row.brand,
      row.image_url,
      row.category_path,
      row.category_root,
      row.category_leaf,
      row.current_price_cents,
      row.sales_rank,
      row.review_count,
      row.average_rating_x10,
      row.last_rating_update,
      row.avg30_price_cents,
      row.avg90_price_cents,
      row.avg180_price_cents,
      row.avg365_price_cents,
      row.variations !== null ? JSON.stringify(row.variations) : null,
      row.promotions !== null ? JSON.stringify(row.promotions) : null,
      row.enrichment_status,
      row.error_message,
    ],
  );
}

/**
 * Read the status histogram for the email at end-of-run. Exported for
 * the orchestrator to call in its send-email step.
 */
export async function readStatusHistogram(
  weekEndDate: string,
): Promise<Record<AsinEnrichmentStatus, number>> {
  const result = await db.execute<{ status: string; n: number }>(sql`
    SELECT enrichment_status::text AS status, COUNT(*)::int AS n
    FROM asin_weekly_data
    WHERE week_end_date = ${weekEndDate}::date
    GROUP BY 1
  `);
  const counts: Record<AsinEnrichmentStatus, number> = {
    active: 0,
    no_price: 0,
    delisted: 0,
    error: 0,
  };
  for (const r of result.rows) {
    if (
      r.status === 'active' ||
      r.status === 'no_price' ||
      r.status === 'delisted' ||
      r.status === 'error'
    ) {
      counts[r.status as AsinEnrichmentStatus] = r.n;
    }
  }
  return counts;
}

/** Reference used by the orchestrator to typecheck the status values. */
export type { KeepaEnrichmentRunStatus };
