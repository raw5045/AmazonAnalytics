// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
vi.mock('@/lib/env', () => ({ env: { DATABASE_URL: 'postgres://test', APP_PUBLIC_URL: 'https://keywordquarry.com' } }));
vi.mock('@/db/client', () => ({ db: {} }));

import { DrizzleQueryError } from 'drizzle-orm';
import { createWorkspaceService, type WorkspaceServiceDeps } from './service';
import { buildCategoryCatalog } from '@/lib/research/categories';
import { DEFAULT_LIMITS } from '@/lib/research/limits';
import type { ResearchActor } from '@/lib/research/service';
import { normalizeFilters } from '@/lib/savedViews/validation';
import { EXPLORER_DEFAULTS } from '@/lib/explorer/parseFilters';

const actor: ResearchActor = { localUserId: 'u1', clerkUserId: 'user_1', clientId: 'client_claude', channel: 'mcp' };
const VIEW_ID = '11111111-1111-4111-8111-111111111111';
const CAT_ID = '22222222-2222-4222-8222-222222222222';
const CUSTOM_ID = '33333333-3333-4333-8333-333333333333';
const KW = '44444444-4444-4444-8444-444444444444';
const catalog = buildCategoryCatalog({ snapshotVersion: 'snap', datasetWeek: '2026-09-26' }, [
  { categoryPath: 'Lighting › Lamps', allCount: 10 },
  { categoryPath: 'Lighting › Ceiling Lights', allCount: 5 },
]);
const view = { id: VIEW_ID, name: 'Lamps', filters: normalizeFilters({ q: 'lamp' }), createdAt: '2026-09-30T10:00:00.000Z', updatedAt: '2026-09-30T10:00:00.000Z' };
const category = { id: CAT_ID, name: 'Lighting', leafPaths: ['Lighting › Lamps', 'Old › Leaf'], createdAt: '2026-09-30T10:00:00.000Z', updatedAt: '2026-09-30T10:00:00.000Z' };

function makeDeps(over: Partial<WorkspaceServiceDeps> = {}): WorkspaceServiceDeps {
  return {
    limits: { ...DEFAULT_LIMITS },
    appUrl: 'https://keywordquarry.com',
    now: () => new Date('2026-09-30T12:00:00Z'),
    reserve: vi.fn(async () => ({ requests: 1, rows: 0 })),
    record: vi.fn(),
    countWritesToday: vi.fn(async () => 3),
    bumpWrite: vi.fn(),
    categories: { loadCatalog: async () => catalog, loadCustomRows: async () => [{ id: CUSTOM_ID, leafPaths: ['Lighting › Lamps'] }], listCustom: async () => [] },
    savedViews: {
      list: vi.fn(async () => [view]),
      create: vi.fn(async () => ({ ok: true as const, view })),
      update: vi.fn(async () => ({ ok: true as const, view })),
      delete: vi.fn(async () => ({ ok: true as const, deleted: { id: VIEW_ID, name: 'Lamps' } })),
    },
    customCategories: {
      list: vi.fn(async () => [category]),
      load: vi.fn(async () => category),
      create: vi.fn(async () => ({ ok: true as const, category })),
      update: vi.fn(async () => ({ ok: true as const, category })),
      delete: vi.fn(async () => ({ ok: true as const, deleted: { id: CAT_ID, name: 'Lighting', leafCount: 2 } })),
    },
    watchlist: {
      list: vi.fn(async () => [{ keywordId: KW, keyword: 'desk lamp', addedAt: '2026-09-30T09:00:00.000Z' }]),
      count: vi.fn(async () => 7),
      add: vi.fn(async () => ({ added: 1, alreadyWatching: 0, unmatched: [], skippedAtCap: 0 })),
      remove: vi.fn(async () => ({ removed: 1, notWatching: 0, unmatched: [] })),
    },
    ...over,
  };
}

let log: MockInstance<typeof console.log>;
beforeEach(() => { log = vi.spyOn(console, 'log').mockImplementation(() => {}); });
afterEach(() => log.mockRestore());
const lines = () => log.mock.calls.filter((c) => c[0] === '[workspace]').map((c) => JSON.parse(String(c[1])) as Record<string, unknown>);

describe('list tools', () => {
  it('reserve → list → record, never the write counter; summaries carry links and compact filters', async () => {
    const deps = makeDeps();
    const svc = createWorkspaceService(deps);
    const res = await svc.listSavedViews(actor, {});
    expect(deps.reserve).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', channel: 'mcp', rows: 0 }));
    expect(res).toEqual({ views: [{ id: VIEW_ID, name: 'Lamps', explorerUrl: `https://keywordquarry.com/explorer?view=${VIEW_ID}`, filters: { q: 'lamp' }, createdAt: view.createdAt, updatedAt: view.updatedAt }], count: 1, limit: 5 });
    expect(deps.record).toHaveBeenCalledWith('u1', 0, 'mcp');
    expect(deps.countWritesToday).not.toHaveBeenCalled();
    expect(deps.bumpWrite).not.toHaveBeenCalled();
    const cats = await svc.listCustomCategories(actor, {});
    expect(cats).toEqual({ categories: [{ id: CAT_ID, name: 'Lighting', leafCount: 2, previewPaths: ['Lighting › Lamps', 'Old › Leaf'], previewComplete: true, explorerUrl: `https://keywordquarry.com/explorer?custom=${CAT_ID}`, createdAt: category.createdAt, updatedAt: category.updatedAt }], count: 1, limit: 25 });
    const wl = await svc.listWatchlist(actor, {});
    expect(wl).toEqual({ items: [{ searchTermId: KW, keyword: 'desk lamp', keywordUrl: `https://keywordquarry.com/explorer/keyword/${KW}`, addedAt: '2026-09-30T09:00:00.000Z' }], count: 1, limit: 100 });
    expect(lines().map((l) => l.outcome)).toEqual(['ok', 'ok', 'ok']);
  });
  it('rejects an unexpected key before reserving', async () => {
    const deps = makeDeps();
    await expect(createWorkspaceService(deps).listSavedViews(actor, { page: 2 })).rejects.toMatchObject({ code: 'INVALID_FILTERS' });
    expect(deps.reserve).not.toHaveBeenCalled();
  });
});

describe('create_saved_view', () => {
  const search = {
    schemaVersion: 1, comparisonWindow: '1w',
    filters: { text: { value: 'lamp' }, categories: { selections: [{ kind: 'taxonomy', path: 'Lighting', includeDescendants: true }, { kind: 'custom', id: CUSTOM_ID }] } },
  };
  it('validates → reserves → checks the daily cap → converts through the search\'s own validation → saves → records and bumps', async () => {
    const deps = makeDeps();
    const res = await createWorkspaceService(deps).createSavedView(actor, { name: 'Lamps', search });
    expect(deps.reserve).toHaveBeenCalledTimes(1);
    expect(deps.countWritesToday).toHaveBeenCalledWith('u1');
    const [uid, input] = (deps.savedViews.create as ReturnType<typeof vi.fn>).mock.calls[0] as [string, { name: string; filters: Record<string, unknown> }];
    expect(uid).toBe('u1');
    expect(input.name).toBe('Lamps');
    // Taxonomy selections expand to their leaves; the custom selection passes to the Explorer by id.
    expect(input.filters).toMatchObject({ ...EXPLORER_DEFAULTS, window: '1w', q: 'lamp', leafPaths: ['Lighting › Ceiling Lights', 'Lighting › Lamps'], customCategoryIds: [CUSTOM_ID], category: null });
    expect(res).toEqual({ view: expect.objectContaining({ id: VIEW_ID, explorerUrl: `https://keywordquarry.com/explorer?view=${VIEW_ID}` }), notes: [] });
    expect(deps.record).toHaveBeenCalledWith('u1', 0, 'mcp');
    expect(deps.bumpWrite).toHaveBeenCalledWith('u1');
    expect(lines()[0]).toMatchObject({ tool: 'create_saved_view', outcome: 'ok', userId: 'u1' });
    expect(JSON.stringify(lines())).not.toContain('Lamps');
  });
  it('fills schemaVersion when the AI omits it, and refuses a cursor', async () => {
    const deps = makeDeps();
    const svc = createWorkspaceService(deps);
    await expect(svc.createSavedView(actor, { name: 'L', search: { filters: { text: { value: 'lamp' } } } })).resolves.toBeTruthy();
    await expect(svc.createSavedView(actor, { name: 'L', search: { cursor: 'c'.repeat(20) } })).rejects.toMatchObject({ code: 'INVALID_FILTERS' });
  });
  it('an unknown category path fails like search does, before any save', async () => {
    const deps = makeDeps();
    await expect(createWorkspaceService(deps).createSavedView(actor, { name: 'L', search: { filters: { categories: { leafPaths: ['Nope › Nothing'] } } } })).rejects.toMatchObject({ code: 'CATEGORY_NOT_AVAILABLE' });
    expect(deps.savedViews.create).not.toHaveBeenCalled();
    expect(deps.bumpWrite).not.toHaveBeenCalled();
  });
  it('the 201st write of the day is RATE_LIMITED until Eastern midnight and never reaches a command', async () => {
    const deps = makeDeps({ countWritesToday: vi.fn(async () => 200) });
    await expect(createWorkspaceService(deps).createSavedView(actor, { name: 'L', search: {} })).rejects.toMatchObject({
      code: 'RATE_LIMITED', retryable: true, message: 'Daily limit of 200 saves reached. Try again tomorrow.', retryAfterSeconds: 16 * 3600,
    });
    expect(deps.savedViews.create).not.toHaveBeenCalled();
    expect(deps.bumpWrite).not.toHaveBeenCalled();
    expect(lines()[0]).toMatchObject({ outcome: 'refused', code: 'RATE_LIMITED' });
  });
  it('maps command failures to the workspace error codes and does not bump', async () => {
    const dup = makeDeps({ savedViews: { ...makeDeps().savedViews, create: vi.fn(async () => ({ ok: false as const, code: 'duplicate_name' as const, message: 'You already have a view named "Lamps". Choose a different name or update the existing one.' })) } });
    await expect(createWorkspaceService(dup).createSavedView(actor, { name: 'Lamps', search: {} })).rejects.toMatchObject({ code: 'DUPLICATE_NAME', message: expect.stringContaining('already have a view named') });
    expect(dup.bumpWrite).not.toHaveBeenCalled();
    const cap = makeDeps({ savedViews: { ...makeDeps().savedViews, create: vi.fn(async () => ({ ok: false as const, code: 'cap_reached' as const, message: "You've reached the 5-view limit. Delete a saved view to add a new one." })) } });
    await expect(createWorkspaceService(cap).createSavedView(actor, { name: 'Sixth', search: {} })).rejects.toMatchObject({ code: 'LIMIT_REACHED' });
  });
});

describe('update and delete saved view', () => {
  it('a rename passes only the name; a new search replaces the filters wholesale', async () => {
    const deps = makeDeps();
    const svc = createWorkspaceService(deps);
    await svc.updateSavedView(actor, { id: VIEW_ID, name: 'New' });
    expect(deps.savedViews.update).toHaveBeenLastCalledWith('u1', VIEW_ID, { name: 'New', filters: undefined });
    await svc.updateSavedView(actor, { id: VIEW_ID, search: { filters: { text: { value: 'floor lamp' } } } });
    const [, , input] = (deps.savedViews.update as ReturnType<typeof vi.fn>).mock.lastCall as [string, string, { name?: string; filters: Record<string, unknown> }];
    expect(input.name).toBeUndefined();
    expect(input.filters).toMatchObject({ q: 'floor lamp' });
  });
  it('a foreign or missing id is NOT_FOUND with the account-scoped sentence', async () => {
    const deps = makeDeps({ savedViews: { ...makeDeps().savedViews, delete: vi.fn(async () => ({ ok: false as const, code: 'not_found' as const, message: 'view not found' })) } });
    await expect(createWorkspaceService(deps).deleteSavedView(actor, { id: VIEW_ID })).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'No saved view with that id belongs to this account.' });
  });
  it('delete returns what it removed', async () => {
    const deps = makeDeps();
    await expect(createWorkspaceService(deps).deleteSavedView(actor, { id: VIEW_ID })).resolves.toEqual({ deleted: { id: VIEW_ID, name: 'Lamps' } });
    expect(deps.bumpWrite).toHaveBeenCalledWith('u1');
  });
});

describe('custom categories', () => {
  it('create expands selections against the catalog with the 12,000-leaf cap and stores the leaves', async () => {
    const deps = makeDeps();
    const res = await createWorkspaceService(deps).createCustomCategory(actor, { name: 'Lighting', categories: { selections: [{ kind: 'taxonomy', path: 'Lighting', includeDescendants: true }] } });
    expect(deps.customCategories.create).toHaveBeenCalledWith('u1', { name: 'Lighting', leafPaths: ['Lighting › Ceiling Lights', 'Lighting › Lamps'] });
    expect(res).toEqual({ category: expect.objectContaining({ id: CAT_ID, leafCount: 2, previewComplete: true, explorerUrl: `https://keywordquarry.com/explorer?custom=${CAT_ID}` }), notes: [] });
  });
  it('update resolves leafMode add / remove / replace against the stored leaves (remove subtracts explicit paths verbatim), and is NOT_FOUND for a missing category', async () => {
    const deps = makeDeps();
    const svc = createWorkspaceService(deps);
    const ceiling = { selections: [{ kind: 'taxonomy', path: 'Lighting › Ceiling Lights', includeDescendants: false }] };
    await svc.updateCustomCategory(actor, { id: CAT_ID, categories: ceiling, leafMode: 'add' });
    expect(deps.customCategories.update).toHaveBeenLastCalledWith('u1', CAT_ID, { name: undefined, leafPaths: ['Lighting › Lamps', 'Old › Leaf', 'Lighting › Ceiling Lights'] });
    await svc.updateCustomCategory(actor, { id: CAT_ID, categories: { leafPaths: ['Lighting › Lamps'] }, leafMode: 'remove' });
    expect(deps.customCategories.update).toHaveBeenLastCalledWith('u1', CAT_ID, { name: undefined, leafPaths: ['Old › Leaf'] });
    // A stale stored leaf (not in the catalog) is still removable: explicit paths are subtracted verbatim.
    await svc.updateCustomCategory(actor, { id: CAT_ID, categories: { leafPaths: ['Old › Leaf'] }, leafMode: 'remove' });
    expect(deps.customCategories.update).toHaveBeenLastCalledWith('u1', CAT_ID, { name: undefined, leafPaths: ['Lighting › Lamps'] });
    await svc.updateCustomCategory(actor, { id: CAT_ID, name: 'Ceilings', categories: ceiling });
    expect(deps.customCategories.update).toHaveBeenLastCalledWith('u1', CAT_ID, { name: 'Ceilings', leafPaths: ['Lighting › Ceiling Lights'] });
    await svc.updateCustomCategory(actor, { id: CAT_ID, name: 'Renamed' });
    expect(deps.customCategories.update).toHaveBeenLastCalledWith('u1', CAT_ID, { name: 'Renamed', leafPaths: undefined });
    expect(deps.customCategories.load).toHaveBeenCalledTimes(4);
    const missing = makeDeps({ customCategories: { ...makeDeps().customCategories, load: vi.fn(async () => null) } });
    await expect(createWorkspaceService(missing).updateCustomCategory(actor, { id: CAT_ID, categories: ceiling })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(missing.customCategories.update).not.toHaveBeenCalled();
  });
  it('a leaf list that empties out is INVALID_FILTERS from the command', async () => {
    const deps = makeDeps({ customCategories: { ...makeDeps().customCategories, update: vi.fn(async () => ({ ok: false as const, code: 'no_leaves' as const, message: 'A category needs at least one leaf.' })) } });
    await expect(createWorkspaceService(deps).updateCustomCategory(actor, { id: CAT_ID, categories: { leafPaths: ['Lighting › Lamps', 'Old › Leaf'] }, leafMode: 'remove' })).rejects.toMatchObject({ code: 'INVALID_FILTERS', message: 'A category needs at least one leaf.' });
  });
});

describe('watchlist', () => {
  it('add and remove pass both selections through, then report the live count and the cap', async () => {
    const deps = makeDeps();
    const svc = createWorkspaceService(deps);
    await expect(svc.addToWatchlist(actor, { keywords: ['desk lamp'], searchTermIds: [KW] })).resolves.toEqual({ added: 1, alreadyWatching: 0, unmatched: [], skippedAtCap: 0, watching: 7, limit: 100 });
    expect(deps.watchlist.add).toHaveBeenCalledWith('u1', { keywords: ['desk lamp'], searchTermIds: [KW] });
    await expect(svc.removeFromWatchlist(actor, { keywords: ['desk lamp'] })).resolves.toEqual({ removed: 1, notWatching: 0, unmatched: [], watching: 7, limit: 100 });
    expect(deps.bumpWrite).toHaveBeenCalledTimes(2);
  });
  it('an unexpected failure is logged as failed with the error name only, and rethrown', async () => {
    // The production shape: drizzle wraps the driver error, whose SQLSTATE sits on `cause`; the wrapper's
    // message embeds the bound params (here an email), which must never reach the log.
    const wrapped = new DrizzleQueryError('insert into "watchlist_items" ("user_id", "keyword_id") values ($1, $2)', ['u1', 'u1@example.com'], Object.assign(new Error('relation "watchlist_items" does not exist'), { code: '42P01' }));
    const deps = makeDeps({ watchlist: { ...makeDeps().watchlist, add: vi.fn(async () => { throw wrapped; }) } });
    await expect(createWorkspaceService(deps).addToWatchlist(actor, { keywords: ['x'] })).rejects.toBe(wrapped);
    expect(lines()[0]).toEqual(expect.objectContaining({ tool: 'add_to_watchlist', outcome: 'failed', error: 'Error', code: '42P01', userId: 'u1' }));
    expect(JSON.stringify(lines())).not.toContain('example.com');
  });
});
