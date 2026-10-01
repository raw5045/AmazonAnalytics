import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const { mockDb, mockCount } = vi.hoisted(() => ({
  mockDb: { select: vi.fn(), insert: vi.fn(), delete: vi.fn() },
  mockCount: vi.fn(),
}));
vi.mock('@/lib/env', () => ({ env: {} }));
vi.mock('@/db/client', () => ({ db: mockDb }));
vi.mock('./loadServer', () => ({ watchlistCountForUser: mockCount }));

import { addToWatchlist, removeFromWatchlist } from './commands';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const KW = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** The SQL + params a command handed to `.where(...)`, rendered the way drizzle sends it (pins the owner scoping). */
const rendered = (where: ReturnType<typeof vi.fn>) => new PgDialect().sqlToQuery(where.mock.calls[0][0]);

/** Next `db.select(...).from(...).where(...)` resolves to `rows`; returns the `where` mock. Order matters: text match, then id check, then existing rows. */
function selectWhere(rows: unknown[]) {
  const where = vi.fn().mockResolvedValueOnce(rows);
  mockDb.select.mockReturnValueOnce({ from: vi.fn().mockReturnValueOnce({ where }) } as never);
  return { where };
}
function insertReturns(ids: string[]) {
  mockDb.insert.mockReturnValueOnce({ values: vi.fn().mockReturnValueOnce({ onConflictDoNothing: vi.fn().mockReturnValueOnce({ returning: vi.fn().mockResolvedValueOnce(ids.map((k) => ({ k }))) }) }) } as never);
}
function deleteReturns(ids: string[]) {
  const where = vi.fn().mockReturnValueOnce({ returning: vi.fn().mockResolvedValueOnce(ids.map((k) => ({ k }))) });
  mockDb.delete.mockReturnValueOnce({ where } as never);
  return { where };
}

beforeEach(() => vi.clearAllMocks());

describe('addToWatchlist', () => {
  it('matches text and ids, dedupes across both, reports unmatched in the caller\'s words, and inserts what fits', async () => {
    selectWhere([{ id: KW(1), normalized: 'desk lamp' }]);                 // text match: 'desk lamp' found, 'no such thing' not
    selectWhere([{ id: KW(1) }, { id: KW(2) }]);                           // id check: KW(1) (again), KW(2) found; KW(9) not
    const { where } = selectWhere([{ keywordId: KW(2) }]);                 // already watching KW(2)
    mockCount.mockResolvedValueOnce(99);                                   // room for one
    insertReturns([KW(1)]);
    const r = await addToWatchlist(USER_ID, { keywords: ['Desk Lamp', 'no such thing'], searchTermIds: [KW(1), KW(2), KW(9)] });
    expect(r).toEqual({ added: 1, alreadyWatching: 1, unmatched: ['no such thing', KW(9)], skippedAtCap: 0 });
    // "Already watching" reads the caller's own rows only: another account watching KW(1) must not make it count here.
    expect(rendered(where)).toMatchObject({ sql: '("watchlist_items"."user_id" = $1 and "watchlist_items"."keyword_id" in ($2, $3))', params: [USER_ID, KW(1), KW(2)] });
  });
  it('skips at the cap in input order and reports the rest', async () => {
    selectWhere([{ id: KW(1), normalized: 'a' }, { id: KW(2), normalized: 'b' }, { id: KW(3), normalized: 'c' }]);
    selectWhere([]);                                                       // none already watching
    mockCount.mockResolvedValueOnce(98);                                   // room for two
    insertReturns([KW(1), KW(2)]);
    const r = await addToWatchlist(USER_ID, { keywords: ['a', 'b', 'c'], searchTermIds: [] });
    expect(r).toEqual({ added: 2, alreadyWatching: 0, unmatched: [], skippedAtCap: 1 });
  });
  it('makes no database call when nothing usable was passed, and reports a malformed id as unmatched', async () => {
    await expect(addToWatchlist(USER_ID, { keywords: ['  '], searchTermIds: ['not-a-uuid'] })).resolves.toEqual({ added: 0, alreadyWatching: 0, unmatched: ['not-a-uuid'], skippedAtCap: 0 });
    expect(mockDb.select).not.toHaveBeenCalled();
  });
});

describe('removeFromWatchlist', () => {
  it('deletes the matched rows the caller owns and counts the rest as not watching', async () => {
    selectWhere([{ id: KW(1), normalized: 'desk lamp' }]);
    selectWhere([{ id: KW(2) }]);
    const { where } = deleteReturns([KW(1)]);
    const r = await removeFromWatchlist(USER_ID, { keywords: ['desk lamp', 'ghost'], searchTermIds: [KW(2)] });
    expect(r).toEqual({ removed: 1, notWatching: 1, unmatched: ['ghost'] });
    // Owner-scoped: the caller's user id AND the matched keywords, so another account's rows are never deleted.
    expect(rendered(where)).toMatchObject({ sql: '("watchlist_items"."user_id" = $1 and "watchlist_items"."keyword_id" in ($2, $3))', params: [USER_ID, KW(1), KW(2)] });
  });
  it('is a no-op without a match', async () => {
    selectWhere([]);
    await expect(removeFromWatchlist(USER_ID, { keywords: ['ghost'], searchTermIds: [] })).resolves.toEqual({ removed: 0, notWatching: 0, unmatched: ['ghost'] });
    expect(mockDb.delete).not.toHaveBeenCalled();
  });
});
