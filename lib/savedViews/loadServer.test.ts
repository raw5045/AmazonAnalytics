import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockDb } = vi.hoisted(() => ({ mockDb: { select: vi.fn() } }));
vi.mock('@/lib/env', () => ({ env: {} }));
vi.mock('@/db/client', () => ({ db: mockDb }));

import { PgDialect } from 'drizzle-orm/pg-core';
import { countSavedViewsForUser, listSavedViewsForUser, loadSavedViewForUser } from './loadServer';
import { EXPLORER_DEFAULTS } from '@/lib/explorer/parseFilters';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const at = (i: number) => new Date(`2026-10-0${i}T10:00:00Z`);
const row = (i: number) => ({ id: `${i}${i}${i}${i}${i}${i}${i}${i}-${i}${i}${i}${i}-4${i}${i}${i}-8${i}${i}${i}-${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}`, userId: USER_ID, name: `View ${i}`, filters: { q: `kw${i}` }, createdAt: at(i), updatedAt: at(i) });

/** Next `db.select().from().where().orderBy()` resolves to `rows` — no `.limit` in the chain: the list is never capped. */
function selectList(rows: unknown[]) {
  const where = vi.fn().mockReturnValueOnce({ orderBy: vi.fn().mockResolvedValueOnce(rows) });
  mockDb.select.mockReturnValueOnce({ from: vi.fn().mockReturnValueOnce({ where }) } as never);
  return { where };
}
/** Next `db.select().from().where().limit()` resolves to `rows` (the single-view load). */
function selectOne(rows: unknown[]) {
  const where = vi.fn().mockReturnValueOnce({ limit: vi.fn().mockResolvedValueOnce(rows) });
  mockDb.select.mockReturnValueOnce({ from: vi.fn().mockReturnValueOnce({ where }) } as never);
  return { where };
}
/** Next `db.select().from().where()` resolves to `rows` (the count: no `.orderBy`, no `.limit`). */
function selectCount(rows: unknown[]) {
  const where = vi.fn().mockResolvedValueOnce(rows);
  mockDb.select.mockReturnValueOnce({ from: vi.fn().mockReturnValueOnce({ where }) } as never);
  return { where };
}

beforeEach(() => vi.clearAllMocks());

describe('listSavedViewsForUser', () => {
  it('returns every view, newest first as the query orders them, with normalised filters — six included (the create race can leave one over the cap; it must stay visible so it can be deleted)', async () => {
    const { where } = selectList([6, 5, 4, 3, 2, 1].map(row));
    const views = await listSavedViewsForUser(USER_ID);
    expect(views.map((v) => v.name)).toEqual(['View 6', 'View 5', 'View 4', 'View 3', 'View 2', 'View 1']);
    expect(views[0].filters).toEqual({ ...EXPLORER_DEFAULTS, q: 'kw6' });
    expect(views[0].createdAt).toBe('2026-10-06T10:00:00.000Z');
    expect(new PgDialect().sqlToQuery(where.mock.calls[0][0])).toMatchObject({ sql: '"saved_views"."user_id" = $1', params: [USER_ID] });
  });
});

describe('loadSavedViewForUser', () => {
  it('returns null for a malformed id without querying', async () => {
    await expect(loadSavedViewForUser(USER_ID, 'nope')).resolves.toBeNull();
    expect(mockDb.select).not.toHaveBeenCalled();
  });
  it('is owner-scoped and returns the normalised view', async () => {
    const r = row(1);
    const { where } = selectOne([r]);
    await expect(loadSavedViewForUser(USER_ID, r.id)).resolves.toMatchObject({ id: r.id, name: 'View 1', filters: { ...EXPLORER_DEFAULTS, q: 'kw1' } });
    expect(new PgDialect().sqlToQuery(where.mock.calls[0][0])).toMatchObject({ sql: '("saved_views"."id" = $1 and "saved_views"."user_id" = $2)', params: [r.id, USER_ID] });
  });
  it('returns null when no row matches', async () => {
    selectOne([]);
    await expect(loadSavedViewForUser(USER_ID, row(1).id)).resolves.toBeNull();
  });
});

describe('countSavedViewsForUser', () => {
  it('is one owner-scoped COUNT, not a listing (the workspace write results carry it)', async () => {
    const { where } = selectCount([{ n: 4 }]);
    await expect(countSavedViewsForUser(USER_ID)).resolves.toBe(4);
    const dialect = new PgDialect();
    expect(dialect.sqlToQuery(mockDb.select.mock.calls[0][0].n)).toMatchObject({ sql: 'COUNT(*)::int' });
    expect(dialect.sqlToQuery(where.mock.calls[0][0])).toMatchObject({ sql: '"saved_views"."user_id" = $1', params: [USER_ID] });
  });
});
