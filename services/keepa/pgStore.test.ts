// services/keepa/pgStore.test.ts
/**
 * SQL-shape tests with a recording fake client. Order of statements, parameters and the
 * never-downgrade rule are asserted here; Task 8's integration test runs the real thing.
 */
import { EventEmitter } from 'node:events';
import { describe, it, expect } from 'vitest';
import { PgKeepaStore } from './pgStore';
import type { ClaimedRow } from './store';
import { ENQUEUE_LOCK_KEY } from '@/lib/keepa/lanes';
import { emptyFacts, type ProductFacts } from '@/lib/keepa/productFacts';

interface Call { text: string; values: unknown[] | undefined }

function fakePool(responder: (text: string, values: unknown[] | undefined) => { rows?: unknown[]; rowCount?: number } = () => ({})) {
  const calls: Call[] = [];
  /** Every client interaction in order: query texts, 'on:error' / 'off:error', 'release:pool' / 'release:discard'. */
  const trace: string[] = [];
  const emitter = new EventEmitter();
  const query = async (text: string, values?: unknown[]) => {
    calls.push({ text, values });
    trace.push(text);
    const r = responder(text, values);
    return { rows: r.rows ?? [], rowCount: r.rowCount ?? 0 };
  };
  const client = {
    query,
    on: (event: string, fn: () => void) => {
      trace.push(`on:${event}`);
      emitter.on(event, fn);
      return client;
    },
    removeListener: (event: string, fn: () => void) => {
      trace.push(`off:${event}`);
      emitter.removeListener(event, fn);
      return client;
    },
    release: (discard?: boolean) => {
      trace.push(discard === true ? 'release:discard' : 'release:pool');
    },
    /** A dropped socket as pg reports it: an 'error' event on the checked-out client (throws when nobody listens). */
    emitSocketError: () => emitter.emit('error', new Error('Connection terminated unexpectedly')),
    errorListeners: () => emitter.listenerCount('error'),
  };
  return { pool: { query, connect: async () => client } as never, calls, trace, client };
}

const NOW = new Date('2026-10-06T12:00:00Z');
const row = (asin: string, over: Partial<ClaimedRow> = {}): ClaimedRow => ({ asin, tier: 1, lane: 'new', lastFetchedAt: null, consecutiveErrors: 0, ...over });
const active = (asin: string): ProductFacts => ({ ...emptyFacts(asin, 'delisted'), status: 'active', title: 'T', currentPriceCents: 1299, priceSource: 'amazon', salesRank: 10, reviewCount: 5 });
/** Every fact populated and distinct, so a swapped pair of parameters fails an assertion. */
const full = (asin: string): ProductFacts => ({
  asin,
  status: 'active',
  errorCode: null,
  title: 'Title',
  brand: 'Brand',
  imageUrl: 'https://m.media-amazon.com/images/I/x.jpg',
  categoryPath: 'Root › Mid › Leaf',
  categoryRoot: 'Root',
  categoryLeaf: 'Leaf',
  listedSince: '2019-01-02',
  trackingSince: '2018-03-04',
  currentPriceCents: 1299,
  priceSource: 'new',
  salesRank: 4321,
  reviewCount: 87,
  averageRatingX10: 45,
  lastRatingUpdate: '2026-09-30',
  monthlySold: 200,
  keepaUpdatedAt: '2026-10-05',
  newOfferCount: 7,
  fbaOfferCount: 3,
  fbmOfferCount: 4,
  amazonAvailability: 1,
  avg30PriceCents: 1301,
  avg90PriceCents: 1302,
  avg180PriceCents: 1303,
  avg365PriceCents: 1304,
  avg30SalesRank: 4400,
  avg90SalesRank: 4500,
});
/**
 * Every store transaction opens with the enqueue-lock handshake, before any row lock: the long
 * timeout covers the lock wait only, then the row statements are back under five minutes.
 */
const LOCK_OPENING = [
  { text: 'BEGIN', values: undefined },
  { text: "SET LOCAL statement_timeout = '1900s'", values: undefined },
  { text: 'SELECT pg_advisory_xact_lock_shared($1)', values: [ENQUEUE_LOCK_KEY] },
  { text: "SET LOCAL statement_timeout = '300s'", values: undefined },
];
const DUE_BY_TIER = 'next_due_at = CASE WHEN tier = 1 THEN $30::timestamptz ELSE $31::timestamptz END';
const isSnapshot = (c: Call) => c.text.includes('INSERT INTO asin_snapshots');

describe('claimBatch', () => {
  it('fills the batch lane by lane inside one transaction: tier-1 new, tier-1 due, then tier 2 only with the tail on', async () => {
    const { pool, calls } = fakePool((text, values) => (text.includes('RETURNING') ? { rows: [{ asin: `A${values?.[0]}${text.includes('IS NULL AND tier') ? 'N' : 'D'}`, tier: values?.[0], last_fetched_at: null, consecutive_errors: 0 }] } : {}));
    const store = new PgKeepaStore(pool);
    const rows = await store.claimBatch({ limit: 100, tailEnabled: false, bootId: 'boot-1' });
    expect(calls.slice(0, LOCK_OPENING.length)).toEqual(LOCK_OPENING);
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
    expect(calls.map((c) => c.text)).toEqual([...LOCK_OPENING.map((c) => c.text), expect.stringContaining('RETURNING'), 'ROLLBACK']);
  });
});

describe('writeBatch outcomes (spec §5.2)', () => {
  it('an active fetch replaces the facts, resets errors, sets the weekly due date and writes a snapshot', async () => {
    const { pool, calls } = fakePool();
    const r = row('B1');
    await new PgKeepaStore(pool).writeBatch({ rows: [r], facts: new Map([['B1', active('B1')]]), lane: 'new', tokens: { tokensLeft: 14_800, refillRate: 250 }, now: NOW });
    const upd = calls.find((c) => c.text.includes('UPDATE asin_products SET') && c.text.includes('title = $2'))!;
    expect(upd.values).toHaveLength(31);
    expect(upd.values?.[0]).toBe('B1');
    expect(upd.values?.[27]).toBe('active');
    expect(upd.values?.[28]).toEqual(NOW);
    expect(upd.values?.[29]).toEqual(new Date('2026-10-13T12:00:00Z'));
    expect(upd.values?.[30]).toEqual(new Date('2026-11-05T12:00:00Z'));
    expect(upd.text).toContain(DUE_BY_TIER);
    expect(upd.text).toContain('fetch_count = fetch_count + 1, consecutive_errors = 0');
    expect(upd.text).toContain('claimed_at = NULL, claimed_by = NULL');
    const snap = calls.find((c) => c.text.includes('INSERT INTO asin_snapshots'))!;
    expect(snap.values).toEqual(['B1', NOW, 1299, 10, 5, null, null, null, null, null, 'active']);
    const status = calls.find((c) => c.text.includes('UPDATE keepa_service_status'))!;
    expect(status.text).toContain('last_batch_at = $1, last_batch_lane = $2');
    expect(status.text).not.toContain('last_error');
    expect(status.values).toEqual([NOW, 'new', 14_800, 250]);
    expect(calls.slice(0, LOCK_OPENING.length)).toEqual(LOCK_OPENING);
    expect(calls.at(-1)?.text).toBe('COMMIT');
  });

  it('passes all 31 success parameters in column order, every fact to its own column', async () => {
    const { pool, calls } = fakePool();
    await new PgKeepaStore(pool).writeBatch({ rows: [row('B1')], facts: new Map([['B1', full('B1')]]), lane: 'new', tokens: { tokensLeft: 1, refillRate: 250 }, now: NOW });
    const upd = calls.find((c) => c.text.includes('title = $2'))!;
    expect(upd.values).toEqual([
      'B1', 'Title', 'Brand', 'https://m.media-amazon.com/images/I/x.jpg', 'Root › Mid › Leaf', 'Root', 'Leaf',
      '2019-01-02', '2018-03-04',
      1299, 'new', 4321, 87, 45, '2026-09-30',
      200, '2026-10-05', 7, 3, 4, 1,
      1301, 1302, 1303, 1304, 4400, 4500,
      'active', NOW, new Date('2026-10-13T12:00:00Z'), new Date('2026-11-05T12:00:00Z'),
    ]);
    // The same, read through the SQL text: each `column = $n` gets the fact named like it.
    const byColumn = Object.fromEntries([...upd.text.matchAll(/(\w+) = \$(\d+)/g)].map(([, column, n]) => [column, upd.values?.[Number(n) - 1]]));
    expect(byColumn).toEqual({
      asin: 'B1', title: 'Title', brand: 'Brand', image_url: 'https://m.media-amazon.com/images/I/x.jpg',
      category_path: 'Root › Mid › Leaf', category_root: 'Root', category_leaf: 'Leaf',
      listed_since: '2019-01-02', tracking_since: '2018-03-04',
      current_price_cents: 1299, price_source: 'new', sales_rank: 4321, review_count: 87, average_rating_x10: 45, last_rating_update: '2026-09-30',
      monthly_sold: 200, keepa_updated_at: '2026-10-05', new_offer_count: 7, fba_offer_count: 3, fbm_offer_count: 4, amazon_availability: 1,
      avg30_price_cents: 1301, avg90_price_cents: 1302, avg180_price_cents: 1303, avg365_price_cents: 1304, avg30_sales_rank: 4400, avg90_sales_rank: 4500,
      enrichment_status: 'active', last_fetched_at: NOW,
    });
    expect(calls.find(isSnapshot)?.values).toEqual(['B1', NOW, 1299, 4321, 87, 45, 200, 7, 3, 4, 'active']);
  });

  it('an all-error batch records its code as the last error and leaves last_batch_at alone', async () => {
    const { pool, calls } = fakePool();
    await new PgKeepaStore(pool).writeBatch({ rows: [row('B1')], facts: new Map([['B1', emptyFacts('B1', 'error', 'no_stats')]]), lane: 'new', tokens: { tokensLeft: 900, refillRate: 250 }, now: NOW, batchErrorCode: 'no_stats' });
    const status = calls.find((c) => c.text.includes('UPDATE keepa_service_status'))!;
    expect(status.text).toContain('heartbeat_at = now(), last_error_code = $1, last_error_at = now()');
    expect(status.text).toContain('tokens_left = COALESCE($2, tokens_left), refill_rate = COALESCE($3, refill_rate)');
    expect(status.text).not.toContain('last_batch');
    expect(status.values).toEqual(['no_stats', 900, 250]);
    expect(calls.filter((c) => c.text.includes('consecutive_errors = consecutive_errors + 1'))).toHaveLength(1);
    expect(calls.at(-1)?.text).toBe('COMMIT');
  });

  it('the due date follows the row\'s current tier in SQL, not the tier read at claim time', async () => {
    const { pool, calls } = fakePool();
    await new PgKeepaStore(pool).writeBatch({ rows: [row('B1', { tier: 2, lane: 'tail' })], facts: new Map([['B1', active('B1')]]), lane: 'tail', tokens: { tokensLeft: null, refillRate: null }, now: NOW });
    const upd = calls.find((c) => c.text.includes('title = $2'))!;
    expect(upd.text).toContain(DUE_BY_TIER);
    expect(upd.values?.slice(29)).toEqual([new Date('2026-10-13T12:00:00Z'), new Date('2026-11-05T12:00:00Z')]);
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
    expect(calls.some(isSnapshot)).toBe(false);
  });

  it('a row missing from the parse map is written as an error too', async () => {
    const { pool, calls } = fakePool();
    await new PgKeepaStore(pool).writeBatch({ rows: [row('B1')], facts: new Map(), lane: 'new', tokens: { tokensLeft: 1, refillRate: 250 }, now: NOW });
    expect(calls.find((c) => c.text.includes('consecutive_errors = consecutive_errors + 1'))?.values?.[1]).toBe('missing_from_parse');
    expect(calls.some(isSnapshot)).toBe(false);
  });
});

describe('markBatchErrored, releaseStaleClaims, status writes', () => {
  it('markBatchErrored applies the error outcome to every row and records the code on the status row', async () => {
    const { pool, calls } = fakePool();
    await new PgKeepaStore(pool).markBatchErrored({ rows: [row('B1'), row('B2')], errorCode: 'keepa_http_503', now: NOW });
    expect(calls.filter((c) => c.text.includes('consecutive_errors = consecutive_errors + 1'))).toHaveLength(2);
    expect(calls.find((c) => c.text.includes('last_error_code = $1'))?.values).toEqual(['keepa_http_503']);
    expect(calls.filter(isSnapshot)).toHaveLength(0);
    expect(calls.slice(0, LOCK_OPENING.length)).toEqual(LOCK_OPENING);
  });
  it('releaseStaleClaims clears claims older than the threshold and reports the count', async () => {
    const { pool, calls } = fakePool(() => ({ rowCount: 7 }));
    await expect(new PgKeepaStore(pool).releaseStaleClaims(600_000).then((n) => n)).resolves.toBe(7);
    expect(calls.slice(0, LOCK_OPENING.length)).toEqual(LOCK_OPENING);
    expect(calls.map((c) => c.text)).toEqual([
      ...LOCK_OPENING.map((c) => c.text),
      expect.stringContaining('SET claimed_at = NULL, claimed_by = NULL WHERE claimed_at IS NOT NULL AND claimed_at <'),
      'COMMIT',
    ]);
    expect(calls[LOCK_OPENING.length].values).toEqual([600]);
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
  it('releaseOwnClaims frees this boot\'s claims inside the lock handshake and reports the count', async () => {
    const { pool, calls } = fakePool(() => ({ rowCount: 3 }));
    await expect(new PgKeepaStore(pool).releaseOwnClaims('boot-1')).resolves.toBe(3);
    expect(calls.map((c) => c.text)).toEqual([
      ...LOCK_OPENING.map((c) => c.text),
      'UPDATE asin_products SET claimed_at = NULL, claimed_by = NULL WHERE claimed_at IS NOT NULL AND claimed_by = $1',
      'COMMIT',
    ]);
    expect(calls[LOCK_OPENING.length].values).toEqual(['boot-1']);
  });
  it('oldJobRunning is one plain read of the old job\'s runs table (no lock handshake)', async () => {
    const { pool, calls } = fakePool(() => ({ rows: [{ running: true }] }));
    await expect(new PgKeepaStore(pool).oldJobRunning()).resolves.toBe(true);
    expect(calls).toEqual([
      { text: "SELECT EXISTS (SELECT 1 FROM keepa_enrichment_runs WHERE status = 'running' AND heartbeat_at > now() - interval '10 minutes') AS running", values: undefined },
    ]);
    const { pool: quiet } = fakePool(() => ({ rows: [{ running: false }] }));
    await expect(new PgKeepaStore(quiet).oldJobRunning()).resolves.toBe(false);
  });
});

describe('transactions survive a dropped connection', () => {
  it('attaches the socket-error listener before BEGIN, removes it after COMMIT, then returns the client to the pool', async () => {
    const { pool, trace, client } = fakePool((text) => (text.includes('RETURNING') ? { rows: [] } : {}));
    await new PgKeepaStore(pool).claimBatch({ limit: 5, tailEnabled: false, bootId: 'b' });
    expect(trace.slice(0, 2)).toEqual(['on:error', 'BEGIN']);
    expect(trace.slice(-3)).toEqual(['COMMIT', 'off:error', 'release:pool']);
    expect(client.errorListeners()).toBe(0);
  });

  it('discards the client (release(true)) when the transaction body throws, after removing the listener', async () => {
    const { pool, trace, client } = fakePool((text) => {
      if (text.includes('consecutive_errors = consecutive_errors + 1')) throw Object.assign(new Error('x'), { code: '57P01' });
      return {};
    });
    await expect(new PgKeepaStore(pool).markBatchErrored({ rows: [row('B1')], errorCode: 'keepa_http_503', now: NOW })).rejects.toMatchObject({ code: '57P01' });
    expect(trace[0]).toBe('on:error');
    expect(trace.slice(-3)).toEqual(['ROLLBACK', 'off:error', 'release:discard']);
    expect(client.errorListeners()).toBe(0);
  });

  it('absorbs the socket error event a dropped connection emits mid-transaction; the failed query still rejects', async () => {
    let emitSocketError: () => boolean = () => false;
    let absorbed: boolean | undefined;
    const fake = fakePool((text) => {
      if (text.includes('RETURNING')) {
        absorbed = emitSocketError();
        throw new Error('Connection terminated unexpectedly');
      }
      return {};
    });
    emitSocketError = fake.client.emitSocketError;
    await expect(new PgKeepaStore(fake.pool).claimBatch({ limit: 5, tailEnabled: false, bootId: 'b' })).rejects.toThrow('Connection terminated unexpectedly');
    expect(absorbed).toBe(true);
    expect(fake.trace.at(-1)).toBe('release:discard');
    // Outside a transaction nobody listens any more: the same event would be thrown.
    expect(() => fake.client.emitSocketError()).toThrow('Connection terminated unexpectedly');
  });
});
