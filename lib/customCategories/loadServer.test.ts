import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockDb } = vi.hoisted(() => ({ mockDb: { select: vi.fn() } }));
vi.mock('@/lib/env', () => ({ env: {} }));
vi.mock('@/db/client', () => ({ db: mockDb }));

import { PgDialect } from 'drizzle-orm/pg-core';
import { loadCustomCategoryForUser } from './loadServer';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const CAT_ID = '22222222-2222-4222-8222-222222222222';
const row = { id: CAT_ID, userId: USER_ID, name: 'Lighting', leafPaths: ['Lighting › Lamps'], createdAt: new Date('2026-09-30T10:00:00Z'), updatedAt: new Date('2026-09-30T10:00:00Z') };
const dto = { id: CAT_ID, name: 'Lighting', leafPaths: ['Lighting › Lamps'], createdAt: '2026-09-30T10:00:00.000Z', updatedAt: '2026-09-30T10:00:00.000Z' };

/** Next `db.select().from().where().limit()` resolves to `rows`; returns the `where` mock so the predicate can be inspected. */
function selectLimit(rows: unknown[]) {
  const where = vi.fn().mockReturnValueOnce({ limit: vi.fn().mockResolvedValueOnce(rows) });
  mockDb.select.mockReturnValueOnce({ from: vi.fn().mockReturnValueOnce({ where }) } as never);
  return { where };
}

beforeEach(() => vi.clearAllMocks());

describe('loadCustomCategoryForUser', () => {
  it('returns null for a malformed id without querying', async () => {
    await expect(loadCustomCategoryForUser(USER_ID, 'nope')).resolves.toBeNull();
    expect(mockDb.select).not.toHaveBeenCalled();
  });
  it('returns the owner-scoped row as a DTO', async () => {
    const { where } = selectLimit([row]);
    await expect(loadCustomCategoryForUser(USER_ID, CAT_ID)).resolves.toEqual(dto);
    expect(new PgDialect().sqlToQuery(where.mock.calls[0][0])).toMatchObject({ sql: '("custom_categories"."id" = $1 and "custom_categories"."user_id" = $2)', params: [CAT_ID, USER_ID] });
  });
  it('returns null when no row matches (missing or another account\'s)', async () => {
    selectLimit([]);
    await expect(loadCustomCategoryForUser(USER_ID, CAT_ID)).resolves.toBeNull();
  });
});
