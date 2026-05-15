/**
 * Dev smoke test: validate the full Keepa enrichment pipeline against a
 * 50-ASIN slice of the current kcs week.
 *
 * Catches bugs that the captured fixtures might miss — fresh wire data
 * exercises the parser's robustness in ways pre-recorded fixtures can't.
 *
 * Cost: ~100 tokens (~25 s wall, less if no token-bucket pauses).
 * Idempotent via ON CONFLICT DO NOTHING — re-runs only fetch the
 * not-yet-enriched ASINs.
 *
 * NOT the production backfill. The real 140K-ASIN run goes through the
 * Inngest function (Task 4) on the Railway worker — that gives us
 * automatic resilience to laptop sleep / network blips / restarts
 * during the ~19h enrichment.
 *
 * Usage:
 *   pnpm tsx scripts/keepaSmokeTest.ts
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { Pool, type PoolClient } from 'pg';
import { callKeepa, KeepaPacer } from '@/lib/keepa/client';
import { parseKeepaProduct, emptyRow } from '@/lib/keepa/parse';
import { EXCLUDED_CATEGORIES_ARRAY } from '@/lib/keepa/categoryExclusions';
import type { EnrichmentRow, AsinEnrichmentStatus } from '@/lib/keepa/types';

const SAMPLE_SIZE = 50;

/**
 * Returns up to SAMPLE_SIZE distinct ASINs from the current week that
 * are in-scope (top-3 slot, rank ≤ 100K, not in an excluded category)
 * and NOT already enriched. Re-running the script picks up only the
 * remaining ASINs, so this is naturally resumable.
 */
async function listCandidates(
  client: PoolClient,
  weekEndDate: string,
  partition: string,
): Promise<string[]> {
  const exclPlaceholders = EXCLUDED_CATEGORIES_ARRAY
    .map((_, i) => `$${i + 2}`)
    .join(',');
  const { rows } = await client.query<{ asin: string }>(
    `
    WITH candidates AS (
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
    )
    SELECT DISTINCT c.asin
    FROM candidates c
    WHERE NOT EXISTS (
      SELECT 1 FROM asin_weekly_data a
      WHERE a.asin = c.asin AND a.week_end_date = $1::date
    )
    LIMIT ${SAMPLE_SIZE}
    `,
    [weekEndDate, ...EXCLUDED_CATEGORIES_ARRAY],
  );
  return rows.map((r) => r.asin);
}

/**
 * Insert one EnrichmentRow into asin_weekly_data via raw parameterized
 * SQL. Snake-case-everywhere lets us pass EnrichmentRow values directly
 * without a drizzle/JS-name mapping step.
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

function formatPrice(cents: number | null): string {
  return cents !== null ? `$${(cents / 100).toFixed(2)}` : '   null';
}

function formatRating(x10: number | null): string {
  return x10 !== null ? `${(x10 / 10).toFixed(1)}★` : 'null';
}

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL!,
    statement_timeout: 60_000,
  });
  const client = await pool.connect();

  try {
    const { rows: meta } = await client.query<{ week: string; year: string }>(`
      SELECT current_week_end_date::text AS week,
             EXTRACT(YEAR FROM current_week_end_date)::text AS year
      FROM keyword_current_summary_meta WHERE singleton = true
    `);
    const weekEndDate = meta[0].week;
    const partition = `keyword_weekly_metrics_${meta[0].year}`;
    console.log(`\nCurrent week: ${weekEndDate}  (partition: ${partition})\n`);

    const asins = await listCandidates(client, weekEndDate, partition);
    console.log(`Found ${asins.length} candidates (target ${SAMPLE_SIZE}); calling Keepa...\n`);
    if (asins.length === 0) {
      console.log('Nothing to enrich — all candidates already in asin_weekly_data.');
      return;
    }

    const startedAt = Date.now();
    const pacer = new KeepaPacer();
    const counts: Record<AsinEnrichmentStatus, number> = {
      active: 0, no_price: 0, delisted: 0, error: 0,
    };
    const samples: Record<AsinEnrichmentStatus, EnrichmentRow | null> = {
      active: null, no_price: null, delisted: null, error: null,
    };

    let firstTokensLeft: number | null = null;
    let lastTokensLeft: number | null = null;

    for (let i = 0; i < asins.length; i++) {
      const asin = asins[i];
      const sleepInfo = await pacer.maybeSleep();
      if (sleepInfo.slept) {
        console.log(`  (paused ${sleepInfo.ms}ms for token refill)`);
      }

      let row: EnrichmentRow;
      try {
        const r = await callKeepa(asin, { rating: true });
        pacer.observe(r.tokensLeft);
        if (firstTokensLeft === null) firstTokensLeft = r.tokensLeft + 2; // approximate pre-call balance
        lastTokensLeft = r.tokensLeft;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        row = parseKeepaProduct((r.data.products as any)?.[0], asin, weekEndDate);
      } catch (e) {
        row = emptyRow(asin, weekEndDate, 'error', (e as Error).message);
      }

      await insertRow(client, row);
      counts[row.enrichment_status] += 1;
      if (samples[row.enrichment_status] === null) samples[row.enrichment_status] = row;

      console.log(
        `  [${(i + 1).toString().padStart(2)}/${asins.length}]` +
        ` tokensLeft=${lastTokensLeft?.toString().padStart(6) ?? '   n/a'}` +
        ` status=${row.enrichment_status.padEnd(8)}` +
        ` asin=${asin}`,
      );
    }

    const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
    const tokensSpent = firstTokensLeft !== null && lastTokensLeft !== null
      ? firstTokensLeft - lastTokensLeft
      : asins.length * 2;

    console.log(`\n=== Summary ===`);
    console.log(`  Wall time:        ${elapsedSec}s`);
    console.log(`  ASINs processed:  ${asins.length}`);
    console.log(`  Tokens spent:     ${tokensSpent} (≈ ${(tokensSpent / asins.length).toFixed(2)} / ASIN)`);
    console.log(`  Status histogram:`);
    for (const s of ['active', 'no_price', 'delisted', 'error'] as const) {
      console.log(`    ${s.padEnd(10)} ${counts[s].toString().padStart(3)}`);
    }

    console.log(`\nSample rows per status:`);
    for (const s of ['active', 'no_price', 'delisted', 'error'] as const) {
      const row = samples[s];
      if (!row) continue;
      console.log(
        `  [${s.padEnd(8)}] ${row.asin}  ` +
        `price=${formatPrice(row.current_price_cents)}  ` +
        `reviews=${(row.review_count ?? 0).toLocaleString().padStart(8)}  ` +
        `rating=${formatRating(row.average_rating_x10)}  ` +
        `cat=${(row.category_leaf ?? 'null').slice(0, 28).padEnd(28)}  ` +
        `title="${(row.title ?? '').slice(0, 40)}"`,
      );
      if (row.error_message) console.log(`            error: ${row.error_message}`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
