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
  it('rejects a 200 reply that carries no products array as KeepaReplyError', async () => {
    const err = await fetchKeepaBatch(['B000000001'], { apiKey: KEY, fetchImpl: fakeFetch(200, { tokensLeft: 1 }) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KeepaReplyError);
    expect(err).toMatchObject({ name: 'KeepaReplyError', message: 'keepa_bad_reply' });
  });
  it('leaves envelope fields Keepa omitted as null', async () => {
    const r = await fetchKeepaBatch(['B000000001'], { apiKey: KEY, fetchImpl: fakeFetch(200, { products: [], tokensLeft: 1 }) });
    expect(r.products).toEqual([]);
    expect(r.refillRate).toBeNull();
  });
  it('turns 429 into KeepaTokenError carrying refillIn (ms), defaulting to a minute', async () => {
    await expect(fetchKeepaBatch(['B000000001'], { apiKey: KEY, fetchImpl: fakeFetch(429, { refillIn: 31_000 }) })).rejects.toMatchObject({ name: 'KeepaTokenError', refillInMs: 31_000 });
    await expect(fetchKeepaBatch(['B000000001'], { apiKey: KEY, fetchImpl: fakeFetch(429, {}) })).rejects.toMatchObject({ refillInMs: 60_000 });
  });
  it('turns other failures into KeepaHttpError with the status and no key in the message', async () => {
    const err = await fetchKeepaBatch(['B000000001'], { apiKey: KEY, fetchImpl: fakeFetch(503, {}) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KeepaHttpError);
    expect((err as KeepaHttpError).status).toBe(503);
    expect(String((err as Error).message)).not.toContain(KEY);
    expect(new KeepaTokenError(5).message).not.toContain(KEY);
  });
  it('refuses an empty or oversized batch before any request', async () => {
    const f = fakeFetch(200, {});
    await expect(fetchKeepaBatch([], { apiKey: KEY, fetchImpl: f })).rejects.toThrow();
    await expect(fetchKeepaBatch(new Array(101).fill('B000000001'), { apiKey: KEY, fetchImpl: f })).rejects.toThrow();
    expect(f).not.toHaveBeenCalled();
  });
});

describe('fetchTokenStatus', () => {
  it('reads the free token endpoint', async () => {
    const f = fakeFetch(200, { tokensLeft: 15_000, refillRate: 250, refillIn: 12_729 });
    await expect(fetchTokenStatus({ apiKey: KEY, fetchImpl: f })).resolves.toEqual({ tokensLeft: 15_000, refillRate: 250, refillIn: 12_729 });
    const url = (f as unknown as { mock: { calls: [string][] } }).mock.calls[0][0];
    expect(url.startsWith('https://api.keepa.com/token?')).toBe(true);
  });
});
