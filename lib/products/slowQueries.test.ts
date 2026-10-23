// lib/products/slowQueries.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DrizzleQueryError } from 'drizzle-orm';

const { mockValues, mockInsert } = vi.hoisted(() => {
  const mockValues = vi.fn();
  const mockInsert = vi.fn().mockReturnValue({ values: mockValues });
  return { mockValues, mockInsert };
});

vi.mock('@/db/client', () => ({ db: { insert: mockInsert } }));

import { slowQueries } from '@/db/schema';
import { QUERY_STRING_MAX_CHARS, recordSlowProductSearch, SLOW_PRODUCT_SEARCH_MS } from './slowQueries';

describe('recordSlowProductSearch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValues.mockResolvedValue(undefined);
  });

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

    it('is 32000 characters, so a cut string and its marker still fit a Windows environment variable (32,767 characters)', () => {
      expect(QUERY_STRING_MAX_CHARS).toBe(32_000);
      expect(`${ofLength(QUERY_STRING_MAX_CHARS)} ...[+9999999 chars]`.length).toBeLessThan(32_767);
    });

    it('a 32000-character string is stored whole', async () => {
      const s = ofLength(32_000);
      expect(s).toHaveLength(32_000);
      await recordSlowProductSearch({ userId: 'u1', queryString: s, elapsedMs: 30_000, timedOut: true, surface: 'products_tool' });
      expect(stored()).toBe(s);
    });

    it('a 32001-character string is stored as its first 32000 characters and " ...[+1 chars]"', async () => {
      const s = ofLength(32_001);
      await recordSlowProductSearch({ userId: 'u1', queryString: s, elapsedMs: 30_000, timedOut: true, surface: 'products_tool' });
      expect(stored()).toBe(`${s.slice(0, 32_000)} ...[+1 chars]`);
    });

    it("the marker's N is exactly the characters dropped, on the list's surface as on the tool's", async () => {
      const s = ofLength(45_678);
      await recordSlowProductSearch({ userId: 'u1', queryString: s, elapsedMs: 9_000, timedOut: false });
      await recordSlowProductSearch({ userId: 'u1', queryString: s, elapsedMs: 9_000, timedOut: false, surface: 'products_tool' });
      for (const n of [0, 1]) {
        expect(stored(n)).toBe(`${s.slice(0, 32_000)} ...[+13678 chars]`);
        expect(stored(n)).toHaveLength(32_000 + ' ...[+13678 chars]'.length);
      }
      expect(mockValues.mock.calls.map(([row]) => (row as { surface: string }).surface)).toEqual(['products', 'products_tool']);
    });
  });

  it('a failed insert resolves anyway and warns one line with the coded fields only: never the message, the statement or its params', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // drizzle's neon-http session rethrows a failed statement as DrizzleQueryError (its own message embeds the SQL and the params); errFields reads the cause.
    const cause = Object.assign(new Error('SECRET relation "slow_queries" does not exist'), { code: '42P01' });
    mockValues.mockRejectedValueOnce(new DrizzleQueryError('insert into "slow_queries" ("surface", "query_string") values ($1, $2) -- SECRET', ['products', 'SECRET-PARAM'], cause));
    await expect(recordSlowProductSearch({ userId: 'u1', queryString: 'sort=keywords', elapsedMs: 9_000, timedOut: false })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[slow-queries] record failed', JSON.stringify({ outcome: 'record_failed', error: 'Error', code: '42P01' }));
    expect(warn.mock.calls.flat().join(' ')).not.toContain('SECRET');
    warn.mockRestore();
  });

  it('an uncoded failure warns the same line without a code', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockValues.mockRejectedValueOnce(new TypeError('SECRET fetch failed'));
    await expect(recordSlowProductSearch({ userId: 'u1', queryString: 'sort=keywords', elapsedMs: 31_000, timedOut: true })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[slow-queries] record failed', JSON.stringify({ outcome: 'record_failed', error: 'TypeError' }));
    expect(warn.mock.calls.flat().join(' ')).not.toContain('SECRET');
    warn.mockRestore();
  });
});
