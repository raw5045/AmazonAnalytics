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

const USER = { id: '00000000-0000-4000-8000-000000000001', email: 'm@example.com', role: 'standard_user' };
const CAT_ID = '22222222-2222-4222-8222-222222222222';
const row = { id: CAT_ID, userId: USER.id, name: 'Lighting', leafPaths: ['Lighting › Lamps'], createdAt: new Date('2026-09-30T10:00:00Z'), updatedAt: new Date('2026-09-30T11:00:00Z') };
const dto = { id: CAT_ID, name: 'Lighting', leafPaths: ['Lighting › Lamps'], createdAt: '2026-09-30T10:00:00.000Z', updatedAt: '2026-09-30T11:00:00.000Z' };
// What production throws: drizzle-orm wraps the driver error in a DrizzleQueryError and keeps the Postgres error on `cause`.
const uniqueViolation = () => new DrizzleQueryError('update "custom_categories" set "name" = $1, "leaf_paths" = $2, "updated_at" = $3 where ("custom_categories"."id" = $4 and "custom_categories"."user_id" = $5) returning *', ['Taken', '["x"]', '2026-09-30T11:00:00.000Z', CAT_ID, USER.id], Object.assign(new Error('duplicate key value violates unique constraint "custom_categories_user_name_uniq"'), { code: '23505' }));

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
/** Every error answer is `{ error }` with a status; assert both, never just one. */
async function expectError(res: Response, status: number, error: string) {
  expect(res.status).toBe(status);
  expect(await res.json()).toEqual({ error });
}

describe('PATCH /api/category-builder/custom/[id]', () => {
  beforeEach(() => { vi.clearAllMocks(); mockRequireUser.mockResolvedValue(USER); });
  it('replaces name and leaves and returns the DTO', async () => {
    updateReturning([row]);
    const res = await patch(CAT_ID, { name: 'Lighting', leafPaths: ['Lighting › Lamps'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ category: dto });
  });
  it('requires a valid id, a name and at least one leaf', async () => {
    await expectError(await patch('nope', { name: 'L', leafPaths: ['x'] }), 400, 'invalid category id');
    await expectError(await patch(CAT_ID, { leafPaths: ['x'] }), 400, 'name must be a string');
    await expectError(await patch(CAT_ID, { name: 'L' }), 400, 'A category needs at least one leaf.');
    expect(mockDb.update).not.toHaveBeenCalled();
  });
  it('rejects more than 12,000 leaves', async () => {
    const tooMany = Array.from({ length: 12001 }, (_, i) => `Dept › Leaf ${i}`);
    await expectError(await patch(CAT_ID, { name: 'L', leafPaths: tooMany }), 400, `A category can include at most ${(12000).toLocaleString()} leaves.`);
    expect(mockDb.update).not.toHaveBeenCalled();
  });
  it('is 404 for a foreign id and 409 on a duplicate name', async () => {
    updateReturning([]);
    await expectError(await patch(CAT_ID, { name: 'L', leafPaths: ['x'] }), 404, 'Not found');
    updateReturning(uniqueViolation());
    await expectError(await patch(CAT_ID, { name: 'Taken', leafPaths: ['x'] }), 409, 'You already have a category named "Taken".');
  });
  it('is 401 when not signed in', async () => {
    mockRequireUser.mockRejectedValueOnce(new AuthError('UNAUTHENTICATED', 'Not signed in'));
    await expectError(await patch(CAT_ID, { name: 'L', leafPaths: ['x'] }), 401, 'Not signed in');
    expect(mockDb.update).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/category-builder/custom/[id]', () => {
  beforeEach(() => { vi.clearAllMocks(); mockRequireUser.mockResolvedValue(USER); });
  it('deletes and answers ok', async () => {
    deleteReturning([{ id: CAT_ID, name: 'Lighting', leafPaths: ['x'] }]);
    const res = await del(CAT_ID);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
  it('is 400 for a malformed id and 404 when nothing matched', async () => {
    await expectError(await del('nope'), 400, 'invalid category id');
    deleteReturning([]);
    await expectError(await del(CAT_ID), 404, 'Not found');
  });
  it('is 401 when not signed in', async () => {
    mockRequireUser.mockRejectedValueOnce(new AuthError('UNAUTHENTICATED', 'Not signed in'));
    await expectError(await del(CAT_ID), 401, 'Not signed in');
    expect(mockDb.delete).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/category-builder/custom/[id] with a null JSON body (hardened in the extraction)', () => {
  beforeEach(() => { vi.clearAllMocks(); mockRequireUser.mockResolvedValue(USER); });
  it('still answers 400 for a bad id, and 400 for a valid id', async () => {
    await expectError(await patch('nope', null), 400, 'invalid category id');
    await expectError(await patch(CAT_ID, null), 400, 'name must be a string');
    expect(mockDb.update).not.toHaveBeenCalled();
  });
});
