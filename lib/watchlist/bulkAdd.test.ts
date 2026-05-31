import { describe, it, expect, beforeEach, vi } from 'vitest';

// Hoisted so vi.mock() below can reference them before the helper is imported.
const { mockDb, mockWatchlistCountForUser } = vi.hoisted(() => ({
  mockDb: {
    select: vi.fn(),
    insert: vi.fn(),
  },
  mockWatchlistCountForUser: vi.fn(),
}));

vi.mock('@/db/client', () => ({ db: mockDb }));
vi.mock('./loadServer', () => ({
  watchlistCountForUser: mockWatchlistCountForUser,
}));

import { bulkAddToWatchlist, BulkAddInputError } from './bulkAdd';

// --- Helpers to build the drizzle chain mocks --------------------------

/**
 * Stub the next `db.select(...).from(...).where(...)` call to resolve
 * to `rows`. Each helper call consumes one db.select invocation, so the
 * order of these calls in a test MUST match the order the implementation
 * issues them: (1) match search_terms, (2) existing watchlist rows.
 */
function mockSelectOnce(rows: unknown[]) {
  mockDb.select.mockReturnValueOnce({
    from: vi.fn().mockReturnValueOnce({
      where: vi.fn().mockResolvedValueOnce(rows),
    }),
  } as never);
}

/**
 * Stub the next `db.insert(...).values(...).onConflictDoNothing().returning(...)`
 * call to resolve to one row per id in `insertedKeywordIds`.
 */
function mockInsertReturnsIds(insertedKeywordIds: string[]) {
  mockDb.insert.mockReturnValueOnce({
    values: vi.fn().mockReturnValueOnce({
      onConflictDoNothing: vi.fn().mockReturnValueOnce({
        returning: vi.fn().mockResolvedValueOnce(
          insertedKeywordIds.map((k) => ({ k })),
        ),
      }),
    }),
  } as never);
}

const USER_ID = '00000000-0000-0000-0000-000000000001';
const KW = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

beforeEach(() => {
  vi.clearAllMocks();
});

// --- Tests -------------------------------------------------------------

describe('bulkAddToWatchlist', () => {
  it('returns all-zero counts and makes no DB calls for empty input', async () => {
    const result = await bulkAddToWatchlist(USER_ID, []);
    expect(result).toEqual({
      added: 0,
      alreadyWatching: 0,
      unmatched: [],
      skippedAtCap: 0,
    });
    expect(mockDb.select).not.toHaveBeenCalled();
    expect(mockDb.insert).not.toHaveBeenCalled();
    expect(mockWatchlistCountForUser).not.toHaveBeenCalled();
  });

  it('returns all-zero counts when input is only whitespace lines', async () => {
    const result = await bulkAddToWatchlist(USER_ID, ['   ', '\t', '']);
    expect(result).toEqual({
      added: 0,
      alreadyWatching: 0,
      unmatched: [],
      skippedAtCap: 0,
    });
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it('throws BulkAddInputError for > 500 keywords', async () => {
    const tooMany = Array.from({ length: 501 }, (_, i) => `kw${i}`);
    await expect(bulkAddToWatchlist(USER_ID, tooMany)).rejects.toBeInstanceOf(
      BulkAddInputError,
    );
  });

  it('all-match: returns added=N, no unmatched, no skipped', async () => {
    // 3 inputs, all match
    mockSelectOnce([
      { id: KW(1), normalized: 'wireless earbuds' },
      { id: KW(2), normalized: 'airpods case' },
      { id: KW(3), normalized: 'usb cable' },
    ]);
    // none already watching
    mockSelectOnce([]);
    mockWatchlistCountForUser.mockResolvedValueOnce(0);
    mockInsertReturnsIds([KW(1), KW(2), KW(3)]);

    const result = await bulkAddToWatchlist(USER_ID, [
      'wireless earbuds',
      'airpods case',
      'usb cable',
    ]);

    expect(result).toEqual({
      added: 3,
      alreadyWatching: 0,
      unmatched: [],
      skippedAtCap: 0,
    });
  });

  it('mixed match/unmatch: unmatched bucket contains display strings in input order', async () => {
    // Only "wireless earbuds" matches; the other two don't exist in search_terms.
    mockSelectOnce([
      { id: KW(1), normalized: 'wireless earbuds' },
    ]);
    mockSelectOnce([]); // no existing
    mockWatchlistCountForUser.mockResolvedValueOnce(0);
    mockInsertReturnsIds([KW(1)]);

    const result = await bulkAddToWatchlist(USER_ID, [
      'fooo',
      'wireless earbuds',
      'bbarr',
    ]);

    expect(result).toEqual({
      added: 1,
      alreadyWatching: 0,
      unmatched: ['fooo', 'bbarr'],
      skippedAtCap: 0,
    });
  });

  it('dedupes by normalized form; keeps the FIRST display form for unmatched', async () => {
    // None match — so all 3 inputs end up in unmatched. But "Shoes", "SHOES",
    // and "shoes" normalize to the same key, so unmatched should contain
    // exactly ONE entry, and it should be the first display form: "Shoes".
    mockSelectOnce([]); // search_terms match
    // No second select (no matches to look up); no count; no insert.

    const result = await bulkAddToWatchlist(USER_ID, ['Shoes', 'SHOES', 'shoes']);

    expect(result).toEqual({
      added: 0,
      alreadyWatching: 0,
      unmatched: ['Shoes'],
      skippedAtCap: 0,
    });
    // Only one select call (the match query); no existing-watchlist check
    // and no count when there's nothing to insert.
    expect(mockDb.select).toHaveBeenCalledTimes(1);
    expect(mockDb.insert).not.toHaveBeenCalled();
    expect(mockWatchlistCountForUser).not.toHaveBeenCalled();
  });

  it('already-watching keyword: counted in alreadyWatching, not added', async () => {
    // Two inputs, both match. One is already in the watchlist.
    mockSelectOnce([
      { id: KW(1), normalized: 'wireless earbuds' },
      { id: KW(2), normalized: 'airpods case' },
    ]);
    // KW(1) already watched
    mockSelectOnce([{ keywordId: KW(1) }]);
    mockWatchlistCountForUser.mockResolvedValueOnce(1);
    mockInsertReturnsIds([KW(2)]);

    const result = await bulkAddToWatchlist(USER_ID, [
      'wireless earbuds',
      'airpods case',
    ]);

    expect(result).toEqual({
      added: 1,
      alreadyWatching: 1,
      unmatched: [],
      skippedAtCap: 0,
    });
  });

  it('cap overrun: slices toInsert in input order, surplus -> skippedAtCap', async () => {
    // 5 matches, currentCount=98, so only 2 slots remain. The first 2 in
    // input order get inserted; the remaining 3 go into skippedAtCap.
    mockSelectOnce([
      { id: KW(1), normalized: 'first' },
      { id: KW(2), normalized: 'second' },
      { id: KW(3), normalized: 'third' },
      { id: KW(4), normalized: 'fourth' },
      { id: KW(5), normalized: 'fifth' },
    ]);
    mockSelectOnce([]); // none already watching
    mockWatchlistCountForUser.mockResolvedValueOnce(98);
    mockInsertReturnsIds([KW(1), KW(2)]);

    const result = await bulkAddToWatchlist(USER_ID, [
      'first', 'second', 'third', 'fourth', 'fifth',
    ]);

    expect(result).toEqual({
      added: 2,
      alreadyWatching: 0,
      unmatched: [],
      skippedAtCap: 3,
    });
  });

  it('at-cap exactly (currentCount=100): everything matched goes to skippedAtCap', async () => {
    mockSelectOnce([
      { id: KW(1), normalized: 'first' },
      { id: KW(2), normalized: 'second' },
    ]);
    mockSelectOnce([]); // none already watching
    mockWatchlistCountForUser.mockResolvedValueOnce(100);
    // No insert call expected — toInsert is sliced to 0.

    const result = await bulkAddToWatchlist(USER_ID, ['first', 'second']);

    expect(result).toEqual({
      added: 0,
      alreadyWatching: 0,
      unmatched: [],
      skippedAtCap: 2,
    });
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('cap overrun + alreadyWatching: alreadyWatching does not consume cap slots', async () => {
    // 3 matches; 1 is already watched, 2 are new. currentCount=99, so
    // remainingCap=1. The 2 new ones split: 1 added, 1 skipped.
    mockSelectOnce([
      { id: KW(1), normalized: 'first' },   // already watching
      { id: KW(2), normalized: 'second' },  // new
      { id: KW(3), normalized: 'third' },   // new
    ]);
    mockSelectOnce([{ keywordId: KW(1) }]);
    mockWatchlistCountForUser.mockResolvedValueOnce(99);
    mockInsertReturnsIds([KW(2)]);

    const result = await bulkAddToWatchlist(USER_ID, ['first', 'second', 'third']);

    expect(result).toEqual({
      added: 1,
      alreadyWatching: 1,
      unmatched: [],
      skippedAtCap: 1,
    });
  });
});
