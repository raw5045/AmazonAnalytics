import { describe, it, expect, vi, afterEach } from 'vitest';
vi.mock('@/lib/env', () => ({ env: {} }));
import { buildAskTools, runWorkspaceTool, toolApprovalFor } from './tools';
import { ResearchError } from '@/lib/research/errors';
import { DEFAULT_LIMITS } from '@/lib/research/limits';
import { SAFE_TOOL_FAILURE } from '@/lib/research/toolErrors';
import type { ResearchActor, ResearchService } from '@/lib/research/service';
import { WORKSPACE_TOOL_NAMES, type WorkspaceService } from '@/lib/workspace/contracts';
import { WORKSPACE_TOOLS } from '@/lib/workspace/tools';

const actor: ResearchActor = { localUserId: 'u1', clerkUserId: 'user_1', clientId: 'ask-ai', channel: 'chat' };
const service = {
  guide: vi.fn(async () => ({ guideVersion: 1 })),
  resolveCategories: vi.fn(async () => ({ candidates: [] })),
  search: vi.fn(async () => { throw new ResearchError('RATE_LIMITED', 'Rate limit reached', { retryable: true, retryAfterSeconds: 9 }); }),
  details: vi.fn(async () => { throw new Error('pg: connection reset'); }),
  history: vi.fn(async () => ({ points: [] })),
} as unknown as ResearchService;
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
const CHANGES = ['create_saved_view', 'update_saved_view', 'create_custom_category', 'update_custom_category', 'add_to_watchlist', 'remove_from_watchlist'];
const DELETES = ['delete_saved_view', 'delete_custom_category'];
const LISTS = ['list_saved_views', 'list_custom_categories', 'list_watchlist'];
const sorted = (names: ReadonlyArray<string>) => [...names].sort();

const exec = (t: ReturnType<typeof buildAskTools>, name: string, args: unknown) => (t[name] as { execute: (a: unknown, o: unknown) => Promise<unknown> }).execute(args, { toolCallId: 't1', messages: [] });

afterEach(() => vi.restoreAllMocks());

describe('buildAskTools', () => {
  const tools = buildAskTools(service, actor, DEFAULT_LIMITS);

  it('without a workspace service (the flag off) exposes exactly the five research tools with their descriptions — byte-for-byte today\'s chat (spec 2026-10-01 §2)', () => {
    expect(Object.keys(tools)).toEqual(RESEARCH);
    expect((tools.search_keywords as { description?: string }).description).toContain('Search current Amazon keywords');
    for (const name of WORKSPACE_TOOL_NAMES) expect(tools[name]).toBeUndefined();
    expect(Object.keys(buildAskTools(service, actor, DEFAULT_LIMITS, null))).toEqual(RESEARCH);
  });
  it('runs the service with the bound actor', async () => {
    await expect(exec(tools, 'get_research_guide', {})).resolves.toEqual({ guideVersion: 1 });
    expect(service.guide).toHaveBeenCalledWith(actor);
    await expect(exec(tools, 'get_keyword_history', { searchTermId: 'x', weeks: 4 })).resolves.toEqual({ points: [] });
    expect(service.history).toHaveBeenCalledWith(actor, { searchTermId: 'x', weeks: 4 });
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

  describe('with a workspace service (the flag on)', () => {
    const all = buildAskTools(service, actor, DEFAULT_LIMITS, workspace);

    it('exposes the five research tools followed by the eleven workspace tools, with the shared descriptions and schemas', () => {
      expect(Object.keys(all)).toEqual([...RESEARCH, ...WORKSPACE_TOOL_NAMES]);
      for (const d of WORKSPACE_TOOLS) {
        const t = all[d.name] as { description?: string; inputSchema?: unknown };
        expect(t.description).toBe(d.description(DEFAULT_LIMITS));
        // The very schema object the MCP registers, so the SDK rejects a bad or hallucinated key the same way.
        expect(t.inputSchema).toBe(d.inputSchema);
      }
    });
    it('runs a workspace tool with the bound actor and the SDK-parsed input', async () => {
      await expect(exec(all, 'add_to_watchlist', { keywords: ['desk lamp'], searchTermIds: [] })).resolves.toMatchObject({ added: 1 });
      expect(workspace.addToWatchlist).toHaveBeenCalledWith(actor, { keywords: ['desk lamp'], searchTermIds: [] });
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
  it('runWorkspaceTool validates the stored input against the tool schema before running it (the approval resume path)', async () => {
    await expect(runWorkspaceTool(workspace, actor, 'add_to_watchlist', { keywords: ['desk lamp'] })).resolves.toMatchObject({ added: 1 });
    // The schema's output reaches the service, not the stored input: the omitted searchTermIds arrives as its default.
    expect(workspace.addToWatchlist).toHaveBeenLastCalledWith(actor, { keywords: ['desk lamp'], searchTermIds: [] });
  });
  it('runWorkspaceTool refuses, without calling the service, an input its schema rejects or a name that is not a workspace write', async () => {
    vi.mocked(workspace.addToWatchlist).mockClear();
    vi.mocked(workspace.listSavedViews).mockClear();
    await expect(runWorkspaceTool(workspace, actor, 'add_to_watchlist', { keywords: 'not-a-list' })).resolves.toEqual(INVALID);
    await expect(runWorkspaceTool(workspace, actor, 'search_keywords', {})).resolves.toEqual(INVALID);
    await expect(runWorkspaceTool(workspace, actor, 'list_saved_views', {})).resolves.toEqual(INVALID);
    expect(workspace.addToWatchlist).not.toHaveBeenCalled();
    expect(workspace.listSavedViews).not.toHaveBeenCalled();
  });
  it('runWorkspaceTool reports a failure as the live tools do: a ResearchError as a result object, anything else as the safe sentence', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(runWorkspaceTool(workspace, actor, 'create_saved_view', { name: 'Lamps', search: {} })).resolves.toEqual({ error: { code: 'DUPLICATE_NAME', message: DUPLICATE_MESSAGE, retryable: false } });
    await expect(runWorkspaceTool(workspace, actor, 'delete_saved_view', { id: HEX_ID })).resolves.toEqual({ error: SAFE_TOOL_FAILURE });
    expect(error.mock.calls[0][0]).toBe('[ask tool]');
    expect(String(error.mock.calls[0][1])).toContain('delete_saved_view');
  });
});
