// services/keepa/pgStore.test.ts
/**
 * SQL-shape tests with a recording fake client. Order of statements, parameters and the
 * never-downgrade rule are asserted here; Task 8's integration test runs the real thing.
 */
import { describe, it, expect } from 'vitest';
import { PgKeepaStore } from './pgStore';
import type { ClaimedRow } from './store';
import { emptyFacts, type ProductFacts } from '@/lib/keepa/productFacts';

interface Call { text: string; values: unknown[] | undefined }

function fakePool(responder: (text: string, values: unknown[] | undefined) => { rows?: unknown[]; rowCount?: number } = () => ({})) {
  const calls: Call[] = [];
  const query = async (text: string, values?: unknown[]) => {
    calls.push({ text, values });
    const r = responder(text, values);
    return { rows: r.rows ?? [], rowCount: r.rowCount ?? 0 };
  };
  const client = { query, release: () => {} };
  return { pool: { query, connect: async () => client } as never, calls };
}

const NOW = new Date('2026-10-06T12:00:00Z');
const row = (asin: string, over: Partial<ClaimedRow> = {}): ClaimedRow => ({ asin, tier: 1, lane: 'new', lastFetchedAt: null, consecutiveErrors: 0, ...over });
const active = (asin: string): ProductFacts => ({ ...emptyFacts(asin, 'delisted'), status: 'active', title: 'T', currentPriceCents: 1299, priceSource: 'amazon', salesRank: 10, reviewCount: 5 });

describe('claimBatch', () => {
  it('fills the batch lane by lane inside one transaction: tier-1 new, tier-1 due, then tier 2 only with the tail on', async () => {
    const { pool, calls } = fakePool((text, values) => (text.includes('RETURNING') ? { rows: [{ asin: `A${values?.[0]}${text.includes('IS NULL AND tier') ? 'N' : 'D'}`, tier: values?.[0], last_fetched_at: null, consecutive_errors: 0 }] } : {}));
    const store = new PgKeepaStore(pool);
    const rows = await store.claimBatch({ limit: 100, tailEnabled: false, bootId: 'boot-1' });
    expect(calls[0].text).toBe('BEGIN');
    expect(calls.at(-1)?.text).toBe('COMMIT');
    const claims = calls.filter((c) => c.text.includes('RETURNING'));
    expect(claims).toHaveLength(2);
    expect(claims[0].text).toContain('last_fetched_at IS NULL AND tier = $1');
    expect(claims[0].text).toContain('ORDER BY best_rank NULLS LAST, asin');
    expect(claims[0].text).toContain('FOR UPDATE SKIP LOCKED');
    expect(claims[0].values).toEqual([1, 100, 'boot-1']);
    expect(claims[1].text).toContain('last_fetched_at IS NOT NULL AND tier = $1');
    expect(claims[1].text).toContain('ORDER BY next_due_at, asin');
    expect(claims[1].values).toEqual([1, 99, 'boot-1']);
    expect(rows.map((r) => r.lane)).toEqual(['new', 'due']);

    const { pool: pool2, calls: c2 } = fakePool((text) => (text.includes('RETURNING') ? { rows: [] } : {}));
    await new PgKeepaStore(pool2).claimBatch({ limit: 100, tailEnabled: true, bootId: 'b' });
    expect(c2.filter((c) => c.text.includes('RETURNING')).map((c) => c.values?.[0])).toEqual([1, 1, 2, 2]);
  });

  it('stops claiming once the batch is full', async () => {
    const { pool, calls } = fakePool((text, values) => (text.includes('RETURNING') ? { rows: new Array(values?.[1] as number).fill(0).map((_, i) => ({ asin: `A${i}`, tier: 1, last_fetched_at: null, consecutive_errors: 0 })) } : {}));
    const rows = await new PgKeepaStore(pool).claimBatch({ limit: 5, tailEnabled: true, bootId: 'b' });
    expect(rows).toHaveLength(5);
    expect(calls.filter((c) => c.text.includes('RETURNING'))).toHaveLength(1);
  });

  it('rolls back when a claim statement fails', async () => {
    const { pool, calls } = fakePool((text) => { if (text.includes('RETURNING')) throw Object.assign(new Error('x'), { code: '57014' }); return {}; });
    await expect(new PgKeepaStore(pool).claimBatch({ limit: 5, tailEnabled: false, bootId: 'b' })).rejects.toMatchObject({ code: '57014' });
    expect(calls.map((c) => c.text)).toEqual(['BEGIN', expect.stringContaining('RETURNING'), 'ROLLBACK']);
  });
});

describe('writeBatch outcomes (spec §5.2)', () => {
  it('an active fetch replaces the facts, resets errors, sets the weekly due date and writes a snapshot', async () => {
    const { pool, calls } = fakePool();
    const r = row('B1');
    await new PgKeepaStore(pool).writeBatch({ rows: [r], facts: new Map([['B1', active('B1')]]), lane: 'new', tokens: { tokensLeft: 14_800, refillRate: 250 }, now: NOW });
    const upd = calls.find((c) => c.text.includes('UPDATE asin_products SET') && c.text.includes('title = $2'))!;
    expect(upd.values?.[0]).toBe('B1');
    expect(upd.values?.[27]).toBe('active');
    expect(upd.values?.[28]).toEqual(NOW);
    expect(upd.values?.[29]).toEqual(new Date('2026-10-13T12:00:00Z'));
    expect(upd.text).toContain('fetch_count = fetch_count + 1, consecutive_errors = 0');
    expect(upd.text).toContain('claimed_at = NULL, claimed_by = NULL');
    const snap = calls.find((c) => c.text.includes('INSERT INTO asin_snapshots'))!;
    expect(snap.values).toEqual(['B1', NOW, 1299, 10, 5, null, null, null, null, null, 'active']);
    const status = calls.find((c) => c.text.includes('UPDATE keepa_service_status'))!;
    expect(status.values).toEqual([NOW, 'new', 14_800, 250]);
    expect(calls[0].text).toBe('BEGIN');
    expect(calls.at(-1)?.text).toBe('COMMIT');
  });

  it('tier 2 gets a 30-day due date', async () => {
    const { pool, calls } = fakePool();
    await new PgKeepaStore(pool).writeBatch({ rows: [row('B1', { tier: 2, lane: 'tail' })], facts: new Map([['B1', active('B1')]]), lane: 'tail', tokens: { tokensLeft: null, refillRate: null }, now: NOW });
    const upd = calls.find((c) => c.text.includes('title = $2'))!;
    expect(upd.values?.[29]).toEqual(new Date('2026-11-05T12:00:00Z'));
  });

  it('a delisted product keeps its facts, flips the status, and is rechecked in 30 days', async () => {
    const { pool, calls } = fakePool();
    await new PgKeepaStore(pool).writeBatch({ rows: [row('B1')], facts: new Map([['B1', emptyFacts('B1', 'delisted')]]), lane: 'due', tokens: { tokensLeft: 1, refillRate: 250 }, now: NOW });
    const upd = calls.find((c) => c.text.includes("enrichment_status = 'delisted'"))!;
    expect(upd.text).not.toContain('title =');
    expect(upd.values).toEqual(['B1', NOW, new Date('2026-11-05T12:00:00Z')]);
    expect(calls.find((c) => c.text.includes('INSERT INTO asin_snapshots'))?.values?.[10]).toBe('delisted');
  });

  it('a bad object never downgrades a fetched row: status unchanged, facts kept, backoff from the error count, last_fetched_at untouched', async () => {
    const { pool, calls } = fakePool();
    await new PgKeepaStore(pool).writeBatch({ rows: [row('B1', { consecutiveErrors: 2, lastFetchedAt: new Date('2026-09-01T00:00:00Z') })], facts: new Map([['B1', emptyFacts('B1', 'error', 'bad_object')]]), lane: 'due', tokens: { tokensLeft: 1, refillRate: 250 }, now: NOW });
    const upd = calls.find((c) => c.text.includes('consecutive_errors = consecutive_errors + 1'))!;
    expect(upd.text).toContain("CASE WHEN last_fetched_at IS NULL THEN 'error'::asin_enrichment_status ELSE enrichment_status END");
    expect(upd.text).not.toContain('last_fetched_at = ');
    expect(upd.values).toEqual(['B1', 'bad_object', new Date('2026-10-10T12:00:00Z')]);
  });

  it('a row missing from the parse map is written as an error too', async () => {
    const { pool, calls } = fakePool();
    await new PgKeepaStore(pool).writeBatch({ rows: [row('B1')], facts: new Map(), lane: 'new', tokens: { tokensLeft: 1, refillRate: 250 }, now: NOW });
    expect(calls.find((c) => c.text.includes('consecutive_errors = consecutive_errors + 1'))?.values?.[1]).toBe('missing_from_parse');
  });
});

describe('markBatchErrored, releaseStaleClaims, status writes', () => {
  it('markBatchErrored applies the error outcome to every row and records the code on the status row', async () => {
    const { pool, calls } = fakePool();
    await new PgKeepaStore(pool).markBatchErrored({ rows: [row('B1'), row('B2')], errorCode: 'keepa_http_503', now: NOW });
    expect(calls.filter((c) => c.text.includes('consecutive_errors = consecutive_errors + 1'))).toHaveLength(2);
    expect(calls.find((c) => c.text.includes('last_error_code = $1'))?.values).toEqual(['keepa_http_503']);
  });
  it('releaseStaleClaims clears claims older than the threshold and reports the count', async () => {
    const { pool, calls } = fakePool(() => ({ rowCount: 7 }));
    await expect(new PgKeepaStore(pool).releaseStaleClaims(600_000).then((n) => n)).resolves.toBe(7);
    expect(calls[0].text).toContain('SET claimed_at = NULL, claimed_by = NULL WHERE claimed_at IS NOT NULL AND claimed_at <');
    expect(calls[0].values).toEqual([600]);
  });
  it('recordBoot upserts the singleton with the tail switch; heartbeat keeps known token values', async () => {
    const { pool, calls } = fakePool();
    const store = new PgKeepaStore(pool);
    await store.recordBoot('boot-1', true);
    expect(calls[0].text).toContain('ON CONFLICT (singleton) DO UPDATE');
    expect(calls[0].values).toEqual(['boot-1', true]);
    await store.heartbeat({ tokensLeft: null, refillRate: 250 });
    expect(calls[1].text).toContain('tokens_left = COALESCE($1, tokens_left)');
    expect(calls[1].values).toEqual([null, 250]);
    await store.markNewLaneDrained();
    expect(calls[2].text).toContain('lane_new_drained_at = now()');
  });
});
