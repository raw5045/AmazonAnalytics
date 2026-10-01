// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DrizzleQueryError } from 'drizzle-orm';

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

import { PATCH, DELETE } from './route';
import { AuthError } from '@/lib/auth/AuthError';
import { normalizeFilters } from '@/lib/savedViews/validation';

const USER = { id: '00000000-0000-4000-8000-000000000001', email: 'm@example.com', role: 'standard_user' };
const VIEW_ID = '11111111-1111-4111-8111-111111111111';
const row = {
  id: VIEW_ID, userId: USER.id, name: 'Lamps', filters: normalizeFilters({ q: 'lamp' }),
  createdAt: new Date('2026-09-30T10:00:00Z'), updatedAt: new Date('2026-09-30T11:00:00Z'),
};
const dto = { id: VIEW_ID, name: 'Lamps', filters: row.filters, createdAt: '2026-09-30T10:00:00.000Z', updatedAt: '2026-09-30T11:00:00.000Z' };
// What production throws: drizzle-orm wraps the driver error in a DrizzleQueryError and keeps the Postgres error on `cause`.
const uniqueViolation = () => new DrizzleQueryError('update "saved_views" set "name" = $1, "updated_at" = $2 where ("saved_views"."id" = $3 and "saved_views"."user_id" = $4) returning *', ['Taken', '2026-09-30T11:00:00.000Z', VIEW_ID, USER.id], Object.assign(new Error('duplicate key value violates unique constraint "saved_views_user_name_uniq"'), { code: '23505' }));

function updateReturning(result: unknown[] | Error) {
  const returning = result instanceof Error ? vi.fn().mockRejectedValueOnce(result) : vi.fn().mockResolvedValueOnce(result);
  mockDb.update.mockReturnValueOnce({ set: vi.fn().mockReturnValueOnce({ where: vi.fn().mockReturnValueOnce({ returning }) }) } as never);
}
function deleteReturning(rows: unknown[]) {
  mockDb.delete.mockReturnValueOnce({ where: vi.fn().mockReturnValueOnce({ returning: vi.fn().mockResolvedValueOnce(rows) }) } as never);
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const patch = (id: string, body: unknown) =>
  PATCH(new Request(`https://keywordquarry.com/api/explorer/saved-views/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), params(id));
const del = (id: string) => DELETE(new Request(`https://keywordquarry.com/api/explorer/saved-views/${id}`, { method: 'DELETE' }), params(id));

describe('PATCH /api/explorer/saved-views/[id]', () => {
  beforeEach(() => { vi.clearAllMocks(); mockRequireUser.mockResolvedValue(USER); });
  it('renames and returns the DTO', async () => {
    updateReturning([row]);
    const res = await patch(VIEW_ID, { name: 'Lamps' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ view: dto });
  });
  it('rejects a malformed id before any query', async () => {
    const res = await patch('nope', { name: 'x' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid view id' });
    expect(mockDb.update).not.toHaveBeenCalled();
  });
  it('rejects a bad name and an empty patch', async () => {
    const badName = await patch(VIEW_ID, { name: '' });
    expect(badName.status).toBe(400);
    expect(await badName.json()).toEqual({ error: 'name cannot be empty' });
    const empty = await patch(VIEW_ID, {});
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ error: 'nothing to update' });
  });
  it('is 404 for a view that is not the caller\'s', async () => {
    updateReturning([]);
    const res = await patch(VIEW_ID, { name: 'x' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'view not found' });
  });
  it('maps a unique violation to 409', async () => {
    updateReturning(uniqueViolation());
    const res = await patch(VIEW_ID, { name: 'Taken' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'You already have a view with that name.' });
  });
  it('is 401 when not signed in', async () => {
    mockRequireUser.mockRejectedValueOnce(new AuthError('UNAUTHENTICATED', 'Not signed in'));
    const res = await patch(VIEW_ID, { name: 'x' });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Not signed in' });
  });
});

describe('DELETE /api/explorer/saved-views/[id]', () => {
  beforeEach(() => { vi.clearAllMocks(); mockRequireUser.mockResolvedValue(USER); });
  it('deletes and answers ok', async () => {
    deleteReturning([{ id: VIEW_ID, name: 'Lamps' }]);
    const res = await del(VIEW_ID);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
  it('is 400 for a malformed id and 404 when nothing matched', async () => {
    const badId = await del('nope');
    expect(badId.status).toBe(400);
    expect(await badId.json()).toEqual({ error: 'invalid view id' });
    deleteReturning([]);
    const res = await del(VIEW_ID);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'view not found' });
  });
  it('is 401 when not signed in', async () => {
    mockRequireUser.mockRejectedValueOnce(new AuthError('UNAUTHENTICATED', 'Not signed in'));
    const res = await del(VIEW_ID);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Not signed in' });
  });
});

describe('PATCH /api/explorer/saved-views/[id] with a null JSON body (hardened in the extraction)', () => {
  beforeEach(() => { vi.clearAllMocks(); mockRequireUser.mockResolvedValue(USER); });
  it('still answers 400 for a bad id, and 400 "nothing to update" for a valid id', async () => {
    const badId = await patch('nope', null);
    expect(badId.status).toBe(400);
    expect(await badId.json()).toEqual({ error: 'invalid view id' });
    const validId = await patch(VIEW_ID, null);
    expect(validId.status).toBe(400);
    expect(await validId.json()).toEqual({ error: 'nothing to update' });
    expect(mockDb.update).not.toHaveBeenCalled();
  });
});
