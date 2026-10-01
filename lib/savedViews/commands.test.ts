import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DrizzleQueryError } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const { mockDb } = vi.hoisted(() => ({ mockDb: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() } }));
vi.mock('@/lib/env', () => ({ env: {} }));
vi.mock('@/db/client', () => ({ db: mockDb }));

import { createSavedView, deleteSavedView, updateSavedView } from './commands';
import { normalizeFilters, normalizeFiltersBlob } from './validation';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const VIEW_ID = '11111111-1111-4111-8111-111111111111';
const row = { id: VIEW_ID, userId: USER_ID, name: 'Lamps', filters: normalizeFilters({ q: 'lamp' }), createdAt: new Date('2026-09-30T10:00:00Z'), updatedAt: new Date('2026-09-30T10:00:00Z') };
const view = { id: VIEW_ID, name: 'Lamps', filters: row.filters, createdAt: '2026-09-30T10:00:00.000Z', updatedAt: '2026-09-30T10:00:00.000Z' };
// The shape production throws: drizzle-orm wraps every driver error in a DrizzleQueryError and keeps the Postgres error on `cause`.
const uniqueViolation = () => new DrizzleQueryError('insert into "saved_views" ("user_id", "name", "filters") values ($1, $2, $3) returning *', [USER_ID, 'Lamps', '{}'], Object.assign(new Error('duplicate key value violates unique constraint "saved_views_user_name_uniq"'), { code: '23505' }));

/** The SQL + params a command handed to `.where(...)`, rendered the way drizzle sends it (pins the owner scoping). */
const rendered = (where: ReturnType<typeof vi.fn>) => new PgDialect().sqlToQuery(where.mock.calls[0][0]);
const OWNED_BY_ID = { sql: '("saved_views"."id" = $1 and "saved_views"."user_id" = $2)', params: [VIEW_ID, USER_ID] };

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

describe('createSavedView', () => {
  it('validates the name, normalises the filters and returns the view', async () => {
    const { where } = selectWhere([{ n: 0 }]);
    const { values } = insertReturning([row]);
    await expect(createSavedView(USER_ID, { name: ' Lamps ', filters: { q: 'lamp' } })).resolves.toEqual({ ok: true, view });
    expect(values).toHaveBeenCalledWith({ userId: USER_ID, name: 'Lamps', filters: normalizeFilters({ q: 'lamp' }) });
    // The cap counts the caller's own views, nobody else's.
    expect(rendered(where)).toMatchObject({ sql: '"saved_views"."user_id" = $1', params: [USER_ID] });
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
    insertReturning(new DrizzleQueryError('q', [], Object.assign(new Error('relation does not exist'), { code: '42P01' })));
    await expect(createSavedView(USER_ID, { name: 'Lamps', filters: {} })).rejects.toBeInstanceOf(DrizzleQueryError);
  });
});

describe('updateSavedView', () => {
  it('renames, sets updatedAt and scopes the update to the owner', async () => {
    const { set, where } = updateReturning([row]);
    await expect(updateSavedView(USER_ID, VIEW_ID, { name: 'Lamps' })).resolves.toEqual({ ok: true, view });
    expect(set.mock.calls[0][0]).toMatchObject({ name: 'Lamps', updatedAt: expect.any(Date) });
    expect(set.mock.calls[0][0].filters).toBeUndefined();
    // Owner-scoped: the id AND the caller's user id, so a foreign id updates nothing.
    expect(rendered(where)).toMatchObject(OWNED_BY_ID);
  });
  it('re-filters without touching the name', async () => {
    const { set } = updateReturning([row]);
    await expect(updateSavedView(USER_ID, VIEW_ID, { filters: { q: 'floor lamp' } })).resolves.toMatchObject({ ok: true });
    expect(set).toHaveBeenCalledWith({ filters: normalizeFilters({ q: 'floor lamp' }), updatedAt: expect.any(Date) });
    expect(set.mock.calls[0][0]).not.toHaveProperty('name');
  });
  it('normalises a legacy stored blob on the way out', async () => {
    updateReturning([{ ...row, filters: { q: 'lamp' } }]);
    const result = await updateSavedView(USER_ID, VIEW_ID, { name: 'Lamps' });
    if (!result.ok) throw new Error(`expected ok, got ${result.code}`);
    expect(result.view.filters).toEqual(normalizeFiltersBlob({ q: 'lamp' }));
    expect(result.view.filters).toMatchObject({ q: 'lamp', window: '1w', sort: 'rank', page: 1, perPage: 100 });
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
    const { where } = deleteReturning([{ id: VIEW_ID, name: 'Lamps' }]);
    await expect(deleteSavedView(USER_ID, VIEW_ID)).resolves.toEqual({ ok: true, deleted: { id: VIEW_ID, name: 'Lamps' } });
    // Owner-scoped like the update: the id AND the caller's user id.
    expect(rendered(where)).toMatchObject(OWNED_BY_ID);
  });
  it('is invalid_id or not_found otherwise', async () => {
    await expect(deleteSavedView(USER_ID, 'nope')).resolves.toEqual({ ok: false, code: 'invalid_id', message: 'invalid view id' });
    deleteReturning([]);
    await expect(deleteSavedView(USER_ID, VIEW_ID)).resolves.toEqual({ ok: false, code: 'not_found', message: 'view not found' });
  });
});
