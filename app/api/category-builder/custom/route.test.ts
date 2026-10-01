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

import { GET, POST } from './route';
import { AuthError } from '@/lib/auth/AuthError';

const USER = { id: '00000000-0000-4000-8000-000000000001', email: 'm@example.com', role: 'standard_user' };
const CAT_ID = '22222222-2222-4222-8222-222222222222';
const row = { id: CAT_ID, userId: USER.id, name: 'Lighting', leafPaths: ['Lighting › Lamps'], createdAt: new Date('2026-09-30T10:00:00Z'), updatedAt: new Date('2026-09-30T10:00:00Z') };
const dto = { id: CAT_ID, name: 'Lighting', leafPaths: ['Lighting › Lamps'], createdAt: '2026-09-30T10:00:00.000Z', updatedAt: '2026-09-30T10:00:00.000Z' };
// What production throws: drizzle-orm wraps the driver error in a DrizzleQueryError and keeps the Postgres error on `cause`.
const uniqueViolation = () => new DrizzleQueryError('insert into "custom_categories" ("user_id", "name", "leaf_paths") values ($1, $2, $3) returning *', [USER.id, 'Lighting', '["x"]'], Object.assign(new Error('duplicate key value violates unique constraint "custom_categories_user_name_uniq"'), { code: '23505' }));

function selectWhere(rows: unknown[]) {
  mockDb.select.mockReturnValueOnce({ from: vi.fn().mockReturnValueOnce({ where: vi.fn().mockResolvedValueOnce(rows) }) } as never);
}
function selectList(rows: unknown[]) {
  mockDb.select.mockReturnValueOnce({ from: () => ({ where: () => ({ orderBy: vi.fn().mockResolvedValueOnce(rows) }) }) } as never);
}
function insertReturning(result: unknown[] | Error) {
  const returning = result instanceof Error ? vi.fn().mockRejectedValueOnce(result) : vi.fn().mockResolvedValueOnce(result);
  mockDb.insert.mockReturnValueOnce({ values: vi.fn().mockReturnValueOnce({ returning }) } as never);
}
const post = (body: unknown) => POST(new Request('https://keywordquarry.com/api/category-builder/custom', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
/** Every error answer is `{ error }` with a status; assert both, never just one. */
async function expectError(res: Response, status: number, error: string) {
  expect(res.status).toBe(status);
  expect(await res.json()).toEqual({ error });
}

describe('GET /api/category-builder/custom', () => {
  beforeEach(() => { vi.clearAllMocks(); mockRequireUser.mockResolvedValue(USER); });
  it('lists the caller\'s categories as DTOs', async () => {
    selectList([row]);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ categories: [dto] });
  });
  it('is 401 when not signed in', async () => {
    mockRequireUser.mockRejectedValueOnce(new AuthError('UNAUTHENTICATED', 'Not signed in'));
    await expectError(await GET(), 401, 'Not signed in');
  });
});

describe('POST /api/category-builder/custom', () => {
  beforeEach(() => { vi.clearAllMocks(); mockRequireUser.mockResolvedValue(USER); });
  it('creates and returns the DTO', async () => {
    selectWhere([{ n: 3 }]);
    insertReturning([row]);
    const res = await post({ name: 'Lighting', leafPaths: ['Lighting › Lamps', 'Lighting › Lamps'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ category: dto });
  });
  it('rejects a missing name, an empty leaf list, and too many leaves', async () => {
    await expectError(await post({ leafPaths: ['x'] }), 400, 'name must be a string');
    await expectError(await post({ name: 'L', leafPaths: [] }), 400, 'Add at least one leaf category before saving.');
    const tooMany = Array.from({ length: 12001 }, (_, i) => `Dept › Leaf ${i}`);
    await expectError(await post({ name: 'L', leafPaths: tooMany }), 400, `A category can include at most ${(12000).toLocaleString()} leaves.`);
    expect(mockDb.select).not.toHaveBeenCalled();
  });
  it('refuses the 26th category with the cap sentence', async () => {
    selectWhere([{ n: 25 }]);
    await expectError(await post({ name: 'L', leafPaths: ['x'] }), 400, "You've reached the 25-category limit. Delete one to add another.");
  });
  it('maps a unique violation to 409 naming the clash', async () => {
    selectWhere([{ n: 1 }]);
    insertReturning(uniqueViolation());
    await expectError(await post({ name: 'Lighting', leafPaths: ['x'] }), 409, 'You already have a category named "Lighting".');
  });
});

describe('POST /api/category-builder/custom with a null JSON body (hardened in the extraction)', () => {
  beforeEach(() => { vi.clearAllMocks(); mockRequireUser.mockResolvedValue(USER); });
  it('answers 400 instead of throwing', async () => {
    await expectError(await post(null), 400, 'name must be a string');
  });
});
