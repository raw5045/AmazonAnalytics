// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest';

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

const USER = { id: '00000000-0000-4000-8000-000000000001', email: 'm@example.com', role: 'standard_user' };
const CAT_ID = '22222222-2222-4222-8222-222222222222';
const row = { id: CAT_ID, userId: USER.id, name: 'Lighting', leafPaths: ['Lighting › Lamps'], createdAt: new Date('2026-09-30T10:00:00Z'), updatedAt: new Date('2026-09-30T11:00:00Z') };
const dto = { id: CAT_ID, name: 'Lighting', leafPaths: ['Lighting › Lamps'], createdAt: '2026-09-30T10:00:00.000Z', updatedAt: '2026-09-30T11:00:00.000Z' };
const uniqueViolation = () => Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });

function updateReturning(result: unknown[] | Error) {
  const returning = result instanceof Error ? vi.fn().mockRejectedValueOnce(result) : vi.fn().mockResolvedValueOnce(result);
  mockDb.update.mockReturnValueOnce({ set: vi.fn().mockReturnValueOnce({ where: vi.fn().mockReturnValueOnce({ returning }) }) } as never);
}
function deleteReturning(rows: unknown[]) {
  mockDb.delete.mockReturnValueOnce({ where: vi.fn().mockReturnValueOnce({ returning: vi.fn().mockResolvedValueOnce(rows) }) } as never);
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const patch = (id: string, body: unknown) =>
  PATCH(new Request(`https://keywordquarry.com/api/category-builder/custom/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), params(id));
const del = (id: string) => DELETE(new Request(`https://keywordquarry.com/api/category-builder/custom/${id}`, { method: 'DELETE' }), params(id));

describe('PATCH /api/category-builder/custom/[id]', () => {
  beforeEach(() => { vi.clearAllMocks(); mockRequireUser.mockResolvedValue(USER); });
  it('replaces name and leaves and returns the DTO', async () => {
    updateReturning([row]);
    const res = await patch(CAT_ID, { name: 'Lighting', leafPaths: ['Lighting › Lamps'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ category: dto });
  });
  it('requires a valid id, a name and at least one leaf', async () => {
    expect(await (await patch('nope', { name: 'L', leafPaths: ['x'] })).json()).toEqual({ error: 'invalid category id' });
    expect(await (await patch(CAT_ID, { leafPaths: ['x'] })).json()).toEqual({ error: 'name must be a string' });
    expect(await (await patch(CAT_ID, { name: 'L' })).json()).toEqual({ error: 'A category needs at least one leaf.' });
    expect(mockDb.update).not.toHaveBeenCalled();
  });
  it('is 404 for a foreign id and 409 on a duplicate name', async () => {
    updateReturning([]);
    const missing = await patch(CAT_ID, { name: 'L', leafPaths: ['x'] });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'Not found' });
    updateReturning(uniqueViolation());
    const dup = await patch(CAT_ID, { name: 'Taken', leafPaths: ['x'] });
    expect(dup.status).toBe(409);
    expect(await dup.json()).toEqual({ error: 'You already have a category named "Taken".' });
  });
});

describe('DELETE /api/category-builder/custom/[id]', () => {
  beforeEach(() => { vi.clearAllMocks(); mockRequireUser.mockResolvedValue(USER); });
  it('deletes and answers ok; 400 and 404 otherwise', async () => {
    deleteReturning([{ id: CAT_ID, name: 'Lighting', leafPaths: ['x'] }]);
    expect(await (await del(CAT_ID)).json()).toEqual({ ok: true });
    expect((await del('nope')).status).toBe(400);
    deleteReturning([]);
    const res = await del(CAT_ID);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });
});

describe('PATCH /api/category-builder/custom/[id] with a null JSON body (hardened in the extraction)', () => {
  beforeEach(() => { vi.clearAllMocks(); mockRequireUser.mockResolvedValue(USER); });
  it('still answers 400 for a bad id, and 400 for a valid id', async () => {
    expect(await (await patch('nope', null)).json()).toEqual({ error: 'invalid category id' });
    expect(await (await patch(CAT_ID, null)).json()).toEqual({ error: 'name must be a string' });
    expect(mockDb.update).not.toHaveBeenCalled();
  });
});
