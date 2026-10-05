// services/keepa/loop.test.ts
import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  runIteration,
  safeIteration,
  startHeartbeat,
  releaseOwnClaimsOnShutdown,
  initialState,
  type LoopDeps,
  IDLE_SLEEP_MS,
  DB_RETRY_SLEEP_MS,
  KEEPA_RETRY_SLEEP_MS,
  BAD_REQUEST_SLEEP_MS,
  MAX_DB_FAILURES,
  MAX_TOKEN_WAIT_MS,
  TOKENS_EXHAUSTED_AFTER,
  OUTAGE_PAUSE_START_MS,
  OUTAGE_PAUSE_MAX_MS,
  HEARTBEAT_INTERVAL_MS,
  SHUTDOWN_RELEASE_TIMEOUT_MS,
} from './loop';
import type { ClaimedRow, KeepaStore } from './store';
import { KeepaHttpError, KeepaReplyError, KeepaTokenError, type KeepaBatchReply } from '@/lib/keepa/batchClient';

const NOW = new Date('2026-10-06T12:00:00Z');
const row = (asin: string, lane: ClaimedRow['lane'] = 'new'): ClaimedRow => ({ asin, tier: 1, lane, lastFetchedAt: null, consecutiveErrors: 0 });
const reply = (asins: string[], tokensLeft = 14_000): KeepaBatchReply => ({ products: asins.map((asin) => ({ asin, title: 'T', stats: { current: [1299] } })), tokensLeft, refillIn: 1000, refillRate: 250, tokensConsumed: asins.length * 2 });

function makeStore(claims: ClaimedRow[][]): KeepaStore & { calls: string[]; written: Array<{ status: string; asin: string }> } {
  const queue = [...claims];
  const calls: string[] = [];
  const written: Array<{ status: string; asin: string }> = [];
  return {
    calls,
    written,
    recordBoot: async () => { calls.push('recordBoot'); },
    releaseStaleClaims: async () => { calls.push('release'); return 0; },
    claimBatch: async () => { calls.push('claim'); return queue.shift() ?? []; },
    writeBatch: async ({ facts, batchErrorCode }) => {
      calls.push(batchErrorCode === undefined ? 'write' : `write:${batchErrorCode}`);
      for (const f of facts.values()) written.push({ status: f.status, asin: f.asin });
    },
    markBatchErrored: async ({ errorCode }) => { calls.push(`errored:${errorCode}`); },
    heartbeat: async () => { calls.push('heartbeat'); },
    recordError: async (code) => { calls.push(`recordError:${code}`); },
    markNewLaneDrained: async () => { calls.push('drained'); },
    releaseOwnClaims: async () => { calls.push('releaseOwn'); return 0; },
  };
}

function makeDeps(store: KeepaStore, fetchBatch: LoopDeps['keepa']['fetchBatch']): LoopDeps & { sleeps: number[]; logs: Record<string, unknown>[]; exit: ReturnType<typeof vi.fn> } {
  const sleeps: number[] = [];
  const logs: Record<string, unknown>[] = [];
  const exit = vi.fn();
  return {
    store,
    keepa: { fetchBatch, tokenStatus: async () => ({ tokensLeft: 15_000, refillRate: 250 }) },
    sleep: async (ms) => { sleeps.push(ms); },
    now: () => NOW,
    log: (f) => { logs.push(f); },
    exit,
    bootId: 'boot-1',
    tailEnabled: false,
    sleeps,
    logs,
  };
}

describe('runIteration', () => {
  it('idles for a minute with a heartbeat when nothing is due', async () => {
    const store = makeStore([[]]);
    const deps = makeDeps(store, async () => reply([]));
    await expect(runIteration(deps, initialState())).resolves.toBe('idle');
    expect(store.calls).toEqual(['release', 'claim', 'heartbeat']);
    expect(deps.sleeps).toEqual([IDLE_SLEEP_MS]);
  });

  it('claims, fetches once, parses and writes a batch, then reports it', async () => {
    const store = makeStore([[row('B1'), row('B2', 'due')]]);
    const fetchBatch = vi.fn(async (asins: string[]) => reply(asins));
    const deps = makeDeps(store, fetchBatch);
    const state = initialState();
    await expect(runIteration(deps, state)).resolves.toBe('batch');
    expect(fetchBatch).toHaveBeenCalledWith(['B1', 'B2']);
    expect(store.written.map((w) => w.status)).toEqual(['active', 'active']);
    expect(state.tokensLeft).toBe(14_000);
    expect(deps.logs.at(-1)).toMatchObject({ event: 'batch', lane: 'new', requested: 2, active: 2, tokensLeft: 14_000 });
    expect(typeof deps.logs.at(-1)?.ms).toBe('number');
    expect(deps.sleeps).toEqual([]);
  });

  it('waits for tokens before fetching when the balance is short', async () => {
    const store = makeStore([[row('B1')]]);
    const deps = makeDeps(store, async (asins) => reply(asins));
    const state = { ...initialState(), tokensLeft: 1, refillRate: 250 };
    await runIteration(deps, state);
    expect(deps.sleeps).toEqual([240]);
    expect(deps.logs).toContainEqual({ event: 'token_wait', ms: 240 });
  });

  it('caps a token wait at two minutes', async () => {
    const store = makeStore([[row('B1')]]);
    const deps = makeDeps(store, async (asins) => reply(asins));
    // Keepa lets the balance go negative: 1002 tokens short at 250/min would be four minutes.
    await runIteration(deps, { ...initialState(), tokensLeft: -1000, refillRate: 250 });
    expect(deps.sleeps).toEqual([MAX_TOKEN_WAIT_MS]);
    expect(deps.logs).toContainEqual({ event: 'token_wait', ms: MAX_TOKEN_WAIT_MS });
  });

  it('a product missing from the reply is written as an error', async () => {
    const store = makeStore([[row('B1'), row('B2')]]);
    const deps = makeDeps(store, async () => reply(['B1']));
    await runIteration(deps, initialState());
    expect(store.written).toEqual([{ status: 'active', asin: 'B1' }, { status: 'error', asin: 'B2' }]);
  });

  it('sleeps for Keepa\'s refill time on token exhaustion and retries the same batch', async () => {
    const store = makeStore([[row('B1')]]);
    const fetchBatch = vi.fn().mockRejectedValueOnce(new KeepaTokenError(31_000)).mockImplementation(async (asins: string[]) => reply(asins));
    const deps = makeDeps(store, fetchBatch);
    await expect(runIteration(deps, initialState())).resolves.toBe('batch');
    expect(deps.sleeps).toEqual([31_000]);
    expect(fetchBatch).toHaveBeenCalledTimes(2);
  });

  it('retries a Keepa outage three times then marks the batch errored and moves on', async () => {
    const store = makeStore([[row('B1')]]);
    const fetchBatch = vi.fn().mockRejectedValue(new KeepaHttpError(503));
    const deps = makeDeps(store, fetchBatch);
    await expect(runIteration(deps, initialState())).resolves.toBe('keepa_error');
    expect(fetchBatch).toHaveBeenCalledTimes(3);
    expect(deps.sleeps).toEqual([KEEPA_RETRY_SLEEP_MS, KEEPA_RETRY_SLEEP_MS, OUTAGE_PAUSE_START_MS]);
    expect(store.calls).toContain('errored:keepa_http_503');
  });

  it('pauses after each unanswered batch, one minute doubling to fifteen, and starts over once Keepa answers', async () => {
    const store = makeStore(new Array(8).fill(0).map((_, i) => [row(`B${i}`)]));
    let down = true;
    const deps = makeDeps(store, async (asins) => {
      if (down) throw new KeepaHttpError(503);
      return reply(asins);
    });
    const state = initialState();
    const pauses = () => deps.logs.filter((l) => l.event === 'outage_pause').map((l) => l.ms);
    for (let i = 0; i < 6; i++) await runIteration(deps, state);
    expect(pauses()).toEqual([60_000, 120_000, 240_000, 480_000, OUTAGE_PAUSE_MAX_MS, OUTAGE_PAUSE_MAX_MS]);
    down = false;
    await expect(runIteration(deps, state)).resolves.toBe('batch');
    expect(state.outagePauseMs).toBe(0);
    down = true;
    await runIteration(deps, state);
    expect(pauses().at(-1)).toBe(OUTAGE_PAUSE_START_MS);
  });

  it('a 400 gets three attempts 30 s apart, then the batch is marked errored and the next one goes at once', async () => {
    const store = makeStore([[row('B1')]]);
    const fetchBatch = vi.fn().mockRejectedValue(new KeepaHttpError(400));
    const deps = makeDeps(store, fetchBatch);
    await expect(runIteration(deps, initialState())).resolves.toBe('keepa_error');
    expect(fetchBatch).toHaveBeenCalledTimes(3);
    expect(deps.sleeps).toEqual([KEEPA_RETRY_SLEEP_MS, KEEPA_RETRY_SLEEP_MS]);
    expect(store.calls).toContain('errored:keepa_http_400');
    expect(store.calls.some((c) => c.startsWith('recordError:'))).toBe(false);
  });

  it('a reply without a products array is retried like an outage, then stored as keepa_bad_reply', async () => {
    const store = makeStore([[row('B1')]]);
    const fetchBatch = vi.fn().mockRejectedValue(new KeepaReplyError());
    const deps = makeDeps(store, fetchBatch);
    await expect(runIteration(deps, initialState())).resolves.toBe('keepa_error');
    expect(fetchBatch).toHaveBeenCalledTimes(3);
    expect(store.calls).toContain('errored:keepa_bad_reply');
  });

  it('a non-Keepa error is stored under its name, capped at the error-code column\'s 64 characters', async () => {
    const store = makeStore([[row('B1')]]);
    const name = 'A'.repeat(40) + 'B'.repeat(40);
    const fetchBatch = vi.fn().mockRejectedValue(Object.assign(new Error('x'), { name }));
    const deps = makeDeps(store, fetchBatch);
    await expect(runIteration(deps, initialState())).resolves.toBe('keepa_error');
    expect(fetchBatch).toHaveBeenCalledTimes(3);
    const code = store.calls.find((c) => c.startsWith('errored:'))?.slice('errored:'.length);
    expect(code).toHaveLength(64);
    expect(code).toBe(name.slice(0, 64));
  });

  it.each([
    ['a timeout', Object.assign(new Error('t'), { name: 'TimeoutError' }), 'keepa_timeout'],
    ['an abort', new DOMException('aborted', 'AbortError'), 'keepa_timeout'],
    ['a DNS failure', new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.keepa.com'), { code: 'ENOTFOUND' }) }), 'keepa_network_ENOTFOUND'],
    ['an over-long network code', new TypeError('fetch failed', { cause: { code: 'X'.repeat(80) } }), `keepa_network_${'X'.repeat(50)}`],
  ])('%s is stored under a coded name', async (_label, error, code) => {
    const store = makeStore([[row('B1')]]);
    const deps = makeDeps(store, vi.fn().mockRejectedValue(error));
    await expect(runIteration(deps, initialState())).resolves.toBe('keepa_error');
    expect(store.calls).toContain(`errored:${code}`);
    expect(code.length).toBeLessThanOrEqual(64);
  });

  it('after five 429s since the last good fetch the status row says tokens are exhausted; a good fetch resets the count', async () => {
    const store = makeStore([[row('B1')]]);
    const fetchBatch = vi.fn();
    for (let i = 0; i < TOKENS_EXHAUSTED_AFTER; i++) fetchBatch.mockRejectedValueOnce(new KeepaTokenError(1_000));
    fetchBatch.mockImplementation(async (asins: string[]) => reply(asins));
    const deps = makeDeps(store, fetchBatch);
    const state = initialState();
    await expect(runIteration(deps, state)).resolves.toBe('batch');
    expect(store.calls.filter((c) => c === 'recordError:keepa_tokens_exhausted')).toHaveLength(1);
    expect(deps.logs).toContainEqual({ event: 'tokens_exhausted', consecutive: TOKENS_EXHAUSTED_AFTER });
    expect(state.consecutive429).toBe(0);
  });

  it('a failure to record the exhaustion is logged and swallowed', async () => {
    const store = makeStore([[row('B1')]]);
    store.recordError = async () => { throw Object.assign(new Error('db down'), { code: '57P01' }); };
    const fetchBatch = vi.fn();
    for (let i = 0; i < TOKENS_EXHAUSTED_AFTER; i++) fetchBatch.mockRejectedValueOnce(new KeepaTokenError(1_000));
    fetchBatch.mockImplementation(async (asins: string[]) => reply(asins));
    const deps = makeDeps(store, fetchBatch);
    await expect(runIteration(deps, initialState())).resolves.toBe('batch');
    expect(deps.logs).toContainEqual({ event: 'record_error_failed', error: 'Error', code: '57P01' });
    expect(deps.logs).toContainEqual({ event: 'tokens_exhausted', consecutive: TOKENS_EXHAUSTED_AFTER });
  });

  it('a batch with no usable outcome is written as a failed batch: its code recorded, no batch line, keepa_error', async () => {
    const store = makeStore([[row('B1'), row('B2')]]);
    const onBatch = vi.fn();
    // The reply carries products for other ASINs only, so every requested one is missing from it.
    const deps = { ...makeDeps(store, async () => reply(['X1', 'X2'])), onBatch };
    await expect(runIteration(deps, initialState())).resolves.toBe('keepa_error');
    expect(store.calls).toContain('write:missing_from_reply');
    expect(store.written).toEqual([{ status: 'error', asin: 'B1' }, { status: 'error', asin: 'B2' }]);
    expect(deps.logs.at(-1)).toEqual({ event: 'batch_all_errors', lane: 'new', requested: 2, code: 'missing_from_reply' });
    expect(deps.logs.some((l) => l.event === 'batch')).toBe(false);
    expect(onBatch).not.toHaveBeenCalled();
  });

  it('the failed batch\'s code is its most common error', async () => {
    const store = makeStore([[row('B1'), row('B2'), row('B3')]]);
    // B1 and B2 come back without stats (no_stats); B3 does not come back at all (missing_from_reply).
    const deps = makeDeps(store, async () => ({ ...reply([]), products: [{ asin: 'B1', title: 'T' }, { asin: 'B2', title: 'T' }] }));
    await expect(runIteration(deps, initialState())).resolves.toBe('keepa_error');
    expect(store.calls).toContain('write:no_stats');
  });

  it.each([401, 402, 403])('a rejected request (%i) is recorded, waited out ten minutes, and retried without counting as an attempt', async (status) => {
    const store = makeStore([[row('B1')]]);
    const fetchBatch = vi.fn().mockRejectedValueOnce(new KeepaHttpError(status)).mockImplementation(async (asins: string[]) => reply(asins));
    const deps = makeDeps(store, fetchBatch);
    await expect(runIteration(deps, initialState())).resolves.toBe('batch');
    expect(store.calls).toContain(`recordError:keepa_http_${status}`);
    expect(deps.sleeps).toEqual([BAD_REQUEST_SLEEP_MS]);
  });

  it('a database failure sleeps 30 s, counts, and exits the process at ten in a row', async () => {
    const store = makeStore([]);
    store.claimBatch = async () => { throw Object.assign(new Error('conn'), { code: '57P01' }); };
    const deps = makeDeps(store, async () => reply([]));
    const state = initialState();
    for (let i = 1; i < MAX_DB_FAILURES; i++) {
      await expect(runIteration(deps, state)).resolves.toBe('db_error');
      expect(deps.exit).not.toHaveBeenCalled();
    }
    await runIteration(deps, state);
    expect(deps.exit).toHaveBeenCalledWith(1);
    expect(deps.sleeps.every((s) => s === DB_RETRY_SLEEP_MS)).toBe(true);
    expect(JSON.stringify(deps.logs)).not.toContain('conn');
  });

  it('a success in between resets the database-failure count', async () => {
    const store = makeStore([]);
    let failing = true;
    store.claimBatch = async () => {
      if (failing) throw Object.assign(new Error('conn'), { code: '57P01' });
      return [];
    };
    const deps = makeDeps(store, async () => reply([]));
    const state = initialState();
    for (let i = 1; i < MAX_DB_FAILURES; i++) await runIteration(deps, state);
    failing = false;
    await expect(runIteration(deps, state)).resolves.toBe('idle');
    failing = true;
    for (let i = 1; i < MAX_DB_FAILURES; i++) await runIteration(deps, state);
    expect(deps.exit).not.toHaveBeenCalled();
    expect(state.dbFailures).toBe(MAX_DB_FAILURES - 1);
  });

  it('logs how many stale claims a release freed, and nothing when it freed none', async () => {
    const store = makeStore([[], []]);
    let freed = 4;
    store.releaseStaleClaims = async () => freed;
    const deps = makeDeps(store, async () => reply([]));
    await runIteration(deps, initialState());
    expect(deps.logs).toContainEqual({ event: 'stale_claims_released', count: 4 });
    freed = 0;
    deps.logs.length = 0;
    await runIteration(deps, initialState());
    expect(deps.logs.some((l) => l.event === 'stale_claims_released')).toBe(false);
  });

  it('safeIteration logs an escaped throw and counts it like a database failure: ten in a row end the process', async () => {
    const store = makeStore([]);
    store.claimBatch = async () => [row('B1')];
    // A clock that throws a non-Error after the fetch, before anything resets the count.
    const deps = { ...makeDeps(store, async (asins) => reply(asins)), now: (): Date => { throw 'clock'; } };
    const state = initialState();
    for (let i = 1; i < MAX_DB_FAILURES; i++) {
      await expect(safeIteration(deps, state)).resolves.toBe('threw');
      expect(deps.exit).not.toHaveBeenCalled();
    }
    await safeIteration(deps, state);
    expect(deps.exit).toHaveBeenCalledWith(1);
    expect(deps.logs).toContainEqual({ event: 'iteration_threw', error: 'string', failures: 1 });
    expect(deps.sleeps.filter((s) => s === DB_RETRY_SLEEP_MS)).toHaveLength(MAX_DB_FAILURES);
  });

  it('stamps the new lane drained exactly when a claim finds it empty right after a batch that drew from it', async () => {
    const store = makeStore([[row('B1', 'new')], [row('B2', 'due')], [row('B3', 'due')]]);
    const deps = makeDeps(store, async (asins) => reply(asins));
    const state = initialState();
    await runIteration(deps, state);
    await runIteration(deps, state);
    await runIteration(deps, state);
    expect(store.calls.filter((c) => c === 'drained')).toHaveLength(1);
    expect(store.calls.indexOf('drained')).toBeGreaterThan(store.calls.indexOf('write'));
  });
});

describe('startHeartbeat', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('beats every interval with null token values, logs a failure, never overlaps two beats, and does not hold the process', async () => {
    vi.useFakeTimers();
    let mode: 'ok' | 'fail' | 'hang' = 'ok';
    let unhang: () => void = () => undefined;
    const store = {
      heartbeat: vi.fn(async () => {
        if (mode === 'fail') throw Object.assign(new Error('down'), { code: '57P01' });
        if (mode === 'hang') await new Promise<void>((resolve) => { unhang = resolve; });
      }),
    };
    const logs: Record<string, unknown>[] = [];
    const timer = startHeartbeat(store, (f) => { logs.push(f); });
    expect(timer.hasRef()).toBe(false);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    expect(store.heartbeat).toHaveBeenCalledTimes(1);
    expect(store.heartbeat).toHaveBeenCalledWith({ tokensLeft: null, refillRate: null });
    mode = 'fail';
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    expect(logs).toEqual([{ event: 'heartbeat_failed', error: 'Error', code: '57P01' }]);
    mode = 'hang';
    await vi.advanceTimersByTimeAsync(3 * HEARTBEAT_INTERVAL_MS);
    expect(store.heartbeat).toHaveBeenCalledTimes(3); // the hung beat holds off the next two
    unhang();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    expect(store.heartbeat).toHaveBeenCalledTimes(4);
    clearInterval(timer);
  });
});

describe('releaseOwnClaimsOnShutdown', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('releases this boot\'s claims and logs the count', async () => {
    const logs: Record<string, unknown>[] = [];
    const store = { releaseOwnClaims: vi.fn(async () => 4) };
    await expect(releaseOwnClaimsOnShutdown(store, 'boot-1', (f) => { logs.push(f); })).resolves.toBe(4);
    expect(store.releaseOwnClaims).toHaveBeenCalledWith('boot-1');
    expect(logs).toEqual([{ event: 'sigterm', released: 4 }]);
  });

  it('gives up after the timeout, so a hung database cannot block shutdown', async () => {
    vi.useFakeTimers();
    const logs: Record<string, unknown>[] = [];
    const store = { releaseOwnClaims: () => new Promise<number>(() => undefined) };
    const done = releaseOwnClaimsOnShutdown(store, 'boot-1', (f) => { logs.push(f); });
    await vi.advanceTimersByTimeAsync(SHUTDOWN_RELEASE_TIMEOUT_MS);
    await expect(done).resolves.toBeNull();
    expect(logs).toEqual([{ event: 'sigterm', released: null, timedOut: true }]);
  });

  it('a failed release is logged with coded fields only and resolves to null', async () => {
    const logs: Record<string, unknown>[] = [];
    const store = { releaseOwnClaims: async (): Promise<number> => { throw Object.assign(new Error('password authentication failed'), { code: '28P01' }); } };
    await expect(releaseOwnClaimsOnShutdown(store, 'boot-1', (f) => { logs.push(f); })).resolves.toBeNull();
    expect(logs).toEqual([{ event: 'sigterm', released: null, error: 'Error', code: '28P01' }]);
  });
});
