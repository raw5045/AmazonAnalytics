import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockDb } = vi.hoisted(() => ({ mockDb: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() } }));
vi.mock('@/lib/env', () => ({ env: {} }));
vi.mock('@/db/client', () => ({ db: mockDb }));

import { createCustomCategory, deleteCustomCategory, updateCustomCategory } from './commands';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const CAT_ID = '22222222-2222-4222-8222-222222222222';
const row = { id: CAT_ID, userId: USER_ID, name: 'Lighting', leafPaths: ['Lighting › Lamps'], createdAt: new Date('2026-09-30T10:00:00Z'), updatedAt: new Date('2026-09-30T10:00:00Z') };
const dto = { id: CAT_ID, name: 'Lighting', leafPaths: ['Lighting › Lamps'], createdAt: '2026-09-30T10:00:00.000Z', updatedAt: '2026-09-30T10:00:00.000Z' };
const uniqueViolation = () => Object.assign(new Error('dup'), { code: '23505' });

function selectWhere(rows: unknown[]) {
  mockDb.select.mockReturnValueOnce({ from: vi.fn().mockReturnValueOnce({ where: vi.fn().mockResolvedValueOnce(rows) }) } as never);
}
function insertReturning(result: unknown[] | Error) {
  const returning = result instanceof Error ? vi.fn().mockRejectedValueOnce(result) : vi.fn().mockResolvedValueOnce(result);
  mockDb.insert.mockReturnValueOnce({ values: vi.fn().mockReturnValueOnce({ returning }) } as never);
}
function updateReturning(result: unknown[] | Error) {
  const returning = result instanceof Error ? vi.fn().mockRejectedValueOnce(result) : vi.fn().mockResolvedValueOnce(result);
  mockDb.update.mockReturnValueOnce({ set: vi.fn().mockReturnValueOnce({ where: vi.fn().mockReturnValueOnce({ returning }) }) } as never);
}
function deleteReturning(rows: unknown[]) {
  mockDb.delete.mockReturnValueOnce({ where: vi.fn().mockReturnValueOnce({ returning: vi.fn().mockResolvedValueOnce(rows) }) } as never);
}

beforeEach(() => vi.clearAllMocks());

describe('createCustomCategory', () => {
  it('normalises the leaf list (trim, dedupe) and returns the DTO', async () => {
    selectWhere([{ n: 0 }]);
    insertReturning([row]);
    await expect(createCustomCategory(USER_ID, { name: 'Lighting', leafPaths: [' Lighting › Lamps ', 'Lighting › Lamps'] })).resolves.toEqual({ ok: true, category: dto });
    const values = (mockDb.insert.mock.results[0].value as { values: ReturnType<typeof vi.fn> }).values;
    expect(values.mock.calls[0][0]).toEqual({ userId: USER_ID, name: 'Lighting', leafPaths: ['Lighting › Lamps'] });
  });
  it('fails closed on a bad name, no leaves, or too many leaves, before any query', async () => {
    await expect(createCustomCategory(USER_ID, { name: 7, leafPaths: ['x'] })).resolves.toEqual({ ok: false, code: 'invalid_name', message: 'name must be a string' });
    await expect(createCustomCategory(USER_ID, { name: 'L', leafPaths: [] })).resolves.toEqual({ ok: false, code: 'no_leaves', message: 'Add at least one leaf category before saving.' });
    await expect(createCustomCategory(USER_ID, { name: 'L', leafPaths: Array.from({ length: 12001 }, (_, i) => `D › ${i}`) })).resolves.toEqual({ ok: false, code: 'too_many_leaves', message: `A category can include at most ${(12000).toLocaleString()} leaves.` });
    expect(mockDb.select).not.toHaveBeenCalled();
  });
  it('refuses at the cap and reports a duplicate name', async () => {
    selectWhere([{ n: 25 }]);
    await expect(createCustomCategory(USER_ID, { name: 'L', leafPaths: ['x'] })).resolves.toEqual({ ok: false, code: 'cap_reached', message: "You've reached the 25-category limit. Delete one to add another." });
    selectWhere([{ n: 1 }]);
    insertReturning(uniqueViolation());
    await expect(createCustomCategory(USER_ID, { name: 'Lighting', leafPaths: ['x'] })).resolves.toEqual({ ok: false, code: 'duplicate_name', message: 'You already have a category named "Lighting".' });
  });
});

describe('updateCustomCategory', () => {
  it('updates only the fields given and sets updatedAt', async () => {
    updateReturning([row]);
    await expect(updateCustomCategory(USER_ID, CAT_ID, { name: 'Lighting' })).resolves.toEqual({ ok: true, category: dto });
    const set = (mockDb.update.mock.results[0].value as { set: ReturnType<typeof vi.fn> }).set;
    expect(set.mock.calls[0][0]).toEqual({ name: 'Lighting', updatedAt: expect.any(Date) });
    updateReturning([row]);
    await updateCustomCategory(USER_ID, CAT_ID, { leafPaths: ['A › B'] });
    const set2 = (mockDb.update.mock.results[1].value as { set: ReturnType<typeof vi.fn> }).set;
    expect(set2.mock.calls[0][0]).toEqual({ leafPaths: ['A › B'], updatedAt: expect.any(Date) });
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
});

describe('deleteCustomCategory', () => {
  it('deletes the caller\'s row and returns id, name and leaf count', async () => {
    deleteReturning([{ id: CAT_ID, name: 'Lighting', leafPaths: ['a', 'b'] }]);
    await expect(deleteCustomCategory(USER_ID, CAT_ID)).resolves.toEqual({ ok: true, deleted: { id: CAT_ID, name: 'Lighting', leafCount: 2 } });
  });
  it('is invalid_id or not_found otherwise', async () => {
    await expect(deleteCustomCategory(USER_ID, 'nope')).resolves.toEqual({ ok: false, code: 'invalid_id', message: 'invalid category id' });
    deleteReturning([]);
    await expect(deleteCustomCategory(USER_ID, CAT_ID)).resolves.toEqual({ ok: false, code: 'not_found', message: 'Not found' });
  });
});
