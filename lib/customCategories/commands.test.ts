import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DrizzleQueryError } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const { mockDb } = vi.hoisted(() => ({ mockDb: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() } }));
vi.mock('@/lib/env', () => ({ env: {} }));
vi.mock('@/db/client', () => ({ db: mockDb }));

import { createCustomCategory, deleteCustomCategory, updateCustomCategory } from './commands';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const CAT_ID = '22222222-2222-4222-8222-222222222222';
const row = { id: CAT_ID, userId: USER_ID, name: 'Lighting', leafPaths: ['Lighting › Lamps'], createdAt: new Date('2026-09-30T10:00:00Z'), updatedAt: new Date('2026-09-30T10:00:00Z') };
const dto = { id: CAT_ID, name: 'Lighting', leafPaths: ['Lighting › Lamps'], createdAt: '2026-09-30T10:00:00.000Z', updatedAt: '2026-09-30T10:00:00.000Z' };
// What production throws: drizzle-orm wraps the driver error in a DrizzleQueryError and keeps the Postgres error on `cause`.
const uniqueViolation = () => new DrizzleQueryError('insert into "custom_categories" ("user_id", "name", "leaf_paths") values ($1, $2, $3) returning *', [USER_ID, 'Lighting', '["x"]'], Object.assign(new Error('duplicate key value violates unique constraint "custom_categories_user_name_uniq"'), { code: '23505' }));

/** The SQL + params a command handed to `.where(...)`, rendered the way drizzle sends it (pins the owner scoping). */
const rendered = (where: ReturnType<typeof vi.fn>) => new PgDialect().sqlToQuery(where.mock.calls[0][0]);
const OWNED_BY_ID = { sql: '("custom_categories"."id" = $1 and "custom_categories"."user_id" = $2)', params: [CAT_ID, USER_ID] };

function selectWhere(rows: unknown[]) {
  const where = vi.fn().mockResolvedValueOnce(rows);
  mockDb.select.mockReturnValueOnce({ from: vi.fn().mockReturnValueOnce({ where }) } as never);
  return { where };
}
function insertReturning(result: unknown[] | Error) {
  const returning = result instanceof Error ? vi.fn().mockRejectedValueOnce(result) : vi.fn().mockResolvedValueOnce(result);
  const values = vi.fn().mockReturnValueOnce({ returning });
  mockDb.insert.mockReturnValueOnce({ values } as never);
  return { values };
}
function updateReturning(result: unknown[] | Error) {
  const returning = result instanceof Error ? vi.fn().mockRejectedValueOnce(result) : vi.fn().mockResolvedValueOnce(result);
  const where = vi.fn().mockReturnValueOnce({ returning });
  const set = vi.fn().mockReturnValueOnce({ where });
  mockDb.update.mockReturnValueOnce({ set } as never);
  return { set, where };
}
function deleteReturning(rows: unknown[]) {
  const where = vi.fn().mockReturnValueOnce({ returning: vi.fn().mockResolvedValueOnce(rows) });
  mockDb.delete.mockReturnValueOnce({ where } as never);
  return { where };
}

beforeEach(() => vi.clearAllMocks());

describe('createCustomCategory', () => {
  it('normalises the leaf list (trim, dedupe) and returns the DTO', async () => {
    const { where } = selectWhere([{ n: 0 }]);
    const { values } = insertReturning([row]);
    await expect(createCustomCategory(USER_ID, { name: 'Lighting', leafPaths: [' Lighting › Lamps ', 'Lighting › Lamps'] })).resolves.toEqual({ ok: true, category: dto });
    expect(values).toHaveBeenCalledWith({ userId: USER_ID, name: 'Lighting', leafPaths: ['Lighting › Lamps'] });
    // The cap counts the caller's own categories, nobody else's.
    expect(rendered(where)).toMatchObject({ sql: '"custom_categories"."user_id" = $1', params: [USER_ID] });
  });
  it('fails closed on a bad name, no leaves, or too many leaves, before any query', async () => {
    await expect(createCustomCategory(USER_ID, { name: 7, leafPaths: ['x'] })).resolves.toEqual({ ok: false, code: 'invalid_name', message: 'name must be a string' });
    await expect(createCustomCategory(USER_ID, { name: 'L', leafPaths: [] })).resolves.toEqual({ ok: false, code: 'no_leaves', message: 'Add at least one leaf category before saving.' });
    await expect(createCustomCategory(USER_ID, { name: 'L', leafPaths: Array.from({ length: 12001 }, (_, i) => `D › ${i}`) })).resolves.toEqual({ ok: false, code: 'too_many_leaves', message: `A category can include at most ${(12000).toLocaleString()} leaves.` });
    expect(mockDb.select).not.toHaveBeenCalled();
  });
  it('refuses at the cap with the app\'s sentence', async () => {
    selectWhere([{ n: 25 }]);
    await expect(createCustomCategory(USER_ID, { name: 'L', leafPaths: ['x'] })).resolves.toEqual({ ok: false, code: 'cap_reached', message: "You've reached the 25-category limit. Delete one to add another." });
    expect(mockDb.insert).not.toHaveBeenCalled();
  });
  it('reports a duplicate name', async () => {
    selectWhere([{ n: 1 }]);
    insertReturning(uniqueViolation());
    await expect(createCustomCategory(USER_ID, { name: 'Lighting', leafPaths: ['x'] })).resolves.toEqual({ ok: false, code: 'duplicate_name', message: 'You already have a category named "Lighting".' });
  });
});

describe('updateCustomCategory', () => {
  it('renames, sets updatedAt and scopes the update to the owner', async () => {
    const { set, where } = updateReturning([row]);
    await expect(updateCustomCategory(USER_ID, CAT_ID, { name: 'Lighting' })).resolves.toEqual({ ok: true, category: dto });
    expect(set.mock.calls[0][0]).toEqual({ name: 'Lighting', updatedAt: expect.any(Date) });
    expect(set.mock.calls[0][0]).not.toHaveProperty('leafPaths');
    // Owner-scoped: the id AND the caller's user id, so a foreign id updates nothing.
    expect(rendered(where)).toMatchObject(OWNED_BY_ID);
  });
  it('replaces the leaf list without touching the name', async () => {
    const { set } = updateReturning([row]);
    await expect(updateCustomCategory(USER_ID, CAT_ID, { leafPaths: ['A › B'] })).resolves.toMatchObject({ ok: true });
    expect(set.mock.calls[0][0]).toEqual({ leafPaths: ['A › B'], updatedAt: expect.any(Date) });
    expect(set.mock.calls[0][0]).not.toHaveProperty('name');
  });
  it('rejects more than 12,000 leaves without querying', async () => {
    const tooMany = Array.from({ length: 12001 }, (_, i) => `D › ${i}`);
    await expect(updateCustomCategory(USER_ID, CAT_ID, { leafPaths: tooMany })).resolves.toEqual({ ok: false, code: 'too_many_leaves', message: `A category can include at most ${(12000).toLocaleString()} leaves.` });
    expect(mockDb.update).not.toHaveBeenCalled();
  });
  it('rejects a malformed id, a bad name, an empty leaf list, and an empty patch without querying', async () => {
    await expect(updateCustomCategory(USER_ID, 'nope', { name: 'x' })).resolves.toEqual({ ok: false, code: 'invalid_id', message: 'invalid category id' });
    await expect(updateCustomCategory(USER_ID, CAT_ID, { name: null })).resolves.toEqual({ ok: false, code: 'invalid_name', message: 'name must be a string' });
    await expect(updateCustomCategory(USER_ID, CAT_ID, { leafPaths: [] })).resolves.toEqual({ ok: false, code: 'no_leaves', message: 'A category needs at least one leaf.' });
    await expect(updateCustomCategory(USER_ID, CAT_ID, {})).resolves.toEqual({ ok: false, code: 'nothing_to_update', message: 'nothing to update' });
    expect(mockDb.update).not.toHaveBeenCalled();
  });
  it('is not_found for a foreign id and duplicate_name on 23505', async () => {
    updateReturning([]);
    await expect(updateCustomCategory(USER_ID, CAT_ID, { name: 'x' })).resolves.toEqual({ ok: false, code: 'not_found', message: 'Not found' });
    updateReturning(uniqueViolation());
    await expect(updateCustomCategory(USER_ID, CAT_ID, { name: 'Taken' })).resolves.toEqual({ ok: false, code: 'duplicate_name', message: 'You already have a category named "Taken".' });
  });
  it('rethrows any other database error', async () => {
    updateReturning(new DrizzleQueryError('q', [], Object.assign(new Error('relation does not exist'), { code: '42P01' })));
    await expect(updateCustomCategory(USER_ID, CAT_ID, { name: 'x' })).rejects.toBeInstanceOf(DrizzleQueryError);
  });
});

describe('deleteCustomCategory', () => {
  it('deletes the caller\'s row and returns id, name and leaf count', async () => {
    const { where } = deleteReturning([{ id: CAT_ID, name: 'Lighting', leafPaths: ['a', 'b'] }]);
    await expect(deleteCustomCategory(USER_ID, CAT_ID)).resolves.toEqual({ ok: true, deleted: { id: CAT_ID, name: 'Lighting', leafCount: 2 } });
    // Owner-scoped like the update: the id AND the caller's user id.
    expect(rendered(where)).toMatchObject(OWNED_BY_ID);
  });
  it('is invalid_id or not_found otherwise', async () => {
    await expect(deleteCustomCategory(USER_ID, 'nope')).resolves.toEqual({ ok: false, code: 'invalid_id', message: 'invalid category id' });
    deleteReturning([]);
    await expect(deleteCustomCategory(USER_ID, CAT_ID)).resolves.toEqual({ ok: false, code: 'not_found', message: 'Not found' });
  });
});
