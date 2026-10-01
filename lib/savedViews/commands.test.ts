import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockDb } = vi.hoisted(() => ({ mockDb: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() } }));
vi.mock('@/lib/env', () => ({ env: {} }));
vi.mock('@/db/client', () => ({ db: mockDb }));

import { createSavedView, deleteSavedView, updateSavedView } from './commands';
import { normalizeFilters } from './validation';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const VIEW_ID = '11111111-1111-4111-8111-111111111111';
const row = { id: VIEW_ID, userId: USER_ID, name: 'Lamps', filters: normalizeFilters({ q: 'lamp' }), createdAt: new Date('2026-09-30T10:00:00Z'), updatedAt: new Date('2026-09-30T10:00:00Z') };
const view = { id: VIEW_ID, name: 'Lamps', filters: row.filters, createdAt: '2026-09-30T10:00:00.000Z', updatedAt: '2026-09-30T10:00:00.000Z' };
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

describe('createSavedView', () => {
  it('validates the name, normalises the filters and returns the view', async () => {
    selectWhere([{ n: 0 }]);
    insertReturning([row]);
    await expect(createSavedView(USER_ID, { name: ' Lamps ', filters: { q: 'lamp' } })).resolves.toEqual({ ok: true, view });
  });
  it('fails closed on a bad name before any query', async () => {
    await expect(createSavedView(USER_ID, { name: 'x'.repeat(81), filters: {} })).resolves.toEqual({ ok: false, code: 'invalid_name', message: 'name cannot exceed 80 characters' });
    expect(mockDb.select).not.toHaveBeenCalled();
  });
  it('refuses at the cap with the app\'s sentence', async () => {
    selectWhere([{ n: 5 }]);
    await expect(createSavedView(USER_ID, { name: 'Sixth', filters: {} })).resolves.toEqual({ ok: false, code: 'cap_reached', message: "You've reached the 5-view limit. Delete a saved view to add a new one." });
    expect(mockDb.insert).not.toHaveBeenCalled();
  });
  it('reports a duplicate name', async () => {
    selectWhere([{ n: 1 }]);
    insertReturning(uniqueViolation());
    await expect(createSavedView(USER_ID, { name: 'Lamps', filters: {} })).resolves.toEqual({ ok: false, code: 'duplicate_name', message: 'You already have a view named "Lamps". Choose a different name or update the existing one.' });
  });
  it('rethrows any other database error', async () => {
    selectWhere([{ n: 1 }]);
    insertReturning(new Error('connect ETIMEDOUT'));
    await expect(createSavedView(USER_ID, { name: 'Lamps', filters: {} })).rejects.toThrow('connect ETIMEDOUT');
  });
});

describe('updateSavedView', () => {
  it('renames, re-filters, or both, and sets updatedAt', async () => {
    updateReturning([row]);
    await expect(updateSavedView(USER_ID, VIEW_ID, { name: 'Lamps' })).resolves.toEqual({ ok: true, view });
    const set = (mockDb.update.mock.results[0].value as { set: ReturnType<typeof vi.fn> }).set;
    expect(set.mock.calls[0][0]).toMatchObject({ name: 'Lamps', updatedAt: expect.any(Date) });
    expect(set.mock.calls[0][0].filters).toBeUndefined();
  });
  it('rejects a malformed id, a bad name and an empty patch without querying', async () => {
    await expect(updateSavedView(USER_ID, 'nope', { name: 'x' })).resolves.toEqual({ ok: false, code: 'invalid_id', message: 'invalid view id' });
    await expect(updateSavedView(USER_ID, VIEW_ID, { name: '' })).resolves.toEqual({ ok: false, code: 'invalid_name', message: 'name cannot be empty' });
    await expect(updateSavedView(USER_ID, VIEW_ID, {})).resolves.toEqual({ ok: false, code: 'nothing_to_update', message: 'nothing to update' });
    expect(mockDb.update).not.toHaveBeenCalled();
  });
  it('is not_found for a foreign or missing id, and duplicate_name on 23505', async () => {
    updateReturning([]);
    await expect(updateSavedView(USER_ID, VIEW_ID, { name: 'x' })).resolves.toEqual({ ok: false, code: 'not_found', message: 'view not found' });
    updateReturning(uniqueViolation());
    await expect(updateSavedView(USER_ID, VIEW_ID, { name: 'Taken' })).resolves.toEqual({ ok: false, code: 'duplicate_name', message: 'You already have a view with that name.' });
  });
});

describe('deleteSavedView', () => {
  it('deletes the caller\'s row and returns what it removed', async () => {
    deleteReturning([{ id: VIEW_ID, name: 'Lamps' }]);
    await expect(deleteSavedView(USER_ID, VIEW_ID)).resolves.toEqual({ ok: true, deleted: { id: VIEW_ID, name: 'Lamps' } });
  });
  it('is invalid_id or not_found otherwise', async () => {
    await expect(deleteSavedView(USER_ID, 'nope')).resolves.toEqual({ ok: false, code: 'invalid_id', message: 'invalid view id' });
    deleteReturning([]);
    await expect(deleteSavedView(USER_ID, VIEW_ID)).resolves.toEqual({ ok: false, code: 'not_found', message: 'view not found' });
  });
});
