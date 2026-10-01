import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockDb } = vi.hoisted(() => ({ mockDb: { select: vi.fn() } }));
vi.mock('@/lib/env', () => ({ env: {} }));
vi.mock('@/db/client', () => ({ db: mockDb }));

import { PgDialect } from 'drizzle-orm/pg-core';
import { listWatchlistWithKeywords } from './loadServer';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const KW = '44444444-4444-4444-8444-444444444444';

/** Next `db.select().from().innerJoin().where().orderBy()` resolves to `rows`; returns the `where` mock so the predicate can be inspected. */
function selectJoinWhere(rows: unknown[]) {
  const where = vi.fn().mockReturnValueOnce({ orderBy: vi.fn().mockResolvedValueOnce(rows) });
  mockDb.select.mockReturnValueOnce({ from: vi.fn().mockReturnValueOnce({ innerJoin: vi.fn().mockReturnValueOnce({ where }) }) } as never);
  return { where };
}

beforeEach(() => vi.clearAllMocks());

describe('listWatchlistWithKeywords', () => {
  it('reads only the caller\'s own rows and returns them with the keyword text', async () => {
    const { where } = selectJoinWhere([{ keywordId: KW, keyword: 'desk lamp', addedAt: new Date('2026-09-30T09:00:00Z') }]);
    await expect(listWatchlistWithKeywords(USER_ID)).resolves.toEqual([{ keywordId: KW, keyword: 'desk lamp', addedAt: '2026-09-30T09:00:00.000Z' }]);
    // Owner-scoped: list_watchlist can never read another account's watchlist.
    expect(new PgDialect().sqlToQuery(where.mock.calls[0][0])).toMatchObject({ sql: '"watchlist_items"."user_id" = $1', params: [USER_ID] });
  });
});
