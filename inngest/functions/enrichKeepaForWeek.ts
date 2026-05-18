/**
 * Weekly Keepa enrichment Inngest function.
 *
 * Triggered by event `keepa.enrich-week-requested` with payload
 * `{ weekEndDate: string }`. Used by:
 *   - refreshSummary, after each kcs swap (recurring weekly maintenance)
 *   - Manual fire from the Inngest dashboard (initial backfill — Task 5)
 *
 * Architecture:
 *   - Runs on the Railway worker (no Vercel timeout ceiling).
 *   - Splits work into BATCH_SIZE-ASIN step.runs so each batch fits well
 *     under Inngest's HTTP step-execution timeout. step.run checkpoints
 *     each batch, so a worker restart resumes from the last completed
 *     batch — no double-spending tokens on already-enriched ASINs.
 *   - `concurrency: { limit: 1, key: 'event.data.weekEndDate' }` so a
 *     duplicate trigger event (or rapid manual re-fire) can't spawn a
 *     parallel run that fights for Keepa tokens.
 *   - On final completion, fires an admin email via Resend.
 *
 * Token math (2 tokens / ASIN with rating=1):
 *   ~140K ASINs × 2 = 280K tokens
 *   250 tokens/min tier → ~19 h wall time
 *   BATCH_SIZE 250 → ~280 batches, each ~2 min API time
 */
import { Pool, type PoolClient } from 'pg';
import { inngest } from '../client';
import { callKeepa, KeepaPacer } from '@/lib/keepa/client';
import { parseKeepaProduct, emptyRow } from '@/lib/keepa/parse';
import { EXCLUDED_CATEGORIES_ARRAY } from '@/lib/keepa/categoryExclusions';
import type { EnrichmentRow, AsinEnrichmentStatus } from '@/lib/keepa/types';
import { sendEnrichmentEmail } from '@/lib/notifications/sendEnrichmentEmail';

// Why 50 (not 250 as initially):
// On 2026-05-15 the first real backfill attempt with BATCH_SIZE=250 failed
// after 71s with Inngest's "Application failed to respond" — each step.run
// HTTP execution has a connection timeout (observed ~60-70s window). At
// our measured pace of ~0.5s/ASIN, a 250-ASIN batch = ~2 minutes, well
// over the timeout. 50-ASIN batches = ~25s per step.run, safe margin.
//
// Trade-off: more batches (140K / 50 = ~2.8K vs 560), so more Inngest
// step.run overhead. Each step.run boundary is a network round-trip
// between Inngest Cloud and the Railway worker — but each is small,
// and the total wall time is dominated by Keepa's 250 tokens/min rate
// limit, not by batch overhead. We can revisit if needed.
const BATCH_SIZE = 50;

/**
 * Run a callback against a freshly-opened pg.Pool, ensure it's torn
 * down afterward. Each Inngest step.run is a fresh function invocation
 * in the worker — no point keeping pools alive between batches.
 */
async function withPool<T>(fn: (pool: Pool) => Promise<T>): Promise<T> {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    connectionTimeoutMillis: 20_000,
    statement_timeout: 300_000, // 5 min ceiling per statement
  });
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

/**
 * Candidate ASIN set for a given week:
 *
 *   1. top-3 in-scope ASINs (rank ≤ 100K, NOT excluded category) that
 *      don't already have a row in asin_weekly_data for this week.
 *   2. PLUS: ASINs previously marked 'delisted' whose most-recent
 *      enriched_at is > 30 days old AND that are still in scope this
 *      week. (Task 6 mechanism — built in here so it just works on
 *      every cycle.) If the ASIN's already been re-enriched in a more
 *      recent week (status flipped active), the EXISTS check below
 *      filters it out.
 */
async function listScope(weekEndDate: string): Promise<string[]> {
  // weekEndDate is ISO YYYY-MM-DD; UTC-anchor for partition lookup.
  const year = new Date(`${weekEndDate}T00:00:00Z`).getUTCFullYear();
  const partition = `keyword_weekly_metrics_${year}`;
  const exclPlaceholders = EXCLUDED_CATEGORIES_ARRAY
    .map((_, i) => `$${i + 2}`)
    .join(',');

  return withPool(async (pool) => {
    const c = await pool.connect();
    try {
      const { rows } = await c.query<{ asin: string }>(
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
              -- skip if a later row already flipped it to a non-delisted state
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
          WHERE a.asin = c.asin AND a.week_end_date = $1::date
        )
        `,
        [weekEndDate, ...EXCLUDED_CATEGORIES_ARRAY],
      );
      return rows.map((r) => r.asin);
    } finally {
      c.release();
    }
  });
}

/**
 * Process one batch of ASINs sequentially with the pacer, INSERT each
 * row into asin_weekly_data. Per-ASIN errors are caught and recorded
 * as status='error' rows — a single bad fetch never kills the batch.
 */
async function processBatch(asins: string[], weekEndDate: string): Promise<void> {
  await withPool(async (pool) => {
    const c = await pool.connect();
    try {
      const pacer = new KeepaPacer();
      for (const asin of asins) {
        await pacer.maybeSleep();
        let row: EnrichmentRow;
        try {
          const r = await callKeepa(asin, { rating: true });
          pacer.observe(r.tokensLeft);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          row = parseKeepaProduct((r.data.products as any)?.[0], asin, weekEndDate);
        } catch (e) {
          row = emptyRow(asin, weekEndDate, 'error', (e as Error).message);
        }
        await insertRow(c, row);
      }
    } finally {
      c.release();
    }
  });
}

/** Raw parameterized INSERT — snake_case throughout, no drizzle mapping needed. */
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
    ON CONFLICT (asin, week_end_date) DO NOTHING
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
 * Aggregate status counts for the week — used in the completion email.
 * Read from the DB (not from in-memory counters) because Inngest step.run
 * replays could double-count an in-memory counter; the DB is the source
 * of truth after ON CONFLICT DO NOTHING idempotency.
 */
async function readStatusHistogram(
  weekEndDate: string,
): Promise<Record<AsinEnrichmentStatus, number>> {
  return withPool(async (pool) => {
    const c = await pool.connect();
    try {
      const { rows } = await c.query<{ status: string; n: number }>(
        `
        SELECT enrichment_status::text AS status, COUNT(*)::int AS n
        FROM asin_weekly_data
        WHERE week_end_date = $1::date
        GROUP BY 1
        `,
        [weekEndDate],
      );
      const counts: Record<AsinEnrichmentStatus, number> = {
        active: 0, no_price: 0, delisted: 0, error: 0,
      };
      for (const r of rows) {
        if (
          r.status === 'active' ||
          r.status === 'no_price' ||
          r.status === 'delisted' ||
          r.status === 'error'
        ) {
          counts[r.status] = r.n;
        }
      }
      return counts;
    } finally {
      c.release();
    }
  });
}

export const enrichKeepaForWeek = inngest.createFunction(
  {
    id: 'enrich-keepa-for-week',
    name: 'Enrich Keepa data for a week',
    // Single-run mutex keyed on the week. Prevents a duplicate trigger
    // event (or rapid manual re-fire) from spawning a parallel run that
    // would race for Keepa tokens. Different weeks could in principle
    // run concurrently — but we'll only ever fire one at a time anyway.
    concurrency: { limit: 1, key: 'event.data.weekEndDate' },
    retries: 0, // step.run handles batch-level retries; no function-level retry
    triggers: [{ event: 'keepa.enrich-week-requested' }],
  },
  async ({ event, step }) => {
    const { weekEndDate } = event.data as { weekEndDate: string };

    // Init: capture startedAt + asin list once, cache via step.run so a
    // replay reads the same values rather than re-listing / re-clocking.
    const init = await step.run('init', async () => ({
      startedAt: Date.now(),
      asins: await listScope(weekEndDate),
    }));
    const { startedAt, asins } = init;

    if (asins.length === 0) {
      // Nothing to do — skip email and exit. Common case: re-firing the
      // event for a week that's already fully enriched.
      return { weekEndDate, totalAsins: 0, batches: 0, skipped: true };
    }

    // Slice into BATCH_SIZE batches.
    const batches: string[][] = [];
    for (let i = 0; i < asins.length; i += BATCH_SIZE) {
      batches.push(asins.slice(i, i + BATCH_SIZE));
    }

    // Each batch is its own step.run — checkpointed by Inngest. If a
    // batch errors mid-way, Inngest retries the entire batch (default
    // 3 retries); the ON CONFLICT DO NOTHING in insertRow makes
    // already-inserted ASINs idempotent (we double-spend tokens on
    // retry but never corrupt data).
    //
    // The try/catch is the second layer of resilience: if step.run
    // exhausts Inngest's internal retries on a single batch, we LOG
    // and CONTINUE rather than failing the whole function. Without
    // this, a single bad batch out of ~2,800 would kill the entire
    // ~19h run. The skipped ASINs naturally reappear on the next
    // listScope (since they weren't enriched), so a re-fire picks
    // them up. Track the count so we can include it in the email.
    let failedBatches = 0;
    for (let i = 0; i < batches.length; i++) {
      try {
        await step.run(`batch-${i.toString().padStart(4, '0')}`, () =>
          processBatch(batches[i], weekEndDate),
        );
      } catch (e) {
        failedBatches += 1;
        console.error(
          `[enrichKeepaForWeek] batch ${i} (${batches[i].length} ASINs) failed after retries — continuing.`,
          e instanceof Error ? e.message : String(e),
        );
      }
    }

    // Final step: read the status histogram from the DB, send the
    // admin email. Wrapping in step.run means a Resend flake gets
    // retried independently of the enrichment work.
    await step.run('send-completion-email', async () => {
      const counts = await readStatusHistogram(weekEndDate);
      await sendEnrichmentEmail({
        weekEndDate,
        counts,
        durationMs: Date.now() - startedAt,
        tokensSpent: asins.length * 2,
      });
    });

    return {
      weekEndDate,
      totalAsins: asins.length,
      batches: batches.length,
      failedBatches,
      durationMs: Date.now() - startedAt,
    };
  },
);
