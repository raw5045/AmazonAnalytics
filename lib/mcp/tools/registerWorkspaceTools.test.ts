// lib/mcp/tools/registerWorkspaceTools.test.ts
// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
// Same stubs as registerResearchTools.test.ts: toolResult.ts imports lib/mcp/verifyMcpToken.ts,
// which imports @clerk/nextjs/server and @/db/client directly and (via ./config) @/lib/env, whose
// top-level parseEnv() throws outside a fully-configured environment. None of them run here (the
// test supplies its own actorFor), but the imports execute at module load.
vi.mock('@clerk/nextjs/server', () => ({ auth: vi.fn() }));
vi.mock('@/db/client', () => ({ db: {} }));
vi.mock('@/lib/env', () => ({ env: {} }));

import { McpServer } from '@modelcontextprotocol/server';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { registerWorkspaceTools } from './registerWorkspaceTools';
import { DEFAULT_LIMITS } from '@/lib/research/limits';
import { ResearchError } from '@/lib/research/errors';
import type { ResearchActor } from '@/lib/research/service';
import { WORKSPACE_TOOLS } from '@/lib/workspace/tools';
import { WORKSPACE_TOOL_NAMES, type WorkspaceService } from '@/lib/workspace/contracts';

const actor: ResearchActor = { localUserId: 'u1', clerkUserId: 'user_1', clientId: 'client_claude', channel: 'mcp' };
const service = {
  listSavedViews: vi.fn(async () => ({ views: [], count: 0, limit: 5 })),
  listCustomCategories: vi.fn(async () => ({ categories: [], count: 0, limit: 25 })),
  listWatchlist: vi.fn(async () => ({ items: [], count: 0, limit: 100 })),
  createSavedView: vi.fn(async () => { throw new ResearchError('DUPLICATE_NAME', 'You already have a view named "Lamps". Choose a different name or update the existing one.'); }),
  updateSavedView: vi.fn(), deleteSavedView: vi.fn(), createCustomCategory: vi.fn(), updateCustomCategory: vi.fn(), deleteCustomCategory: vi.fn(),
  addToWatchlist: vi.fn(async () => ({ added: 1, alreadyWatching: 0, unmatched: [], skippedAtCap: 0, watching: 1, limit: 100 })),
  removeFromWatchlist: vi.fn(),
} as unknown as WorkspaceService;

describe('workspace tools over an in-memory MCP connection', () => {
  const client = new Client({ name: 'test', version: '0' });
  const server = new McpServer({ name: 'keywordquarry-test', version: '0' });
  beforeAll(async () => {
    registerWorkspaceTools(server, service, { actorFor: () => actor, limits: DEFAULT_LIMITS });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });
  afterAll(async () => {
    await client.close();
    await server.close();
  });

  it('lists exactly the eleven tools with the shared module\'s names, titles, descriptions and annotations', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([...WORKSPACE_TOOL_NAMES]);
    expect(tools.map((t) => [t.name, t.title, t.description, t.annotations])).toEqual(WORKSPACE_TOOLS.map((d) => [d.name, d.title, d.description(DEFAULT_LIMITS), d.annotations]));
    expect(tools.find((t) => t.name === 'list_saved_views')!.annotations).toMatchObject({ readOnlyHint: true });
    expect(tools.find((t) => t.name === 'delete_saved_view')!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    const create = tools.find((t) => t.name === 'create_saved_view')!.inputSchema as unknown as { properties: Record<string, unknown>; additionalProperties: unknown };
    expect(Object.keys(create.properties).sort()).toEqual(['name', 'search']);
    expect(create.additionalProperties).toBe(false);
  });

  it('calls the service with the gate-supplied actor and returns structured content', async () => {
    const r = await client.callTool({ name: 'add_to_watchlist', arguments: { keywords: ['desk lamp'] } });
    expect(r.isError).toBeFalsy();
    expect(service.addToWatchlist).toHaveBeenCalledWith(actor, { keywords: ['desk lamp'], searchTermIds: [] });
    expect(r.structuredContent).toMatchObject({ added: 1, watching: 1 });
  });

  it('maps a ResearchError to an MCP tool error with its code and message', async () => {
    const r = await client.callTool({ name: 'create_saved_view', arguments: { name: 'Lamps', search: {} } });
    expect(r.isError).toBe(true);
    expect(JSON.parse((r.content[0] as { text: string }).text)).toEqual({ error: { code: 'DUPLICATE_NAME', message: 'You already have a view named "Lamps". Choose a different name or update the existing one.', retryable: false } });
  });

  it('rejects a schema-invalid call via the SDK before the service ever runs', async () => {
    // Counted from here, so the assertion holds whichever order the tests run in (the DUPLICATE_NAME test also calls it).
    const before = vi.mocked(service.createSavedView).mock.calls.length;
    const r = await client.callTool({ name: 'delete_saved_view', arguments: { id: 'nope' } });
    expect(r.isError).toBe(true);
    expect(service.deleteSavedView).not.toHaveBeenCalled();
    const cursor = await client.callTool({ name: 'create_saved_view', arguments: { name: 'x', search: { cursor: 'c'.repeat(20) } } });
    expect(cursor.isError).toBe(true);
    expect(service.createSavedView).toHaveBeenCalledTimes(before);
  });
});
