// lib/keepa/batchClient.test.ts
import { describe, it, expect, vi } from 'vitest';
import {
  fetchKeepaBatch,
  fetchTokenStatus,
  buildProductUrl,
  KeepaHttpError,
  KeepaTokenError,
  KeepaReplyError,
  HISTORY_PARAMS,
  STATS_DAYS,
} from './batchClient';

const KEY = 'secret-key-value';

function fakeFetch(status: number, body: unknown) {
  return vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })) as unknown as typeof fetch;
}

/** A reply whose body cannot be read: json() rejects with `err`. */
function fakeFetchJsonRejects(status: number, err: unknown) {
  return vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => { throw err; } })) as unknown as typeof fetch;
}

/** A reply whose unread body records a cancel. */
function fakeFetchWithBody(status: number) {
  const cancel = vi.fn(async () => undefined);
  const f = vi.fn(async () => ({ ok: status >= 200 && status < 300, status, body: { cancel }, json: async () => ({}) })) as unknown as typeof fetch;
  return { f, cancel };
}

describe('buildProductUrl', () => {
  it('asks for all ASINs in one request with rating and stats, and the history switch from the capture decision', () => {
    const url = new URL(buildProductUrl(['B000000001', 'B000000002'], KEY));
    expect(url.origin + url.pathname).toBe('https://api.keepa.com/product');
    expect(url.searchParams.get('domain')).toBe('1');
    expect(url.searchParams.get('asin')).toBe('B000000001,B000000002');
    expect(url.searchParams.get('rating')).toBe('1');
    expect(url.searchParams.get('stats')).toBe(STATS_DAYS);
    for (const [k, v] of Object.entries(HISTORY_PARAMS)) expect(url.searchParams.get(k)).toBe(v);
    expect(url.searchParams.get('key')).toBe(KEY);
  });
});

describe('fetchKeepaBatch', () => {
  it('returns the products and the token envelope', async () => {
    const f = fakeFetch(200, { products: [{ asin: 'B000000001' }], tokensLeft: 14_800, refillIn: 12_000, refillRate: 250, tokensConsumed: 2 });
    const r = await fetchKeepaBatch(['B000000001'], { apiKey: KEY, fetchImpl: f });
    expect(r.products).toHaveLength(1);
    expect(r).toMatchObject({ tokensLeft: 14_800, refillIn: 12_000, refillRate: 250, tokensConsumed: 2 });
  });
  it('rounds the token envelope to integers (the service stores it in integer columns)', async () => {
    const f = fakeFetch(200, { products: [{ asin: 'B000000001' }], tokensLeft: 14_800.4, refillIn: 12_000.6, refillRate: 249.5, tokensConsumed: 2.2 });
    await expect(fetchKeepaBatch(['B000000001'], { apiKey: KEY, fetchImpl: f })).resolves.toMatchObject({ tokensLeft: 14_800, refillIn: 12_001, refillRate: 250, tokensConsumed: 2 });
  });
  it('rejects a 200 reply that carries no products array as KeepaReplyError', async () => {
    const err = await fetchKeepaBatch(['B000000001'], { apiKey: KEY, fetchImpl: fakeFetch(200, { tokensLeft: 1 }) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KeepaReplyError);
    expect(err).toMatchObject({ name: 'KeepaReplyError', message: 'keepa_bad_reply' });
  });
  it('rejects an empty products array as KeepaReplyError, never "every ASIN missing"', async () => {
    await expect(fetchKeepaBatch(['B000000001'], { apiKey: KEY, fetchImpl: fakeFetch(200, { products: [], tokensLeft: 1 }) })).rejects.toBeInstanceOf(KeepaReplyError);
  });
  it('rejects a 200 whose body is not a JSON object (null, an array, a primitive, invalid JSON) as KeepaReplyError', async () => {
    const invalidJson = fakeFetchJsonRejects(200, new SyntaxError('bad json'));
    for (const fetchImpl of [fakeFetch(200, null), fakeFetch(200, [{ asin: 'B000000001' }]), fakeFetch(200, 5), invalidJson]) {
      await expect(fetchKeepaBatch(['B000000001'], { apiKey: KEY, fetchImpl })).rejects.toBeInstanceOf(KeepaReplyError);
    }
  });
  it('a failure while reading a 200 body keeps its own name instead of becoming KeepaReplyError', async () => {
    const f = fakeFetchJsonRejects(200, Object.assign(new Error('t'), { name: 'TimeoutError' }));
    await expect(fetchKeepaBatch(['B000000001'], { apiKey: KEY, fetchImpl: f })).rejects.toMatchObject({ name: 'TimeoutError' });
  });
  it('leaves envelope fields Keepa omitted as null', async () => {
    const r = await fetchKeepaBatch(['B000000001'], { apiKey: KEY, fetchImpl: fakeFetch(200, { products: [{ asin: 'B000000001' }], tokensLeft: 1 }) });
    expect(r.products).toHaveLength(1);
    expect(r.refillRate).toBeNull();
  });
  it('turns 429 into KeepaTokenError carrying refillIn (ms), defaulting to a minute', async () => {
    await expect(fetchKeepaBatch(['B000000001'], { apiKey: KEY, fetchImpl: fakeFetch(429, { refillIn: 31_000 }) })).rejects.toMatchObject({ name: 'KeepaTokenError', refillInMs: 31_000 });
    await expect(fetchKeepaBatch(['B000000001'], { apiKey: KEY, fetchImpl: fakeFetch(429, {}) })).rejects.toMatchObject({ refillInMs: 60_000 });
    await expect(fetchKeepaBatch(['B000000001'], { apiKey: KEY, fetchImpl: fakeFetch(429, null) })).rejects.toMatchObject({ name: 'KeepaTokenError', refillInMs: 60_000 });
    const unreadable = fakeFetchJsonRejects(429, Object.assign(new Error('t'), { name: 'TimeoutError' }));
    await expect(fetchKeepaBatch(['B000000001'], { apiKey: KEY, fetchImpl: unreadable })).rejects.toMatchObject({ name: 'KeepaTokenError', refillInMs: 60_000 });
  });
  it('clamps the 429 wait to 1–120 s', async () => {
    await expect(fetchKeepaBatch(['B000000001'], { apiKey: KEY, fetchImpl: fakeFetch(429, { refillIn: 0 }) })).rejects.toMatchObject({ refillInMs: 1_000 });
    await expect(fetchKeepaBatch(['B000000001'], { apiKey: KEY, fetchImpl: fakeFetch(429, { refillIn: 999_999 }) })).rejects.toMatchObject({ refillInMs: 120_000 });
  });
  it('turns other failures into KeepaHttpError with the status and no key in the message', async () => {
    const err = await fetchKeepaBatch(['B000000001'], { apiKey: KEY, fetchImpl: fakeFetch(503, {}) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KeepaHttpError);
    expect((err as KeepaHttpError).status).toBe(503);
    expect(String((err as Error).message)).not.toContain(KEY);
    expect(new KeepaTokenError(5).message).not.toContain(KEY);
  });
  it('cancels the unread body before throwing on an HTTP error', async () => {
    const { f, cancel } = fakeFetchWithBody(503);
    await expect(fetchKeepaBatch(['B000000001'], { apiKey: KEY, fetchImpl: f })).rejects.toBeInstanceOf(KeepaHttpError);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it('refuses an empty or oversized batch with a RangeError before any request', async () => {
    const f = fakeFetch(200, {});
    await expect(fetchKeepaBatch([], { apiKey: KEY, fetchImpl: f })).rejects.toThrow(RangeError);
    await expect(fetchKeepaBatch(new Array(101).fill('B000000001'), { apiKey: KEY, fetchImpl: f })).rejects.toThrow(RangeError);
    expect(f).not.toHaveBeenCalled();
  });
  it('passes a timeout signal to fetch', async () => {
    const f = fakeFetch(200, { products: [{ asin: 'B000000001' }] });
    await fetchKeepaBatch(['B000000001'], { apiKey: KEY, fetchImpl: f });
    const init = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0][1];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('fetchTokenStatus', () => {
  it('reads the free token endpoint', async () => {
    const f = fakeFetch(200, { tokensLeft: 15_000, refillRate: 250, refillIn: 12_729 });
    await expect(fetchTokenStatus({ apiKey: KEY, fetchImpl: f })).resolves.toEqual({ tokensLeft: 15_000, refillRate: 250, refillIn: 12_729 });
    const url = (f as unknown as { mock: { calls: [string][] } }).mock.calls[0][0];
    expect(url.startsWith('https://api.keepa.com/token?')).toBe(true);
  });
  it('rounds the token fields to integers', async () => {
    const f = fakeFetch(200, { tokensLeft: 14_800.4, refillRate: 250.2, refillIn: 12_729.7 });
    await expect(fetchTokenStatus({ apiKey: KEY, fetchImpl: f })).resolves.toEqual({ tokensLeft: 14_800, refillRate: 250, refillIn: 12_730 });
  });
  it('turns a non-OK reply into KeepaHttpError, cancelling the unread body', async () => {
    const { f, cancel } = fakeFetchWithBody(500);
    const err = await fetchTokenStatus({ apiKey: KEY, fetchImpl: f }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KeepaHttpError);
    expect((err as KeepaHttpError).status).toBe(500);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it('rejects a body that is not a JSON object as KeepaReplyError', async () => {
    await expect(fetchTokenStatus({ apiKey: KEY, fetchImpl: fakeFetch(200, null) })).rejects.toBeInstanceOf(KeepaReplyError);
  });
});
