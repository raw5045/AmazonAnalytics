// services/keepa/loop.test.ts
import { describe, it, expect, vi } from 'vitest';
import { runIteration, initialState, type LoopDeps, IDLE_SLEEP_MS, DB_RETRY_SLEEP_MS, KEEPA_RETRY_SLEEP_MS, BAD_REQUEST_SLEEP_MS, MAX_DB_FAILURES } from './loop';
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
    writeBatch: async ({ facts }) => { calls.push('write'); for (const f of facts.values()) written.push({ status: f.status, asin: f.asin }); },
    markBatchErrored: async ({ errorCode }) => { calls.push(`errored:${errorCode}`); },
    heartbeat: async () => { calls.push('heartbeat'); },
    recordError: async (code) => { calls.push(`recordError:${code}`); },
    markNewLaneDrained: async () => { calls.push('drained'); },
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
    expect(deps.sleeps).toEqual([KEEPA_RETRY_SLEEP_MS, KEEPA_RETRY_SLEEP_MS]);
    expect(store.calls).toContain('errored:keepa_http_503');
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

  it('a rejected request (4xx) is recorded, waited out ten minutes, and retried without counting as an attempt', async () => {
    const store = makeStore([[row('B1')]]);
    const fetchBatch = vi.fn().mockRejectedValueOnce(new KeepaHttpError(401)).mockImplementation(async (asins: string[]) => reply(asins));
    const deps = makeDeps(store, fetchBatch);
    await expect(runIteration(deps, initialState())).resolves.toBe('batch');
    expect(store.calls).toContain('recordError:keepa_http_401');
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
