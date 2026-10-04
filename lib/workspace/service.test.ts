// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
vi.mock('@/lib/env', () => ({ env: { DATABASE_URL: 'postgres://test', APP_PUBLIC_URL: 'https://keywordquarry.com' } }));
vi.mock('@/db/client', () => ({ db: {} }));

import { inspect } from 'node:util';
import { DrizzleQueryError } from 'drizzle-orm';
import { applyLeafMode, createWorkspaceService, type WorkspaceServiceDeps } from './service';
import { buildCategoryCatalog } from '@/lib/research/categories';
import { dataUnavailableError, poolBusyError, queryTimeoutError, ResearchError } from '@/lib/research/errors';
import { DEFAULT_LIMITS } from '@/lib/research/limits';
import type { ResearchActor } from '@/lib/research/service';
import { SAFE_TOOL_FAILURE } from '@/lib/research/toolErrors';
import { normalizeFilters } from '@/lib/savedViews/validation';
import { EXPLORER_DEFAULTS } from '@/lib/explorer/parseFilters';
import type { ExplorerFilters } from '@/lib/explorer/types';
import { consoleLines } from '@/tests/unit/consoleLines';
import { explorerUrlFor, NOTE_VIEW_TOO_WIDE, NOTE_WORD_COUNT_SORT } from './explorerFilters';

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
      count: vi.fn(async () => 3),
      create: vi.fn(async () => ({ ok: true as const, view })),
      update: vi.fn(async () => ({ ok: true as const, view })),
      delete: vi.fn(async () => ({ ok: true as const, deleted: { id: VIEW_ID, name: 'Lamps' } })),
    },
    customCategories: {
      list: vi.fn(async () => [category]),
      count: vi.fn(async () => 4),
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
let errorLog: MockInstance<typeof console.error>;
beforeEach(() => {
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  log.mockRestore();
  errorLog.mockRestore();
});
const lines = () => log.mock.calls.filter((c) => c[0] === '[workspace]').map((c) => JSON.parse(String(c[1])) as Record<string, unknown>);

describe('list tools', () => {
  it('reserve → list → record, never the write counter; summaries carry links and compact filters', async () => {
    const deps = makeDeps();
    const svc = createWorkspaceService(deps);
    const res = await svc.listSavedViews(actor, {});
    expect(deps.reserve).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', channel: 'mcp', rows: 0 }));
    expect(res).toEqual({ views: [{ id: VIEW_ID, name: 'Lamps', explorerUrl: `https://keywordquarry.com/explorer?view=${VIEW_ID}`, filters: { q: 'lamp' }, leafCount: 0, previewComplete: true, createdAt: view.createdAt, updatedAt: view.updatedAt }], count: 1, limit: 5 });
    expect(deps.record).toHaveBeenCalledWith('u1', 0, 'mcp');
    expect(deps.countWritesToday).not.toHaveBeenCalled();
    expect(deps.bumpWrite).not.toHaveBeenCalled();
    const cats = await svc.listCustomCategories(actor, {});
    expect(cats).toEqual({ categories: [{ id: CAT_ID, name: 'Lighting', leafCount: 2, previewPaths: ['Lighting › Lamps', 'Old › Leaf'], previewComplete: true, explorerUrl: `https://keywordquarry.com/explorer?custom=${CAT_ID}`, createdAt: category.createdAt, updatedAt: category.updatedAt }], count: 1, limit: 25 });
    const wl = await svc.listWatchlist(actor, {});
    expect(wl).toEqual({ items: [{ searchTermId: KW, keyword: 'desk lamp', keywordUrl: `https://keywordquarry.com/explorer/keyword/${KW}`, addedAt: '2026-09-30T09:00:00.000Z' }], count: 1, limit: 100 });
    expect(lines().map((l) => l.outcome)).toEqual(['ok', 'ok', 'ok']);
  });
  it('each log line names the channel (a coded value), so chat writes and MCP writes can be told apart', async () => {
    const svc = createWorkspaceService(makeDeps());
    await svc.listSavedViews(actor, {});
    await svc.listSavedViews({ ...actor, clientId: 'ask-ai', channel: 'chat' }, {});
    expect(lines().map((l) => l.channel)).toEqual(['mcp', 'chat']);
  });
  it('rejects an unexpected key before reserving', async () => {
    const deps = makeDeps();
    await expect(createWorkspaceService(deps).listSavedViews(actor, { page: 2 })).rejects.toMatchObject({ code: 'INVALID_FILTERS' });
    expect(deps.reserve).not.toHaveBeenCalled();
  });
  it('previews a saved view with many leaf categories like a custom category does: the first 20, with leafCount and previewComplete', async () => {
    const leaves = Array.from({ length: 25 }, (_, i) => `Dept › Leaf ${String(i).padStart(2, '0')}`);
    const big = { ...view, filters: normalizeFilters({ leafPaths: leaves }) };
    const exactly20 = { ...view, filters: normalizeFilters({ leafPaths: leaves.slice(0, 20) }) };
    const deps = makeDeps({ savedViews: { ...makeDeps().savedViews, list: vi.fn(async () => [big, exactly20, view]) } });
    const res = await createWorkspaceService(deps).listSavedViews(actor, {});
    const [a, b, c] = res.views;
    expect(big.filters.leafPaths).toHaveLength(25); // the fixture really stores 25
    expect(a).toMatchObject({ leafCount: 25, previewComplete: false });
    expect(a.filters.leafPaths).toHaveLength(20);
    expect(a.filters.leafPaths).toEqual(big.filters.leafPaths.slice(0, 20));
    expect(big.filters.leafPaths).toHaveLength(25); // the stored view is previewed, not trimmed in place
    expect(b).toMatchObject({ leafCount: 20, previewComplete: true });
    expect(b.filters.leafPaths).toEqual(exactly20.filters.leafPaths);
    expect(c).toMatchObject({ leafCount: 0, previewComplete: true });
    expect(c.filters).not.toHaveProperty('leafPaths');
  });
});

describe('create_saved_view', () => {
  const search = {
    schemaVersion: 1, comparisonWindow: '1w',
    filters: { text: { value: 'lamp' }, categories: { selections: [{ kind: 'taxonomy', path: 'Lighting', includeDescendants: true }, { kind: 'custom', id: CUSTOM_ID }] } },
  };
  it('validates → reserves → checks the daily cap → converts through the search\'s own validation → saves → records and bumps → reads the count', async () => {
    const deps = makeDeps();
    const res = await createWorkspaceService(deps).createSavedView(actor, { name: 'Lamps', search });
    expect(deps.reserve).toHaveBeenCalledTimes(1);
    expect(deps.countWritesToday).toHaveBeenCalledWith('u1');
    const [uid, input] = (deps.savedViews.create as ReturnType<typeof vi.fn>).mock.calls[0] as [string, { name: string; filters: Record<string, unknown> }];
    expect(uid).toBe('u1');
    expect(input.name).toBe('Lamps');
    // A mixed scope (a taxonomy selection plus a custom category) is saved as the union of leaves, with no ids (spec §5.2).
    expect(input.filters).toMatchObject({ ...EXPLORER_DEFAULTS, window: '1w', q: 'lamp', leafPaths: ['Lighting › Ceiling Lights', 'Lighting › Lamps'], customCategoryIds: [], category: null });
    // count = the account's saved views after this call, limit = MAX_VIEWS_PER_USER: the model never has to compute free slots itself.
    expect(res).toEqual({ view: expect.objectContaining({ id: VIEW_ID, explorerUrl: `https://keywordquarry.com/explorer?view=${VIEW_ID}` }), notes: [], count: 3, limit: 5 });
    expect(deps.savedViews.count).toHaveBeenCalledWith('u1');
    expect(deps.record).toHaveBeenCalledWith('u1', 0, 'mcp');
    expect(deps.bumpWrite).toHaveBeenCalledWith('u1');
    expect(lines()[0]).toMatchObject({ tool: 'create_saved_view', outcome: 'ok', userId: 'u1' });
    expect(JSON.stringify(lines())).not.toContain('Lamps');
  });
  // §5.2: the Explorer sidebar holds one leaf mode at a time (custom ids OR leaf paths), so a view carrying both would lose its taxonomy part on the first Apply.
  const savedFilters = async (categories: unknown) => {
    const loadCatalog = vi.fn(async () => catalog);
    const deps = makeDeps({ categories: { ...makeDeps().categories, loadCatalog } });
    await createWorkspaceService(deps).createSavedView(actor, { name: 'L', search: { filters: { categories } } });
    expect(loadCatalog).toHaveBeenCalledTimes(1); // one resolveScope: the converter decides between ids and leaves, there is no second resolution
    return (deps.savedViews.create as ReturnType<typeof vi.fn>).mock.calls[0][1].filters as Record<string, unknown>;
  };
  it('a mixed scope is saved as the union of its leaves, the custom category\'s included, with no ids', async () => {
    const ceiling = { kind: 'taxonomy', path: 'Lighting › Ceiling Lights' }; // the custom category's own leaf is Lighting › Lamps
    const custom = { kind: 'custom', id: CUSTOM_ID };
    expect(await savedFilters({ selections: [ceiling, custom] })).toMatchObject({ leafPaths: ['Lighting › Ceiling Lights', 'Lighting › Lamps'], customCategoryIds: [] });
    expect(await savedFilters({ selections: [custom], leafPaths: ['Lighting › Ceiling Lights'] })).toMatchObject({ leafPaths: ['Lighting › Ceiling Lights', 'Lighting › Lamps'], customCategoryIds: [] });
  });
  it('a custom-only scope is saved by id with no leaves, so the view follows later edits to the category', async () => {
    expect(await savedFilters({ selections: [{ kind: 'custom', id: CUSTOM_ID }] })).toMatchObject({ customCategoryIds: [CUSTOM_ID], leafPaths: [] });
  });
  it('fills schemaVersion when the AI omits it, and refuses a cursor', async () => {
    const deps = makeDeps();
    const svc = createWorkspaceService(deps);
    await expect(svc.createSavedView(actor, { name: 'L', search: { filters: { text: { value: 'lamp' } } } })).resolves.toBeTruthy();
    await expect(svc.createSavedView(actor, { name: 'L', search: { cursor: 'c'.repeat(20) } })).rejects.toMatchObject({ code: 'INVALID_FILTERS' });
  });
  it('accepts and ignores a pageSize copied from the search (a saved view has no page size): the stored filters are the same as without it', async () => {
    const withPageSize = makeDeps();
    const without = makeDeps();
    await createWorkspaceService(withPageSize).createSavedView(actor, { name: 'Lamps', search: { ...search, pageSize: 50 } });
    await createWorkspaceService(without).createSavedView(actor, { name: 'Lamps', search });
    const stored = (deps: WorkspaceServiceDeps) => (deps.savedViews.create as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(stored(withPageSize)).toEqual(stored(without));
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
  it('the 200th write of the day is still allowed: 199 already counted against a cap of 200', async () => {
    const deps = makeDeps({ limits: { ...DEFAULT_LIMITS, writesPerDay: 200 }, countWritesToday: vi.fn(async () => 199) });
    await expect(createWorkspaceService(deps).createSavedView(actor, { name: 'L', search: {} })).resolves.toBeTruthy();
    expect(deps.savedViews.create).toHaveBeenCalledTimes(1);
    expect(deps.bumpWrite).toHaveBeenCalledWith('u1');
  });
  it('a per-minute RATE_LIMITED from reserve stops a write before the daily count, the catalog and any command', async () => {
    const limited = new ResearchError('RATE_LIMITED', 'Rate limit reached (60 requests or 6000 rows per minute per account). Try again in 12 seconds.', { retryable: true, retryAfterSeconds: 12 });
    const loadCatalog = vi.fn(async () => catalog);
    const deps = makeDeps({ reserve: vi.fn(async () => { throw limited; }), categories: { ...makeDeps().categories, loadCatalog } });
    await expect(createWorkspaceService(deps).createSavedView(actor, { name: 'L', search: {} })).rejects.toBe(limited);
    expect(deps.countWritesToday).not.toHaveBeenCalled();
    expect(loadCatalog).not.toHaveBeenCalled();
    expect(deps.savedViews.create).not.toHaveBeenCalled();
    expect(deps.record).not.toHaveBeenCalled();
    expect(deps.bumpWrite).not.toHaveBeenCalled();
    expect(lines()).toEqual([expect.objectContaining({ tool: 'create_saved_view', outcome: 'refused', code: 'RATE_LIMITED' })]);
  });
  it('a schema failure on a write is INVALID_FILTERS and reserves nothing', async () => {
    const deps = makeDeps();
    await expect(createWorkspaceService(deps).createSavedView(actor, { name: '   ', search: {} })).rejects.toMatchObject({ code: 'INVALID_FILTERS' });
    expect(deps.reserve).not.toHaveBeenCalled();
    expect(deps.countWritesToday).not.toHaveBeenCalled();
    expect(deps.record).not.toHaveBeenCalled();
    expect(lines()).toEqual([expect.objectContaining({ tool: 'create_saved_view', outcome: 'refused', code: 'INVALID_FILTERS' })]);
  });
  it('runs in the documented order: reserve, daily cap, command, record, the write bump, then the trailing count read', async () => {
    const deps = makeDeps();
    await createWorkspaceService(deps).createSavedView(actor, { name: 'L', search: {} });
    const at = (fn: unknown) => (fn as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const order = [deps.reserve, deps.countWritesToday, deps.savedViews.create, deps.record, deps.bumpWrite, deps.savedViews.count].map(at);
    expect(order.every((n) => typeof n === 'number')).toBe(true); // every step ran
    expect(order).toEqual([...order].sort((a, b) => a - b)); // and in this order
  });
});

describe('update and delete saved view', () => {
  it('a rename passes only the name; a new search replaces the filters wholesale; the result carries the count after the write and the cap', async () => {
    const deps = makeDeps();
    const svc = createWorkspaceService(deps);
    await expect(svc.updateSavedView(actor, { id: VIEW_ID, name: 'New' })).resolves.toEqual({ view: expect.objectContaining({ id: VIEW_ID }), notes: [], count: 3, limit: 5 });
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
  it('delete returns what it removed, then how many saved views are left and the cap', async () => {
    const deps = makeDeps();
    await expect(createWorkspaceService(deps).deleteSavedView(actor, { id: VIEW_ID })).resolves.toEqual({ deleted: { id: VIEW_ID, name: 'Lamps' }, count: 3, limit: 5 });
    expect(deps.savedViews.count).toHaveBeenCalledWith('u1');
    expect(deps.bumpWrite).toHaveBeenCalledWith('u1');
  });
});

// A saved view opens from its short ?view= link, but the Explorer's Export and the sidebar's Apply re-serialise its stored filters into
// URLs, and past the search link's 12,000-byte cap both fail. The save still lands as asked; its notes say so and name the way out.
describe('a saved view too wide for the Explorer to export or refine', () => {
  // 150 long leaf paths under one department: about 12,600 bytes as a link. A custom category holding them passes by id instead.
  const wideLeaves = Array.from({ length: 150 }, (_, i) => `Department › Section ${i} › A fairly long leaf category name ${i}`);
  const wide = buildCategoryCatalog({ snapshotVersion: 'snap', datasetWeek: '2026-09-26' }, wideLeaves.map((categoryPath) => ({ categoryPath, allCount: 1 })));
  const wideDeps = () => makeDeps({ categories: { loadCatalog: async () => wide, loadCustomRows: async () => [{ id: CUSTOM_ID, leafPaths: wideLeaves }], listCustom: async () => [] } });
  const department = { filters: { categories: { selections: [{ kind: 'taxonomy', path: 'Department', includeDescendants: true }] } } };
  /** The filters the service handed to the command's latest call (its last argument). */
  const savedFilters = (command: unknown) => ((command as ReturnType<typeof vi.fn>).mock.lastCall!.at(-1) as { filters: ExplorerFilters }).filters;

  it('create stores all 150 leaves as asked and adds NOTE_VIEW_TOO_WIDE, on the search link\'s own 12,000-byte cap', async () => {
    const deps = wideDeps();
    const res = await createWorkspaceService(deps).createSavedView(actor, { name: 'Wide', search: department });
    const filters = savedFilters(deps.savedViews.create);
    expect(filters.leafPaths).toEqual([...wideLeaves].sort());
    expect(explorerUrlFor('https://keywordquarry.com', filters)).toBeNull();
    expect(res.notes).toEqual([NOTE_VIEW_TOO_WIDE]);
    expect(deps.bumpWrite).toHaveBeenCalledWith('u1'); // saved, not refused
  });
  it('update with a new search adds it too, after the converter\'s own notes; a rename converts nothing and adds none', async () => {
    const deps = wideDeps();
    const svc = createWorkspaceService(deps);
    const res = await svc.updateSavedView(actor, { id: VIEW_ID, search: department });
    expect(savedFilters(deps.savedViews.update).leafPaths).toHaveLength(150);
    expect(res.notes).toEqual([NOTE_VIEW_TOO_WIDE]);
    const byWords = await svc.updateSavedView(actor, { id: VIEW_ID, search: { ...department, sort: { field: 'wordCount', direction: 'asc' } } });
    expect(byWords.notes).toEqual([NOTE_WORD_COUNT_SORT, NOTE_VIEW_TOO_WIDE]);
    expect((await svc.updateSavedView(actor, { id: VIEW_ID, name: 'Renamed' })).notes).toEqual([]);
  });
  it('a scope that fits in a link gets no such note, and neither do the same 150 leaves as a custom category, which pass by id', async () => {
    const deps = wideDeps();
    const svc = createWorkspaceService(deps);
    const one = await svc.createSavedView(actor, { name: 'One', search: { filters: { categories: { leafPaths: [wideLeaves[1]] } } } });
    expect(savedFilters(deps.savedViews.create).leafPaths).toEqual([wideLeaves[1]]);
    expect(one.notes).toEqual([]);
    const custom = await svc.createSavedView(actor, { name: 'Custom', search: { filters: { categories: { selections: [{ kind: 'custom', id: CUSTOM_ID }] } } } });
    expect(savedFilters(deps.savedViews.create)).toMatchObject({ customCategoryIds: [CUSTOM_ID], leafPaths: [] });
    expect(custom.notes).toEqual([]);
  });
});

describe('custom categories', () => {
  it('create expands selections against the catalog and stores the leaves; the result carries the count after the write and the cap', async () => {
    const deps = makeDeps();
    const res = await createWorkspaceService(deps).createCustomCategory(actor, { name: 'Lighting', categories: { selections: [{ kind: 'taxonomy', path: 'Lighting', includeDescendants: true }] } });
    expect(deps.customCategories.create).toHaveBeenCalledWith('u1', { name: 'Lighting', leafPaths: ['Lighting › Ceiling Lights', 'Lighting › Lamps'] });
    expect(res).toEqual({ category: expect.objectContaining({ id: CAT_ID, leafCount: 2, previewComplete: true, explorerUrl: `https://keywordquarry.com/explorer?custom=${CAT_ID}` }), notes: [], count: 4, limit: 25 });
    expect(deps.customCategories.count).toHaveBeenCalledWith('u1');
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
    await expect(svc.updateCustomCategory(actor, { id: CAT_ID, name: 'Renamed' })).resolves.toEqual({ category: expect.objectContaining({ id: CAT_ID }), notes: [], count: 4, limit: 25 });
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
  it('expands up to the category column\'s 12,000 leaves, not the search\'s 2,000: a 2,001-leaf department saves as a category but is refused as a saved-view search', async () => {
    // The live taxonomy has ~11.4k leaves in all, so a true over-12,000 case cannot be built from real data; this pins that the column's cap, not the search's, applies.
    const big = buildCategoryCatalog({ snapshotVersion: 'snap', datasetWeek: '2026-09-26' }, Array.from({ length: 2001 }, (_, i) => ({ categoryPath: `Big Department › Leaf ${String(i).padStart(4, '0')}`, allCount: 1 })));
    const create = vi.fn(async (_userId: string, input: { name: unknown; leafPaths: unknown }) => ({
      ok: true as const,
      category: { id: CAT_ID, name: String(input.name), leafPaths: input.leafPaths as string[], createdAt: category.createdAt, updatedAt: category.updatedAt },
    }));
    const deps = makeDeps({
      categories: { loadCatalog: async () => big, loadCustomRows: async () => [], listCustom: async () => [] },
      customCategories: { ...makeDeps().customCategories, create },
    });
    const svc = createWorkspaceService(deps);
    const department = { selections: [{ kind: 'taxonomy', path: 'Big Department', includeDescendants: true }] };
    // Control: the same department as a saved-view search is over limits.maxExpandedLeaves (2,000).
    await expect(svc.createSavedView(actor, { name: 'Big', search: { filters: { categories: department } } })).rejects.toMatchObject({ code: 'INVALID_FILTERS' });
    const res = await svc.createCustomCategory(actor, { name: 'Big', categories: department });
    expect(create.mock.calls[0][1].leafPaths).toHaveLength(2001);
    expect(res.category).toMatchObject({ leafCount: 2001, previewComplete: false });
    expect(res.category.previewPaths).toHaveLength(20);
  });
  it('delete returns what it removed (id, name, leaf count), then how many custom categories are left and the cap, and bumps the write counter', async () => {
    const deps = makeDeps();
    await expect(createWorkspaceService(deps).deleteCustomCategory(actor, { id: CAT_ID })).resolves.toEqual({ deleted: { id: CAT_ID, name: 'Lighting', leafCount: 2 }, count: 4, limit: 25 });
    expect(deps.customCategories.delete).toHaveBeenCalledWith('u1', CAT_ID);
    expect(deps.customCategories.count).toHaveBeenCalledWith('u1');
    expect(deps.bumpWrite).toHaveBeenCalledWith('u1');
  });
  it('a foreign or missing category id is NOT_FOUND with the account-scoped sentence, and does not bump', async () => {
    const deps = makeDeps({ customCategories: { ...makeDeps().customCategories, delete: vi.fn(async () => ({ ok: false as const, code: 'not_found' as const, message: 'Not found' })) } });
    await expect(createWorkspaceService(deps).deleteCustomCategory(actor, { id: CAT_ID })).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'No custom category with that id belongs to this account.' });
    expect(deps.bumpWrite).not.toHaveBeenCalled();
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
  it('an unexpected failure is logged as failed with the error name only, and surfaces as a safe DATA_UNAVAILABLE, never the raw error', async () => {
    // The production shape: drizzle wraps the driver error, whose SQLSTATE sits on `cause`; the wrapper's
    // message embeds the bound params (here an email), which must never reach the log or the thrown error.
    const wrapped = new DrizzleQueryError('insert into "watchlist_items" ("user_id", "keyword_id") values ($1, $2)', ['u1', 'u1@example.com'], Object.assign(new Error('relation "watchlist_items" does not exist'), { code: '42P01' }));
    const deps = makeDeps({ watchlist: { ...makeDeps().watchlist, add: vi.fn(async () => { throw wrapped; }) } });
    const err = await createWorkspaceService(deps).addToWatchlist(actor, { keywords: ['x'] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResearchError);
    expect(err).not.toBe(wrapped);
    expect(err).toMatchObject({ code: 'DATA_UNAVAILABLE', message: SAFE_TOOL_FAILURE.message, retryable: true });
    expect((err as ResearchError).cause).toBeUndefined();
    expect(inspect(err, { depth: 6 })).not.toContain('example.com'); // no message, cause or stack from the original
    expect(lines()[0]).toEqual(expect.objectContaining({ tool: 'add_to_watchlist', outcome: 'failed', error: 'Error', code: '42P01', userId: 'u1' }));
    expect(JSON.stringify(lines())).not.toContain('example.com');
  });
  it('records the write before the trailing count read, so a write that landed still counts when that read fails', async () => {
    const deps = makeDeps({ watchlist: { ...makeDeps().watchlist, count: vi.fn(async () => { throw new Error('count read failed'); }) } });
    const svc = createWorkspaceService(deps);
    await expect(svc.addToWatchlist(actor, { keywords: ['desk lamp'] })).rejects.toMatchObject({ code: 'DATA_UNAVAILABLE', message: SAFE_TOOL_FAILURE.message });
    await expect(svc.removeFromWatchlist(actor, { keywords: ['desk lamp'] })).rejects.toMatchObject({ code: 'DATA_UNAVAILABLE', message: SAFE_TOOL_FAILURE.message });
    expect(deps.watchlist.add).toHaveBeenCalledTimes(1);
    expect(deps.watchlist.remove).toHaveBeenCalledTimes(1);
    expect(deps.record).toHaveBeenCalledTimes(2);
    expect(deps.bumpWrite).toHaveBeenCalledTimes(2);
    expect(lines().map((l) => l.outcome)).toEqual(['failed', 'failed']);
  });
});

describe('unexpected failures', () => {
  it('a command failure puts none of the request\'s data in any console line or on the thrown error, and logs only the error name and SQLSTATE', async () => {
    const wrapped = new DrizzleQueryError('insert into "saved_views" ("user_id", "name", "filters") values ($1, $2, $3)', ['u1', 'SECRET-VIEW-NAME', '{}'], Object.assign(new Error('boom'), { code: '08006' }));
    const deps = makeDeps({ savedViews: { ...makeDeps().savedViews, create: vi.fn(async () => { throw wrapped; }) } });
    const err = await createWorkspaceService(deps).createSavedView(actor, { name: 'SECRET-VIEW-NAME', search: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResearchError);
    expect(err).toMatchObject({ code: 'DATA_UNAVAILABLE', message: SAFE_TOOL_FAILURE.message, retryable: true });
    expect(lines()).toEqual([expect.objectContaining({ tool: 'create_saved_view', outcome: 'failed', error: 'Error', code: '08006' })]);
    expect([...consoleLines(log, errorLog), inspect(err, { depth: 6 })].join('\n')).not.toContain('SECRET-VIEW-NAME');
    expect(deps.bumpWrite).not.toHaveBeenCalled(); // the write did not land
  });
  it('a pool connect timeout surfaces as the pool-busy answer with its short retry', async () => {
    const busy = poolBusyError();
    const deps = makeDeps({ savedViews: { ...makeDeps().savedViews, delete: vi.fn(async () => { throw new Error('timeout exceeded when trying to connect'); }) } });
    const err = await createWorkspaceService(deps).deleteSavedView(actor, { id: VIEW_ID }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResearchError);
    expect(err).toMatchObject({ code: busy.code, message: busy.message, retryable: true, retryAfterSeconds: busy.retryAfterSeconds });
    expect((err as ResearchError).cause).toBeUndefined();
    expect(lines()).toEqual([expect.objectContaining({ tool: 'delete_saved_view', outcome: 'failed', error: 'Error' })]);
    expect(lines()[0]).not.toHaveProperty('code');
    expect(deps.bumpWrite).not.toHaveBeenCalled();
  });
  it('logs infrastructure ResearchErrors (DATA_UNAVAILABLE, QUERY_TIMEOUT) as failed and other refusals as refused; the error itself passes through unchanged', async () => {
    const unavailable = dataUnavailableError();
    const timeout = queryTimeoutError(3000, { guidance: 'Category lookup timed out; try again.', retryAfterSeconds: 5 });
    const failingCatalog = (e: ResearchError) => createWorkspaceService(makeDeps({ categories: { ...makeDeps().categories, loadCatalog: async () => { throw e; } } }));
    await expect(failingCatalog(unavailable).createSavedView(actor, { name: 'L', search: {} })).rejects.toBe(unavailable);
    await expect(failingCatalog(timeout).createSavedView(actor, { name: 'L', search: {} })).rejects.toBe(timeout);
    await expect(createWorkspaceService(makeDeps()).createSavedView(actor, { name: 'L', search: { filters: { categories: { leafPaths: ['Nope › Nothing'] } } } })).rejects.toMatchObject({ code: 'CATEGORY_NOT_AVAILABLE' });
    expect(lines().map((l) => [l.outcome, l.code])).toEqual([['failed', 'DATA_UNAVAILABLE'], ['failed', 'QUERY_TIMEOUT'], ['refused', 'CATEGORY_NOT_AVAILABLE']]);
  });
  it('records a view or category delete before the trailing count read, so a delete that landed still counts when that read fails (like the watchlist writes)', async () => {
    const deps = makeDeps({
      savedViews: { ...makeDeps().savedViews, count: vi.fn(async () => { throw new Error('count read failed'); }) },
      customCategories: { ...makeDeps().customCategories, count: vi.fn(async () => { throw new Error('count read failed'); }) },
    });
    const svc = createWorkspaceService(deps);
    await expect(svc.deleteSavedView(actor, { id: VIEW_ID })).rejects.toMatchObject({ code: 'DATA_UNAVAILABLE', message: SAFE_TOOL_FAILURE.message });
    await expect(svc.deleteCustomCategory(actor, { id: CAT_ID })).rejects.toMatchObject({ code: 'DATA_UNAVAILABLE', message: SAFE_TOOL_FAILURE.message });
    expect(deps.savedViews.delete).toHaveBeenCalledTimes(1);
    expect(deps.customCategories.delete).toHaveBeenCalledTimes(1);
    expect(deps.record).toHaveBeenCalledTimes(2);
    expect(deps.bumpWrite).toHaveBeenCalledTimes(2);
    expect(lines().map((l) => [l.tool, l.outcome])).toEqual([['delete_saved_view', 'failed'], ['delete_custom_category', 'failed']]);
  });
});

describe('applyLeafMode', () => {
  const stored = ['Dept › A', 'Dept › B', 'Other › C'];
  it('replace: exactly the expansion; the stored leaves are dropped', () => {
    expect(applyLeafMode({ stored, mode: 'replace', explicitPaths: [], expansion: ['New › X'] })).toEqual(['New › X']);
  });
  it('add: the stored leaves first, then the new ones, without duplicates', () => {
    expect(applyLeafMode({ stored, mode: 'add', explicitPaths: [], expansion: ['Other › C', 'New › X', 'New › X'] })).toEqual(['Dept › A', 'Dept › B', 'Other › C', 'New › X']);
  });
  it('remove: subtracts the expansion of the selections and the explicit paths, keeping the stored order', () => {
    expect(applyLeafMode({ stored, mode: 'remove', explicitPaths: ['Other › C'], expansion: ['Dept › A'] })).toEqual(['Dept › B']);
  });
  it('remove: explicit paths are taken verbatim (trimmed), so a stale stored leaf the catalog no longer has can still be removed', () => {
    expect(applyLeafMode({ stored: [...stored, 'Old › Gone'], mode: 'remove', explicitPaths: ['  Old › Gone '], expansion: [] })).toEqual(stored);
  });
  it('remove: a path that is not stored changes nothing, and removing every leaf yields an empty list (the command refuses that)', () => {
    expect(applyLeafMode({ stored, mode: 'remove', explicitPaths: ['Nope › Z'], expansion: [] })).toEqual(stored);
    expect(applyLeafMode({ stored, mode: 'remove', explicitPaths: [...stored], expansion: [] })).toEqual([]);
  });
  it('never mutates its inputs', () => {
    const s = [...stored];
    const e = ['New › X'];
    for (const mode of ['replace', 'add', 'remove'] as const) applyLeafMode({ stored: s, mode, explicitPaths: ['Dept › A'], expansion: e });
    expect(s).toEqual(stored);
    expect(e).toEqual(['New › X']);
  });
});
