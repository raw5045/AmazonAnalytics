// lib/products/slowQueries.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DrizzleQueryError } from 'drizzle-orm';

const { mockValues, mockInsert } = vi.hoisted(() => {
  const mockValues = vi.fn();
  const mockInsert = vi.fn().mockReturnValue({ values: mockValues });
  return { mockValues, mockInsert };
});

vi.mock('@/db/client', () => ({ db: { insert: mockInsert } }));
// after() throws "outside a request scope" in plain vitest; this one captures the callback, so a test runs it the way
// Next does once the response has finished (or throws, as outside a request).
const nextServer = vi.hoisted(() => ({ after: vi.fn() }));
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: nextServer.after }));

import { slowQueries } from '@/db/schema';
import { parseRecordedProductSearch } from './replayQuery';
import { QUERY_STRING_MAX_CHARS, recordSlowProductSearch, scheduleSlowSearchRecord, SLOW_PRODUCT_SEARCH_MS } from './slowQueries';

beforeEach(() => {
  vi.clearAllMocks();
  mockValues.mockResolvedValue(undefined);
  nextServer.after.mockImplementation(() => undefined);
});

describe('recordSlowProductSearch', () => {
  it('SLOW_PRODUCT_SEARCH_MS is 8 s', () => {
    expect(SLOW_PRODUCT_SEARCH_MS).toBe(8_000);
  });

  it('inserts one products row into slow_queries: the account, the query string, the elapsed time rounded to a whole ms, the timeout flag', async () => {
    await recordSlowProductSearch({ userId: 'u1', queryString: 'broad=Home&sort=keywords', elapsedMs: 30_012.6, timedOut: true });
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockInsert).toHaveBeenCalledWith(slowQueries);
    expect(mockValues).toHaveBeenCalledTimes(1);
    expect(mockValues).toHaveBeenCalledWith({ surface: 'products', userId: 'u1', queryString: 'broad=Home&sort=keywords', elapsedMs: 30_013, timedOut: true });
  });

  it('records a slow completed search (timedOut false) and an unknown account (userId null) as given', async () => {
    await recordSlowProductSearch({ userId: null, queryString: '', elapsedMs: 9_000, timedOut: false });
    expect(mockValues).toHaveBeenCalledWith({ surface: 'products', userId: null, queryString: '', elapsedMs: 9_000, timedOut: false });
  });

  it("stores the surface as given: 'products_tool' for the search_products tool, 'products' when passed or absent (the list's calls)", async () => {
    await recordSlowProductSearch({ userId: 'u1', queryString: 'dept=Pet+Supplies&sort=keywords', elapsedMs: 30_001, timedOut: true, surface: 'products_tool' });
    await recordSlowProductSearch({ userId: 'u1', queryString: 'sort=keywords', elapsedMs: 9_000, timedOut: false, surface: 'products' });
    await recordSlowProductSearch({ userId: 'u1', queryString: 'sort=keywords', elapsedMs: 9_000, timedOut: false });
    expect(mockValues.mock.calls).toEqual([
      [{ surface: 'products_tool', userId: 'u1', queryString: 'dept=Pet+Supplies&sort=keywords', elapsedMs: 30_001, timedOut: true }],
      [{ surface: 'products', userId: 'u1', queryString: 'sort=keywords', elapsedMs: 9_000, timedOut: false }],
      [{ surface: 'products', userId: 'u1', queryString: 'sort=keywords', elapsedMs: 9_000, timedOut: false }],
    ]);
  });

  describe('the stored query string is capped at QUERY_STRING_MAX_CHARS, for every surface', () => {
    /** The query string the insert was handed, call `n`. */
    const stored = (n = 0) => (mockValues.mock.calls[n][0] as { queryString: string }).queryString;
    /** A `length`-character query string (URL-encoded strings are ASCII). */
    const ofLength = (length: number) => `leafExact=${'a'.repeat(length - 'leafExact='.length)}`;

    it('is 1,000,000 characters: above the longest string the search_products tool records in practice (2,000 exact paths of 256 characters, URL-encoded)', () => {
      expect(QUERY_STRING_MAX_CHARS).toBe(1_000_000);
      // A catalog-like path of 256 characters, dense with what URL-encoding lengthens: ' › ' separators and an '&' in every segment.
      const path = 'Health & Household › Vitamins › '.repeat(8);
      expect(path).toHaveLength(256);
      const longest = new URLSearchParams(Array.from({ length: 2_000 }, (_, i): [string, string] => ['leafExact', `${path.slice(0, 250)}${String(i).padStart(6, '0')}`]));
      expect(longest.toString().length).toBeLessThan(QUERY_STRING_MAX_CHARS);
    });

    it('a string at the cap is stored whole; the replay reads it as whole', async () => {
      const s = ofLength(QUERY_STRING_MAX_CHARS);
      expect(s).toHaveLength(1_000_000);
      await recordSlowProductSearch({ userId: 'u1', queryString: s, elapsedMs: 30_000, timedOut: true, surface: 'products_tool' });
      expect(stored()).toBe(s);
      expect(parseRecordedProductSearch(stored()).cut).toBe(false);
    });

    it('a string one character over it is stored as its first 1,000,000 characters and " ...[+1 chars]", which the replay reads as cut', async () => {
      const s = ofLength(QUERY_STRING_MAX_CHARS + 1);
      await recordSlowProductSearch({ userId: 'u1', queryString: s, elapsedMs: 30_000, timedOut: true, surface: 'products_tool' });
      expect(stored()).toBe(`${s.slice(0, QUERY_STRING_MAX_CHARS)} ...[+1 chars]`);
      expect(parseRecordedProductSearch(stored()).cut).toBe(true);
    });

    it("the marker's N is exactly the characters dropped, on the list's surface as on the tool's", async () => {
      const s = ofLength(1_234_567);
      await recordSlowProductSearch({ userId: 'u1', queryString: s, elapsedMs: 9_000, timedOut: false });
      await recordSlowProductSearch({ userId: 'u1', queryString: s, elapsedMs: 9_000, timedOut: false, surface: 'products_tool' });
      for (const n of [0, 1]) {
        expect(stored(n)).toBe(`${s.slice(0, QUERY_STRING_MAX_CHARS)} ...[+234567 chars]`);
        expect(stored(n)).toHaveLength(QUERY_STRING_MAX_CHARS + ' ...[+234567 chars]'.length);
      }
      expect(mockValues.mock.calls.map(([row]) => (row as { surface: string }).surface)).toEqual(['products', 'products_tool']);
    });
  });

  it('a failed insert resolves anyway and warns one line with the coded fields only (the surface among them): never the message, the statement or its params', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // drizzle's neon-http session rethrows a failed statement as DrizzleQueryError (its own message embeds the SQL and the params); errFields reads the cause.
    const cause = Object.assign(new Error('SECRET relation "slow_queries" does not exist'), { code: '42P01' });
    mockValues.mockRejectedValueOnce(new DrizzleQueryError('insert into "slow_queries" ("surface", "query_string") values ($1, $2) -- SECRET', ['products', 'SECRET-PARAM'], cause));
    await expect(recordSlowProductSearch({ userId: 'u1', queryString: 'sort=keywords', elapsedMs: 9_000, timedOut: false })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[slow-queries] record failed', JSON.stringify({ outcome: 'record_failed', surface: 'products', error: 'Error', code: '42P01' }));
    expect(warn.mock.calls.flat().join(' ')).not.toContain('SECRET');
    warn.mockRestore();
  });

  it("an uncoded failure warns the same line without a code, with the tool's surface when it was the tool's", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockValues.mockRejectedValueOnce(new TypeError('SECRET fetch failed'));
    await expect(recordSlowProductSearch({ userId: 'u1', queryString: 'sort=keywords', elapsedMs: 31_000, timedOut: true, surface: 'products_tool' })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[slow-queries] record failed', JSON.stringify({ outcome: 'record_failed', surface: 'products_tool', error: 'TypeError' }));
    expect(warn.mock.calls.flat().join(' ')).not.toContain('SECRET');
    warn.mockRestore();
  });
});

describe('scheduleSlowSearchRecord', () => {
  const ROW = { userId: 'u1', queryString: 'broad=Home&sort=keywords', elapsedMs: 30_000, timedOut: true, surface: 'products_tool' as const };

  it('hands after() a callback that records the row once Next runs it, and returns the insert to wait for (waitUntil)', async () => {
    let land!: () => void;
    mockValues.mockReturnValue(new Promise<void>((resolve) => { land = resolve; }));
    expect(scheduleSlowSearchRecord(ROW)).toBeUndefined();
    expect(nextServer.after).toHaveBeenCalledTimes(1);
    // Nothing is written before Next runs the callback.
    expect(mockValues).not.toHaveBeenCalled();
    const waited = (nextServer.after.mock.calls[0][0] as () => Promise<void>)();
    expect(mockValues).toHaveBeenCalledExactlyOnceWith({ surface: 'products_tool', userId: 'u1', queryString: 'broad=Home&sort=keywords', elapsedMs: 30_000, timedOut: true });
    let settled = false;
    void waited.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    land();
    await waited;
    expect(settled).toBe(true);
  });

  it('when after() throws (no request scope), records the row directly and never waits for it', () => {
    nextServer.after.mockImplementation(() => {
      throw new Error('`after` was called outside a request scope.');
    });
    // Never settles: the caller cannot be waiting on the insert.
    mockValues.mockReturnValue(new Promise<void>(() => {}));
    expect(scheduleSlowSearchRecord({ ...ROW, surface: undefined })).toBeUndefined();
    expect(nextServer.after).toHaveBeenCalledTimes(1);
    expect(mockValues).toHaveBeenCalledExactlyOnceWith({ surface: 'products', userId: 'u1', queryString: 'broad=Home&sort=keywords', elapsedMs: 30_000, timedOut: true });
  });
});
