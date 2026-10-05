// tests/integration/keepaService.test.ts
/**
 * Keepa service store against the real tables (migration 0050 applied). Synthetic ASINs
 * prefixed TESTKS are inserted and removed by this file; no real row is touched.
 *
 * Run (owner's go): RUN_INTEGRATION=1 pnpm vitest run tests/integration/keepaService.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { PgKeepaStore } from '@/services/keepa/pgStore';
import { emptyFacts, type ProductFacts } from '@/lib/keepa/productFacts';

const RUN = !!process.env.RUN_INTEGRATION;
const PREFIX = 'TESTKS';
const A = { newTop: `${PREFIX}0001`, newDeep: `${PREFIX}0002`, due: `${PREFIX}0003`, notDue: `${PREFIX}0004`, tier2: `${PREFIX}0005` };

describe.skipIf(!RUN)('Keepa service store (integration)', () => {
  let pool: Pool;
  let store: PgKeepaStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    store = new PgKeepaStore(pool);
    await pool.query(`DELETE FROM asin_snapshots WHERE asin LIKE $1`, [`${PREFIX}%`]);
    await pool.query(`DELETE FROM asin_products WHERE asin LIKE $1`, [`${PREFIX}%`]);
    await pool.query(
      `INSERT INTO asin_products (asin, best_rank, tier, in_scope, last_fetched_at, next_due_at, enrichment_status, title) VALUES
       ($1, 0, 1, true, NULL, now(), NULL, NULL),
       ($2, 1, 1, true, NULL, now(), NULL, NULL),
       ($3, 1000, 1, true, now() - interval '8 days', now() - interval '10 years', 'active', 'old title'),
       ($4, 1000, 1, true, now() - interval '1 day', now() + interval '6 days', 'active', 'fresh'),
       ($5, 1500000, 2, true, NULL, now(), NULL, NULL)`,
      [A.newTop, A.newDeep, A.due, A.notDue, A.tier2],
    );
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DELETE FROM asin_snapshots WHERE asin LIKE $1`, [`${PREFIX}%`]);
    await pool.query(`DELETE FROM asin_products WHERE asin LIKE $1`, [`${PREFIX}%`]);
    await pool.end();
  });

  it('claims never-fetched tier 1 by rank, then due tier 1, skips not-due and tier 2 with the tail off', async () => {
    // Other rows in the real table may be claimable too, so assert on our rows only.
    const rows = await store.claimBatch({ limit: 100, tailEnabled: false, bootId: 'test-boot' });
    const ours = rows.filter((r) => r.asin.startsWith(PREFIX));
    const asins = ours.map((r) => r.asin);
    expect(asins).not.toContain(A.notDue);
    expect(asins).not.toContain(A.tier2);
    const { rows: claimed } = await pool.query<{ asin: string; claimed_by: string }>(`SELECT asin, claimed_by FROM asin_products WHERE asin LIKE $1 AND claimed_at IS NOT NULL`, [`${PREFIX}%`]);
    for (const c of claimed) expect(c.claimed_by).toBe('test-boot');
    // Release everything this test claimed (our rows and any real rows), as a crashed service would after ten minutes.
    await pool.query(`UPDATE asin_products SET claimed_at = NULL, claimed_by = NULL WHERE claimed_by = 'test-boot'`);
    // Ranks 0 and 1 sort first in the never-fetched lane, and the ten-years-overdue row first in the
    // due lane, whatever the real table holds. Asserted after the release so a failure leaves no claims.
    expect(asins).toContain(A.newTop);
    expect(asins).toContain(A.newDeep);
    expect(asins).toContain(A.due);
    expect(asins.indexOf(A.newTop)).toBeLessThan(asins.indexOf(A.newDeep));
  });

  it('writeBatch applies the three outcomes and inserts snapshots', async () => {
    const now = new Date();
    const active: ProductFacts = { ...emptyFacts(A.newTop, 'delisted'), status: 'active', title: 'New title', currentPriceCents: 1999, priceSource: 'amazon', salesRank: 42, reviewCount: 7, monthlySold: 100 };
    const rows = [
      { asin: A.newTop, tier: 1 as const, lane: 'new' as const, lastFetchedAt: null, consecutiveErrors: 0 },
      { asin: A.due, tier: 1 as const, lane: 'due' as const, lastFetchedAt: new Date(), consecutiveErrors: 0 },
      { asin: A.newDeep, tier: 1 as const, lane: 'new' as const, lastFetchedAt: null, consecutiveErrors: 0 },
    ];
    const facts = new Map<string, ProductFacts>([[A.newTop, active], [A.due, emptyFacts(A.due, 'delisted')], [A.newDeep, emptyFacts(A.newDeep, 'error', 'bad_object')]]);
    await store.writeBatch({ rows, facts, lane: 'new', tokens: { tokensLeft: 123, refillRate: 250 }, now });

    const { rows: r } = await pool.query(`SELECT asin, enrichment_status::text AS s, title, monthly_sold, fetch_count, consecutive_errors, error_code, next_due_at, last_fetched_at FROM asin_products WHERE asin = ANY($1) ORDER BY asin`, [[A.newTop, A.due, A.newDeep]]);
    const by = Object.fromEntries(r.map((x) => [x.asin, x]));
    expect(by[A.newTop]).toMatchObject({ s: 'active', title: 'New title', monthly_sold: 100, fetch_count: 1, consecutive_errors: 0 });
    expect(by[A.due]).toMatchObject({ s: 'delisted', title: 'old title', fetch_count: 1 });
    expect(by[A.newDeep]).toMatchObject({ s: 'error', error_code: 'bad_object', consecutive_errors: 1, fetch_count: 0, last_fetched_at: null });
    expect(new Date(by[A.newTop].next_due_at).getTime() - now.getTime()).toBeCloseTo(7 * 86_400_000, -4);

    const { rows: snaps } = await pool.query(`SELECT asin, enrichment_status::text AS s, review_count FROM asin_snapshots WHERE asin = ANY($1) ORDER BY asin`, [[A.newTop, A.due, A.newDeep]]);
    expect(snaps.map((s) => s.s).sort()).toEqual(['active', 'delisted']);
    expect(snaps.find((s) => s.asin === A.newDeep)).toBeUndefined();
    expect(snaps.find((s) => s.asin === A.newTop)?.review_count).toBe(7);
    const { rows: st } = await pool.query(`SELECT tokens_left, last_batch_lane FROM keepa_service_status WHERE singleton`);
    expect(st[0]).toMatchObject({ tokens_left: 123, last_batch_lane: 'new' });
  });

  it('releaseStaleClaims only touches claims older than the threshold', async () => {
    await pool.query(`UPDATE asin_products SET claimed_at = now() - interval '11 minutes', claimed_by = 'dead-boot' WHERE asin = $1`, [A.notDue]);
    await pool.query(`UPDATE asin_products SET claimed_at = now(), claimed_by = 'live-boot' WHERE asin = $1`, [A.tier2]);
    await store.releaseStaleClaims(10 * 60_000);
    const { rows } = await pool.query<{ asin: string; claimed_by: string | null }>(`SELECT asin, claimed_by FROM asin_products WHERE asin IN ($1, $2)`, [A.notDue, A.tier2]);
    expect(rows.find((r) => r.asin === A.notDue)?.claimed_by).toBeNull();
    expect(rows.find((r) => r.asin === A.tier2)?.claimed_by).toBe('live-boot');
    await pool.query(`UPDATE asin_products SET claimed_at = NULL, claimed_by = NULL WHERE asin = $1`, [A.tier2]);
  });
});
