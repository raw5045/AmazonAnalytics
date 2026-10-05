// services/keepa/pgStore.ts
/**
 * Postgres implementation of KeepaStore (spec 2026-10-05 §5.1 steps 2 and 6, §5.2).
 *
 * Claims: lane by lane, each an index-ordered `SELECT … FOR UPDATE SKIP LOCKED LIMIT n` turned
 * into an UPDATE, all in one transaction. Writes: one transaction per batch — a per-row UPDATE
 * (success / delisted / error shape), one snapshot INSERT per fetched row (an error is not a
 * fetch, so it writes none), the status row last.
 *
 * Concurrency: the weekly enqueue upsert (lib/keepa/enqueueWeek.ts) holds the exclusive advisory
 * lock ENQUEUE_LOCK_KEY while it row-locks ~2.3M catalog rows in its own order. Every store
 * transaction (the stale-claim release, the claim, both batch writes) takes the shared form first,
 * before any row lock, so while an upsert runs the service waits before claiming — instead of a
 * batch write deadlocking with it, the release running into the statement timeout on its row
 * locks, or a claim spending tokens on a batch whose write would then block.
 */
import type { Pool, PoolClient } from 'pg';
import { ENQUEUE_LOCK_KEY, nextDueAfterDelisted, nextDueAfterError, nextDueAfterSuccess, type Lane, type Tier } from '@/lib/keepa/lanes';
import { emptyFacts, type ProductFacts } from '@/lib/keepa/productFacts';
import type { ClaimedRow, KeepaStore, TokenInfo } from './store';

interface ClaimRowRaw {
  asin: string;
  tier: number;
  last_fetched_at: Date | null;
  consecutive_errors: number;
}

const CLAIM_NEW = `
  WITH picked AS (
    SELECT asin FROM asin_products
    WHERE in_scope AND claimed_at IS NULL AND last_fetched_at IS NULL AND tier = $1 AND next_due_at <= now()
    ORDER BY best_rank NULLS LAST, asin
    LIMIT $2
    FOR UPDATE SKIP LOCKED
  )
  UPDATE asin_products p SET claimed_at = now(), claimed_by = $3
  FROM picked WHERE p.asin = picked.asin
  RETURNING p.asin, p.tier, p.last_fetched_at, p.consecutive_errors`;

const CLAIM_DUE = `
  WITH picked AS (
    SELECT asin FROM asin_products
    WHERE in_scope AND claimed_at IS NULL AND last_fetched_at IS NOT NULL AND tier = $1 AND next_due_at <= now()
    ORDER BY next_due_at, asin
    LIMIT $2
    FOR UPDATE SKIP LOCKED
  )
  UPDATE asin_products p SET claimed_at = now(), claimed_by = $3
  FROM picked WHERE p.asin = picked.asin
  RETURNING p.asin, p.tier, p.last_fetched_at, p.consecutive_errors`;

/**
 * The due date follows the row's CURRENT tier ($30 weekly, $31 monthly), not the tier read at
 * claim time: a weekly upsert that promoted a claimed tier-2 row to tier 1 and pulled it forward
 * must not be undone by a +30-day write. The casts are required: untyped parameters inside a
 * CASE resolve to text, which Postgres will not assign to a timestamptz column.
 */
const SUCCESS_UPDATE = `
  UPDATE asin_products SET
    title = $2, brand = $3, image_url = $4, category_path = $5, category_root = $6, category_leaf = $7,
    listed_since = $8, tracking_since = $9,
    current_price_cents = $10, price_source = $11, sales_rank = $12, review_count = $13, average_rating_x10 = $14, last_rating_update = $15,
    monthly_sold = $16, keepa_updated_at = $17, new_offer_count = $18, fba_offer_count = $19, fbm_offer_count = $20, amazon_availability = $21,
    avg30_price_cents = $22, avg90_price_cents = $23, avg180_price_cents = $24, avg365_price_cents = $25, avg30_sales_rank = $26, avg90_sales_rank = $27,
    enrichment_status = $28::asin_enrichment_status, error_code = NULL,
    last_fetched_at = $29, fetch_count = fetch_count + 1, consecutive_errors = 0,
    next_due_at = CASE WHEN tier = 1 THEN $30::timestamptz ELSE $31::timestamptz END, claimed_at = NULL, claimed_by = NULL, updated_at = now()
  WHERE asin = $1`;

const DELISTED_UPDATE = `
  UPDATE asin_products SET
    enrichment_status = 'delisted', error_code = NULL,
    last_fetched_at = $2, fetch_count = fetch_count + 1, consecutive_errors = 0,
    next_due_at = $3, claimed_at = NULL, claimed_by = NULL, updated_at = now()
  WHERE asin = $1`;

/** Never downgrades a fetched row: facts and status stay unless the ASIN was never fetched. */
const ERROR_UPDATE = `
  UPDATE asin_products SET
    enrichment_status = CASE WHEN last_fetched_at IS NULL THEN 'error'::asin_enrichment_status ELSE enrichment_status END,
    error_code = $2, consecutive_errors = consecutive_errors + 1,
    next_due_at = $3, claimed_at = NULL, claimed_by = NULL, updated_at = now()
  WHERE asin = $1`;

const SNAPSHOT_INSERT = `
  INSERT INTO asin_snapshots (asin, fetched_at, current_price_cents, sales_rank, review_count, average_rating_x10,
    monthly_sold, new_offer_count, fba_offer_count, fbm_offer_count, enrichment_status)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::asin_enrichment_status)
  ON CONFLICT DO NOTHING`;

type Queryable = Pick<PoolClient, 'query'>;

async function writeRow(c: Queryable, row: ClaimedRow, f: ProductFacts, now: Date): Promise<void> {
  if (f.status === 'active' || f.status === 'no_price') {
    await c.query(SUCCESS_UPDATE, [
      row.asin, f.title, f.brand, f.imageUrl, f.categoryPath, f.categoryRoot, f.categoryLeaf,
      f.listedSince, f.trackingSince,
      f.currentPriceCents, f.priceSource, f.salesRank, f.reviewCount, f.averageRatingX10, f.lastRatingUpdate,
      f.monthlySold, f.keepaUpdatedAt, f.newOfferCount, f.fbaOfferCount, f.fbmOfferCount, f.amazonAvailability,
      f.avg30PriceCents, f.avg90PriceCents, f.avg180PriceCents, f.avg365PriceCents, f.avg30SalesRank, f.avg90SalesRank,
      f.status, now, nextDueAfterSuccess(1, now), nextDueAfterSuccess(2, now),
    ]);
  } else if (f.status === 'delisted') {
    await c.query(DELISTED_UPDATE, [row.asin, now, nextDueAfterDelisted(now)]);
  } else {
    await c.query(ERROR_UPDATE, [row.asin, f.errorCode ?? 'error', nextDueAfterError(row.consecutiveErrors + 1, now)]);
  }
  // One snapshot per fetch. An error is not a fetch (a bad object, a row missing from the parse,
  // a batch Keepa never answered), so it writes none; delisted and no_price fetches still do.
  if (f.status === 'error') return;
  await c.query(SNAPSHOT_INSERT, [
    row.asin, now, f.currentPriceCents, f.salesRank, f.reviewCount, f.averageRatingX10,
    f.monthlySold, f.newOfferCount, f.fbaOfferCount, f.fbmOfferCount, f.status,
  ]);
}

/**
 * Wait for any running enqueue-week upsert (spec §6.1): the upsert holds the exclusive form of
 * ENQUEUE_LOCK_KEY for minutes and locks rows in a different order than a batch write, so a batch
 * that started mid-upsert would deadlock with it. Taken by every store transaction, before any row
 * lock. The 20-minute statement timeout covers the lock wait only (a weekly upsert over ~2.3M rows
 * outlasts the pool's five-minute ceiling); once the lock is held it goes back to five minutes, so
 * the row statements keep the pool's ceiling.
 */
async function awaitEnqueueLock(c: Queryable): Promise<void> {
  await c.query(`SET LOCAL statement_timeout = '1200s'`);
  await c.query('SELECT pg_advisory_xact_lock_shared($1)', [ENQUEUE_LOCK_KEY]);
  await c.query(`SET LOCAL statement_timeout = '300s'`);
}

async function inTransaction<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    try {
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    }
  } finally {
    c.release();
  }
}

export class PgKeepaStore implements KeepaStore {
  constructor(private readonly pool: Pool) {}

  async recordBoot(bootId: string, tailEnabled: boolean): Promise<void> {
    await this.pool.query(
      `INSERT INTO keepa_service_status (singleton, boot_id, booted_at, heartbeat_at, tail_enabled)
       VALUES (true, $1, now(), now(), $2)
       ON CONFLICT (singleton) DO UPDATE SET boot_id = EXCLUDED.boot_id, booted_at = EXCLUDED.booted_at,
         heartbeat_at = now(), tail_enabled = EXCLUDED.tail_enabled`,
      [bootId, tailEnabled],
    );
  }

  async releaseStaleClaims(olderThanMs: number): Promise<number> {
    return inTransaction(this.pool, async (c) => {
      await awaitEnqueueLock(c);
      const r = await c.query(
        `UPDATE asin_products SET claimed_at = NULL, claimed_by = NULL WHERE claimed_at IS NOT NULL AND claimed_at < now() - make_interval(secs => $1::float8)`,
        [olderThanMs / 1000],
      );
      return r.rowCount ?? 0;
    });
  }

  async claimBatch(args: { limit: number; tailEnabled: boolean; bootId: string }): Promise<ClaimedRow[]> {
    const plan: Array<{ sql: string; tier: Tier; lane: Lane }> = [
      { sql: CLAIM_NEW, tier: 1, lane: 'new' },
      { sql: CLAIM_DUE, tier: 1, lane: 'due' },
      ...(args.tailEnabled
        ? [{ sql: CLAIM_NEW, tier: 2 as Tier, lane: 'tail' as Lane }, { sql: CLAIM_DUE, tier: 2 as Tier, lane: 'tail' as Lane }]
        : []),
    ];
    return inTransaction(this.pool, async (c) => {
      await awaitEnqueueLock(c);
      const out: ClaimedRow[] = [];
      for (const step of plan) {
        const remaining = args.limit - out.length;
        if (remaining <= 0) break;
        const r = await c.query<ClaimRowRaw>(step.sql, [step.tier, remaining, args.bootId]);
        for (const row of r.rows) {
          out.push({ asin: row.asin, tier: step.tier, lane: step.lane, lastFetchedAt: row.last_fetched_at, consecutiveErrors: row.consecutive_errors });
        }
      }
      return out;
    });
  }

  async writeBatch(args: { rows: ClaimedRow[]; facts: Map<string, ProductFacts>; lane: Lane; tokens: TokenInfo; now: Date }): Promise<void> {
    await inTransaction(this.pool, async (c) => {
      await awaitEnqueueLock(c);
      for (const row of args.rows) {
        await writeRow(c, row, args.facts.get(row.asin) ?? emptyFacts(row.asin, 'error', 'missing_from_parse'), args.now);
      }
      await c.query(
        `UPDATE keepa_service_status SET heartbeat_at = now(), last_batch_at = $1, last_batch_lane = $2,
           tokens_left = COALESCE($3, tokens_left), refill_rate = COALESCE($4, refill_rate) WHERE singleton`,
        [args.now, args.lane, args.tokens.tokensLeft, args.tokens.refillRate],
      );
    });
  }

  async markBatchErrored(args: { rows: ClaimedRow[]; errorCode: string; now: Date }): Promise<void> {
    await inTransaction(this.pool, async (c) => {
      await awaitEnqueueLock(c);
      for (const row of args.rows) await writeRow(c, row, emptyFacts(row.asin, 'error', args.errorCode), args.now);
      await c.query(`UPDATE keepa_service_status SET heartbeat_at = now(), last_error_code = $1, last_error_at = now() WHERE singleton`, [args.errorCode]);
    });
  }

  async heartbeat(tokens: TokenInfo): Promise<void> {
    await this.pool.query(
      `UPDATE keepa_service_status SET heartbeat_at = now(), tokens_left = COALESCE($1, tokens_left), refill_rate = COALESCE($2, refill_rate) WHERE singleton`,
      [tokens.tokensLeft, tokens.refillRate],
    );
  }

  async recordError(code: string): Promise<void> {
    await this.pool.query(`UPDATE keepa_service_status SET heartbeat_at = now(), last_error_code = $1, last_error_at = now() WHERE singleton`, [code]);
  }

  async markNewLaneDrained(): Promise<void> {
    await this.pool.query(`UPDATE keepa_service_status SET lane_new_drained_at = now() WHERE singleton`);
  }
}
