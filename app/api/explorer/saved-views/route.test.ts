// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DrizzleQueryError } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const { mockRequireUser, mockDb } = vi.hoisted(() => ({
  mockRequireUser: vi.fn(),
  mockDb: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));
vi.mock('@/lib/env', () => ({ env: {} }));
vi.mock('@clerk/nextjs/server', () => ({ auth: vi.fn(), currentUser: vi.fn() }));
vi.mock('@/db/client', () => ({ db: mockDb }));
vi.mock('@/lib/auth/requireAuthenticatedUser', () => ({ requireAuthenticatedUser: mockRequireUser }));
vi.mock('@/lib/auth/requireAdmin', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/AuthError')>('@/lib/auth/AuthError');
  return { AuthError: actual.AuthError };
});

import { GET, POST } from './route';
import { AuthError } from '@/lib/auth/AuthError';
import { normalizeFilters } from '@/lib/savedViews/validation';

const USER = { id: '00000000-0000-4000-8000-000000000001', email: 'm@example.com', role: 'standard_user' };
const VIEW_ID = '11111111-1111-4111-8111-111111111111';
const row = {
  id: VIEW_ID, userId: USER.id, name: 'Lamps', filters: normalizeFilters({ q: 'lamp' }),
  createdAt: new Date('2026-09-30T10:00:00Z'), updatedAt: new Date('2026-09-30T10:00:00Z'),
};
const dto = { id: VIEW_ID, name: 'Lamps', filters: row.filters, createdAt: '2026-09-30T10:00:00.000Z', updatedAt: '2026-09-30T10:00:00.000Z' };
// What production throws: drizzle-orm wraps the driver error in a DrizzleQueryError and keeps the Postgres error on `cause`.
const uniqueViolation = () => new DrizzleQueryError('insert into "saved_views" ("user_id", "name", "filters") values ($1, $2, $3) returning *', [USER.id, 'Lamps', '{}'], Object.assign(new Error('duplicate key value violates unique constraint "saved_views_user_name_uniq"'), { code: '23505' }));

/** Next `db.select(...).from(...).where(...)` resolves to `rows` (the COUNT query). */
function selectWhere(rows: unknown[]) {
  mockDb.select.mockReturnValueOnce({ from: vi.fn().mockReturnValueOnce({ where: vi.fn().mockResolvedValueOnce(rows) }) } as never);
}
/** Next `db.select().from().where().orderBy()` resolves to `rows` (the list query — never capped); returns the `where` spy. */
function selectList(rows: unknown[]) {
  const where = vi.fn().mockReturnValueOnce({ orderBy: vi.fn().mockResolvedValueOnce(rows) });
  mockDb.select.mockReturnValueOnce({ from: vi.fn().mockReturnValueOnce({ where }) } as never);
  return { where };
}
function insertReturning(result: unknown[] | Error) {
  const returning = result instanceof Error ? vi.fn().mockRejectedValueOnce(result) : vi.fn().mockResolvedValueOnce(result);
  mockDb.insert.mockReturnValueOnce({ values: vi.fn().mockReturnValueOnce({ returning }) } as never);
}

const post = (body: unknown) => POST(new Request('https://keywordquarry.com/api/explorer/saved-views', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));

describe('GET /api/explorer/saved-views', () => {
  beforeEach(() => { vi.clearAllMocks(); mockRequireUser.mockResolvedValue(USER); });
  it('lists the caller\'s views as DTOs', async () => {
    const { where } = selectList([row]);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ views: [dto] });
    // Owner-scoped: only the signed-in member's own rows are listed.
    expect(new PgDialect().sqlToQuery(where.mock.calls[0][0])).toMatchObject({ sql: '"saved_views"."user_id" = $1', params: [USER.id] });
  });
  it('lists all six views when the create race left one over the cap (nothing is hidden from the picker)', async () => {
    selectList([6, 5, 4, 3, 2, 1].map((i) => ({ ...row, id: `${row.id.slice(0, -1)}${i}`, name: `View ${i}` })));
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).views.map((v: { name: string }) => v.name)).toEqual(['View 6', 'View 5', 'View 4', 'View 3', 'View 2', 'View 1']);
  });
  it('is 401 when not signed in', async () => {
    mockRequireUser.mockRejectedValueOnce(new AuthError('UNAUTHENTICATED', 'Not signed in'));
    const res = await GET();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Not signed in' });
  });
});

describe('POST /api/explorer/saved-views', () => {
  beforeEach(() => { vi.clearAllMocks(); mockRequireUser.mockResolvedValue(USER); });
  it('creates a view and returns its DTO', async () => {
    selectWhere([{ n: 2 }]);
    insertReturning([row]);
    const res = await post({ name: ' Lamps ', filters: { q: 'lamp' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ view: dto });
    expect(mockDb.insert).toHaveBeenCalledTimes(1);
  });
  it('rejects a missing name with the validateName message', async () => {
    const res = await post({ filters: {} });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'name must be a string' });
    expect(mockDb.select).not.toHaveBeenCalled();
  });
  it('refuses the sixth view with the cap sentence', async () => {
    selectWhere([{ n: 5 }]);
    const res = await post({ name: 'Sixth', filters: {} });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "You've reached the 5-view limit. Delete a saved view to add a new one." });
    expect(mockDb.insert).not.toHaveBeenCalled();
  });
  it('maps a unique violation to 409 naming the clash', async () => {
    selectWhere([{ n: 1 }]);
    insertReturning(uniqueViolation());
    const res = await post({ name: 'Lamps', filters: {} });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'You already have a view named "Lamps". Choose a different name or update the existing one.' });
  });
  it('is 401 when not signed in', async () => {
    mockRequireUser.mockRejectedValueOnce(new AuthError('UNAUTHENTICATED', 'Not signed in'));
    expect((await post({ name: 'x', filters: {} })).status).toBe(401);
  });
});

describe('POST /api/explorer/saved-views with a null JSON body (hardened in the extraction)', () => {
  beforeEach(() => { vi.clearAllMocks(); mockRequireUser.mockResolvedValue(USER); });
  it('answers 400 instead of throwing', async () => {
    const res = await post(null);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'name must be a string' });
    expect(mockDb.select).not.toHaveBeenCalled();
  });
});
