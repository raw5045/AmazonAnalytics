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
import { recordSlowProductSearch, SLOW_PRODUCT_SEARCH_MS } from './slowQueries';

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
