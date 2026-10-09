import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
vi.mock('@/lib/env', () => ({ env: {} }));
import { buildAskTools, runWorkspaceTool, toolApprovalFor } from './tools';
import { ResearchError } from '@/lib/research/errors';
import { DEFAULT_LIMITS } from '@/lib/research/limits';
import { SAFE_TOOL_FAILURE } from '@/lib/research/toolErrors';
import { RESEARCH_TOOLS } from '@/lib/research/tools';
import type { ResearchActor, ResearchService } from '@/lib/research/service';
import { WORKSPACE_TOOL_NAMES, type WorkspaceService } from '@/lib/workspace/contracts';
import { WORKSPACE_TOOLS } from '@/lib/workspace/tools';

const actor: ResearchActor = { localUserId: 'u1', clerkUserId: 'user_1', clientId: 'ask-ai', channel: 'chat', isAdmin: false };
const service = {
  guide: vi.fn(async () => ({ guideVersion: 1 })),
  resolveCategories: vi.fn(async () => ({ candidates: [] })),
  search: vi.fn(async () => { throw new ResearchError('RATE_LIMITED', 'Rate limit reached', { retryable: true, retryAfterSeconds: 9 }); }),
  details: vi.fn(async () => { throw new Error('pg: connection reset'); }),
  history: vi.fn(async () => ({ points: [] })),
  searchProducts: vi.fn(async () => ({ products: [], adminOnly: true })),
  productDetails: vi.fn(async () => ({ product: { asin: 'B0ABCDEF12' } })),
} as unknown as ResearchService;
const admin: ResearchActor = { ...actor, isAdmin: true };
// lib/savedViews/commands.ts's own sentence, which the workspace service passes through as DUPLICATE_NAME.
const DUPLICATE_MESSAGE = 'You already have a view named "Lamps". Choose a different name or update the existing one.';
const workspace = {
  listSavedViews: vi.fn(async () => ({ views: [], count: 0, limit: 5 })),
  createSavedView: vi.fn(async () => { throw new ResearchError('DUPLICATE_NAME', DUPLICATE_MESSAGE); }),
  addToWatchlist: vi.fn(async () => ({ added: 1, alreadyWatching: 0, unmatched: [], skippedAtCap: 0, watching: 1, limit: 100 })),
  deleteSavedView: vi.fn(async () => { throw new Error('pg: connection reset'); }),
} as unknown as WorkspaceService;
const HEX_ID = 'abcdef12-abcd-4abc-8abc-abcdef123456';
const INVALID = { error: { code: 'INVALID_FILTERS', message: 'The approved action could not be run: its details were invalid.', retryable: false } };
const RESEARCH = ['get_research_guide', 'resolve_categories', 'search_keywords', 'get_keyword_details', 'get_keyword_history'];
/** The admin-only research tools (spec 2026-10-09 §9): bound for an admin actor only. */
const PRODUCTS = ['search_products', 'get_product_details'];
const CHANGES = ['create_saved_view', 'update_saved_view', 'create_custom_category', 'update_custom_category', 'add_to_watchlist', 'remove_from_watchlist'];
const DELETES = ['delete_saved_view', 'delete_custom_category'];
const LISTS = ['list_saved_views', 'list_custom_categories', 'list_watchlist'];
const sorted = (names: ReadonlyArray<string>) => [...names].sort();

const exec = (t: ReturnType<typeof buildAskTools>, name: string, args: unknown) => (t[name] as { execute: (a: unknown, o: unknown) => Promise<unknown> }).execute(args, { toolCallId: 't1', messages: [] });
/** What the SDK sends the model for one bound tool: its description, and its input schema (compared by identity). */
const bound = (t: ReturnType<typeof buildAskTools>, name: string) => t[name] as { description?: string; inputSchema?: unknown };

// vitest 4's restoreAllMocks only restores vi.spyOn spies, so clear every vi.fn's call history before each test too.
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe('buildAskTools', () => {
  const tools = buildAskTools(service, actor, DEFAULT_LIMITS);

  it('without a workspace service (the flag off) exposes exactly the five research tools, byte-for-byte today\'s chat: the shared descriptions and schemas (spec 2026-10-01 §2)', () => {
    expect(Object.keys(tools)).toEqual(RESEARCH);
    for (const d of RESEARCH_TOOLS.filter((t) => !t.adminOnly)) {
      expect(bound(tools, d.name).description).toBe(d.description(DEFAULT_LIMITS));
      expect(bound(tools, d.name).inputSchema).toBe(d.inputSchema);
    }
    expect(bound(tools, 'search_keywords').description).toContain('Search current Amazon keywords');
    for (const name of WORKSPACE_TOOL_NAMES) expect(tools[name]).toBeUndefined();
    expect(Object.keys(buildAskTools(service, actor, DEFAULT_LIMITS, null))).toEqual(RESEARCH);
  });
  it('runs the service with the bound actor', async () => {
    await expect(exec(tools, 'get_research_guide', {})).resolves.toEqual({ guideVersion: 1 });
    expect(service.guide).toHaveBeenCalledExactlyOnceWith(actor);
    await expect(exec(tools, 'get_keyword_history', { searchTermId: 'x', weeks: 4 })).resolves.toEqual({ points: [] });
    expect(service.history).toHaveBeenCalledExactlyOnceWith(actor, { searchTermId: 'x', weeks: 4 });
  });
  it('returns a ResearchError as a result object, never a throw, so the model can explain or narrow', async () => {
    await expect(exec(tools, 'search_keywords', { filters: {} })).resolves.toEqual({ error: { code: 'RATE_LIMITED', message: 'Rate limit reached', retryable: true, retryAfterSeconds: 9 } });
  });
  it('replaces an unexpected error with the safe sentence and logs it under [ask tool]', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(exec(tools, 'get_keyword_details', { searchTermId: 'x' })).resolves.toEqual({ error: SAFE_TOOL_FAILURE });
    expect(error.mock.calls[0][0]).toBe('[ask tool]');
    expect(String(error.mock.calls[0][1])).toContain('get_keyword_details');
  });

  describe('the admin-only products tools (spec 2026-10-09 §9)', () => {
    it('leaves search_products and get_product_details out of a non-admin chat, with or without the workspace tools', () => {
      expect(RESEARCH_TOOLS.filter((t) => t.adminOnly).map((t) => t.name)).toEqual(PRODUCTS);
      for (const set of [tools, buildAskTools(service, actor, DEFAULT_LIMITS, workspace)]) {
        for (const name of PRODUCTS) expect(set[name], name).toBeUndefined();
      }
    });
    it('binds both for an admin, after the five keyword tools and before the workspace tools, with the shared descriptions and schemas', () => {
      const forAdmin = buildAskTools(service, admin, DEFAULT_LIMITS);
      expect(Object.keys(forAdmin)).toEqual([...RESEARCH, ...PRODUCTS]);
      for (const d of RESEARCH_TOOLS) {
        expect(bound(forAdmin, d.name).description).toBe(d.description(DEFAULT_LIMITS));
        expect(bound(forAdmin, d.name).inputSchema).toBe(d.inputSchema);
      }
      expect(bound(forAdmin, 'search_products').description).toContain('Admin accounts only for now.');
      expect(Object.keys(buildAskTools(service, admin, DEFAULT_LIMITS, workspace))).toEqual([...RESEARCH, ...PRODUCTS, ...WORKSPACE_TOOL_NAMES]);
    });
    it('runs them against the service with the bound admin actor and the SDK-parsed input', async () => {
      const forAdmin = buildAskTools(service, admin, DEFAULT_LIMITS);
      await expect(exec(forAdmin, 'search_products', { filters: { listedWithinDays: 180 } })).resolves.toEqual({ products: [], adminOnly: true });
      expect(service.searchProducts).toHaveBeenCalledExactlyOnceWith(admin, { filters: { listedWithinDays: 180 } });
      await expect(exec(forAdmin, 'get_product_details', { asin: 'B0ABCDEF12' })).resolves.toEqual({ product: { asin: 'B0ABCDEF12' } });
      expect(service.productDetails).toHaveBeenCalledExactlyOnceWith(admin, { asin: 'B0ABCDEF12' });
    });
  });

  describe('with a workspace service (the flag on)', () => {
    const all = buildAskTools(service, actor, DEFAULT_LIMITS, workspace);

    it('exposes the five research tools followed by the eleven workspace tools, with the shared descriptions and schemas', () => {
      expect(Object.keys(all)).toEqual([...RESEARCH, ...WORKSPACE_TOOL_NAMES]);
      for (const d of WORKSPACE_TOOLS) {
        expect(bound(all, d.name).description).toBe(d.description(DEFAULT_LIMITS));
        // The very schema object the MCP registers, so the SDK rejects a bad or hallucinated key the same way.
        expect(bound(all, d.name).inputSchema).toBe(d.inputSchema);
      }
    });
    it('runs a workspace tool with the bound actor and the SDK-parsed input', async () => {
      await expect(exec(all, 'add_to_watchlist', { keywords: ['desk lamp'], searchTermIds: [] })).resolves.toMatchObject({ added: 1 });
      expect(workspace.addToWatchlist).toHaveBeenCalledExactlyOnceWith(actor, { keywords: ['desk lamp'], searchTermIds: [] });
    });
    it('a ResearchError from a write is a result object; an unexpected one is the safe sentence, logged under [ask tool]', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      await expect(exec(all, 'create_saved_view', { name: 'Lamps', search: {} })).resolves.toEqual({ error: { code: 'DUPLICATE_NAME', message: DUPLICATE_MESSAGE, retryable: false } });
      await expect(exec(all, 'delete_saved_view', { id: HEX_ID })).resolves.toEqual({ error: SAFE_TOOL_FAILURE });
      expect(error.mock.calls[0][0]).toBe('[ask tool]');
      expect(String(error.mock.calls[0][1])).toContain('delete_saved_view');
    });
  });
});

describe('the approval map and the resume runner (spec 2026-10-01 §3, §6)', () => {
  it('builds the user-approval map from the two allowances — list tools never need a card', () => {
    const none = toolApprovalFor({ allowChanges: false, allowDeletes: false });
    for (const name of LISTS) expect(none[name]).toBeUndefined();
    expect(sorted(Object.keys(none))).toEqual(sorted([...CHANGES, ...DELETES]));
    expect(new Set(Object.values(none))).toEqual(new Set(['user-approval']));
    expect(toolApprovalFor(null)).toEqual({});
    expect(sorted(Object.keys(toolApprovalFor({ allowChanges: true, allowDeletes: false })))).toEqual(sorted(DELETES));
    expect(sorted(Object.keys(toolApprovalFor({ allowChanges: false, allowDeletes: true })))).toEqual(sorted(CHANGES));
    expect(toolApprovalFor({ allowChanges: true, allowDeletes: true })).toEqual({});
  });
  it('fails closed: a write that writeKinds.ts does not classify yet always needs a card, whatever the allowances', () => {
    const defs = [...WORKSPACE_TOOLS, { name: 'export_everything', requiresConfirmation: true }, { name: 'list_everything', requiresConfirmation: false }];
    expect(toolApprovalFor({ allowChanges: true, allowDeletes: true }, defs)).toEqual({ export_everything: 'user-approval' });
    expect(sorted(Object.keys(toolApprovalFor({ allowChanges: false, allowDeletes: false }, defs)))).toEqual(sorted([...CHANGES, ...DELETES, 'export_everything']));
    expect(toolApprovalFor(null, defs)).toEqual({});
  });
  it('runWorkspaceTool validates the stored input against the tool schema before running it (the approval resume path)', async () => {
    await expect(runWorkspaceTool(workspace, actor, 'add_to_watchlist', { keywords: ['desk lamp'] })).resolves.toMatchObject({ added: 1 });
    // The schema's output reaches the service, not the stored input: the omitted searchTermIds arrives as its default.
    expect(workspace.addToWatchlist).toHaveBeenCalledExactlyOnceWith(actor, { keywords: ['desk lamp'], searchTermIds: [] });
  });
  it('runWorkspaceTool refuses, without calling the service, an input its schema rejects or a name that is not a workspace write, and logs each refusal by code — never the input or a raw name', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(runWorkspaceTool(workspace, actor, 'add_to_watchlist', { keywords: 'not-a-list' })).resolves.toEqual(INVALID);
    await expect(runWorkspaceTool(workspace, actor, 'search_keywords', {})).resolves.toEqual(INVALID);
    await expect(runWorkspaceTool(workspace, actor, 'list_saved_views', {})).resolves.toEqual(INVALID);
    expect(workspace.addToWatchlist).not.toHaveBeenCalled();
    expect(workspace.listSavedViews).not.toHaveBeenCalled();
    const refusal = (tool: string, reason: string) => ['[ask tool]', JSON.stringify({ outcome: 'resume_refused', tool, reason })];
    expect(warn.mock.calls).toEqual([refusal('add_to_watchlist', 'invalid_input'), refusal('unknown', 'not_a_write'), refusal('list_saved_views', 'not_a_write')]);
  });
  it('runWorkspaceTool never throws: a ResearchError is a result object, and anything else — even while the input is read — is the safe sentence', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(runWorkspaceTool(workspace, actor, 'create_saved_view', { name: 'Lamps', search: {} })).resolves.toEqual({ error: { code: 'DUPLICATE_NAME', message: DUPLICATE_MESSAGE, retryable: false } });
    await expect(runWorkspaceTool(workspace, actor, 'delete_saved_view', { id: HEX_ID })).resolves.toEqual({ error: SAFE_TOOL_FAILURE });
    expect(error.mock.calls[0][0]).toBe('[ask tool]');
    expect(String(error.mock.calls[0][1])).toContain('delete_saved_view');
    // safeParse runs inside the guard too: an input that throws while it is read is a result, never a rejection.
    const throwing = { get keywords() { throw new Error('boom'); } };
    await expect(runWorkspaceTool(workspace, actor, 'add_to_watchlist', throwing)).resolves.toEqual({ error: SAFE_TOOL_FAILURE });
    expect(workspace.addToWatchlist).not.toHaveBeenCalled();
  });
});
