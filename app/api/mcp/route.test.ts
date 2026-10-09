// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { DrizzleQueryError } from 'drizzle-orm';

const { mockAuth, mockFindFirst, mockDatasetWeek, envMock } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockFindFirst: vi.fn(),
  mockDatasetWeek: vi.fn(),
  envMock: {
    env: {
      APP_PUBLIC_URL: 'https://keywordquarry.com',
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: `pk_live_${Buffer.from('clerk.keywordquarry.com$').toString('base64')}`,
    } as Record<string, string | undefined>,
  },
}));
const { mockGetConnection, mockTouch } = vi.hoisted(() => ({ mockGetConnection: vi.fn(), mockTouch: vi.fn() }));
const { fakeService } = vi.hoisted(() => ({
  fakeService: {
    guide: vi.fn(async () => ({ guideVersion: 1, datasetWeek: '2026-09-12' })),
    resolveCategories: vi.fn(async () => ({ candidates: [], noMatch: true })),
    search: vi.fn(async () => ({ schemaVersion: 1, requestId: 'r1', rows: [], pagination: { nextCursor: null } })),
    details: vi.fn(async () => ({ status: 'dormant' })),
    history: vi.fn(async () => ({ points: [] })),
  },
}));
const { fakeWorkspace, mockDefaultWorkspaceService } = vi.hoisted(() => {
  const fakeWorkspace = {
    listSavedViews: vi.fn(async () => ({ views: [], count: 0, limit: 5 })),
    listCustomCategories: vi.fn(), listWatchlist: vi.fn(), createSavedView: vi.fn(), updateSavedView: vi.fn(), deleteSavedView: vi.fn(),
    createCustomCategory: vi.fn(), updateCustomCategory: vi.fn(), deleteCustomCategory: vi.fn(), addToWatchlist: vi.fn(), removeFromWatchlist: vi.fn(),
  };
  return { fakeWorkspace, mockDefaultWorkspaceService: vi.fn(() => fakeWorkspace) };
});

vi.mock('@clerk/nextjs/server', () => ({ auth: mockAuth }));
vi.mock('@/db/client', () => ({ db: { query: { users: { findFirst: mockFindFirst } } } }));
vi.mock('@/lib/mcp/datasetWeek', () => ({ currentDatasetWeek: mockDatasetWeek }));
vi.mock('@/lib/mcp/connections', () => ({ getMcpConnection: mockGetConnection, touchMcpConnection: mockTouch }));
vi.mock('@/lib/env', () => envMock);
vi.mock('@/lib/research/service', () => ({ defaultResearchService: () => fakeService }));
vi.mock('@/lib/workspace/service', () => ({ defaultWorkspaceService: mockDefaultWorkspaceService }));

import { GET, POST } from './route';

const URL_MCP = 'https://keywordquarry.com/api/mcp';
const SCOPE = 'keywordquarry:research:read';
const TOKEN = 'oat_test_token';

const clerkOauth = (over: Record<string, unknown> = {}) => ({
  isAuthenticated: true,
  tokenType: 'oauth_token',
  userId: 'user_clerk_1',
  clientId: 'client_claude',
  scopes: [SCOPE],
  ...over,
});
const adminRow = { id: 'uuid-admin', clerkUserId: 'user_clerk_1', email: 'owner@example.com', role: 'admin' };
const standardRow = { ...adminRow, id: 'uuid-std', email: 'member@example.com', role: 'standard_user' };

const initializeBody = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
});

function post(headers: Record<string, string> = {}) {
  return POST(
    new Request(URL_MCP, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: initializeBody,
    }),
  );
}

/** Routes the SDK client's HTTP calls straight into the route handlers. */
const fetchViaRoute = async (input: string | URL, init?: RequestInit): Promise<Response> => {
  const req = new Request(typeof input === 'string' ? input : input.toString(), init);
  if (req.method === 'POST') return POST(req);
  if (req.method === 'GET') return GET(req);
  return new Response(null, { status: 405 });
};

async function connect(token = TOKEN) {
  const client = new Client({ name: 'route-test', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(URL_MCP), {
    fetch: fetchViaRoute,
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

/** Like connect(), against a freshly imported route: for the describes that reset modules to change what handler.ts reads at load. */
async function connectFresh(name: string) {
  const route = await import('./route');
  const fetchFresh = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(typeof input === 'string' ? input : input.toString(), init);
    return req.method === 'POST' ? route.POST(req) : req.method === 'GET' ? route.GET(req) : new Response(null, { status: 405 });
  };
  const client = new Client({ name, version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(URL_MCP), { fetch: fetchFresh, requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } }));
  return client;
}

describe('/api/mcp', () => {
  const spies: ReturnType<typeof vi.spyOn>[] = [];
  const consoleLines = () => spies.flatMap((s) => s.mock.calls.map((c: unknown[]) => c.map(String).join(' ')));
  beforeEach(() => {
    vi.clearAllMocks();
    envMock.env.MCP_ENABLED = '1';
    delete envMock.env.MCP_AUDIENCE;
    delete envMock.env.MCP_ALLOWED_CLIENT_IDS;
    mockAuth.mockResolvedValue(clerkOauth());
    mockFindFirst.mockResolvedValue(adminRow);
    mockGetConnection.mockResolvedValue(null);
    mockDatasetWeek.mockResolvedValue('2026-09-12');
    for (const m of ['log', 'warn', 'error'] as const) spies.push(vi.spyOn(console, m).mockImplementation(() => {}));
  });
  afterEach(() => spies.splice(0).forEach((s) => s.mockRestore()));

  it('is a 404 for every method while MCP_ENABLED is not "1", before any token is looked at', async () => {
    delete envMock.env.MCP_ENABLED;
    expect((await post({ authorization: `Bearer ${TOKEN}` })).status).toBe(404);
    expect((await GET(new Request(URL_MCP))).status).toBe(404);
    expect(mockAuth).not.toHaveBeenCalled();
  });

  it('challenges a request without a token: 401 pointing at our resource metadata and scope', async () => {
    const res = await post();
    expect(res.status).toBe(401);
    const challenge = res.headers.get('www-authenticate') ?? '';
    expect(challenge).toMatch(/^Bearer /);
    expect(challenge).toContain('error="invalid_token"');
    expect(challenge).toContain(`scope="${SCOPE}"`);
    expect(challenge).toContain('resource_metadata="https://keywordquarry.com/.well-known/oauth-protected-resource/api/mcp"');
    expect((await res.json()).error).toBe('invalid_token');
    expect(mockAuth).not.toHaveBeenCalled();
  });

  it('derives the metadata URL in the challenge from configuration, not from forwarded headers', async () => {
    const res = await post({ 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'http' });
    expect(res.headers.get('www-authenticate')).toContain('resource_metadata="https://keywordquarry.com/');
  });

  it('answers 401 when Clerk rejects the token (a session JWT or cookie is never enough)', async () => {
    mockAuth.mockResolvedValueOnce(clerkOauth({ isAuthenticated: false, userId: null, clientId: null, scopes: null }));
    const res = await post({ authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });

  it('answers 403 insufficient_scope when the token lacks the research scope', async () => {
    mockAuth.mockResolvedValueOnce(clerkOauth({ scopes: ['profile'] }));
    const res = await post({ authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(403);
    expect(res.headers.get('www-authenticate')).toContain('error="insufficient_scope"');
    expect(res.headers.get('www-authenticate')).toContain(`scope="${SCOPE}"`);
  });

  it('refuses a standard user with a plain 403 (no re-auth challenge) while the audience is admin', async () => {
    mockFindFirst.mockResolvedValue(standardRow);
    const res = await post({ authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(403);
    expect(res.headers.get('www-authenticate')).toBeNull();
    expect(await res.json()).toEqual({
      error: 'access_denied',
      reason: 'admin_only',
      error_description: 'KeywordQuarry MCP access is limited to admin accounts during the beta.',
    });
  });

  it('refuses a login with no KeywordQuarry account with a 403 that says to sign in first', async () => {
    mockFindFirst.mockResolvedValue(undefined);
    const res = await post({ authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(403);
    expect((await res.json()).reason).toBe('no_account');
  });

  it('lets an admin connect, lists the eight read-only tools, and answers whoami with structured output', async () => {
    const client = await connect();
    try {
      expect(client.getServerVersion()?.name).toBe('keywordquarry');
      expect(client.getInstructions()).toContain('KeywordQuarry');

      const { tools } = await client.listTools();
      // The seven research tools (the two admin-only products tools included: the server is built once per process) and whoami.
      expect(tools.map((t) => t.name).sort()).toEqual([
        'get_keyword_details', 'get_keyword_history', 'get_product_details', 'get_research_guide', 'resolve_categories', 'search_keywords', 'search_products', 'whoami',
      ]);
      expect(tools[0].annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
      expect(client.getInstructions()).not.toContain('Workspace tools');
      expect(mockDefaultWorkspaceService).not.toHaveBeenCalled();

      const result = await client.callTool({ name: 'whoami', arguments: {} });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({
        ok: true,
        account: 'o***@example.com',
        datasetWeek: '2026-09-12',
        serverVersion: '0.1.0',
      });
      expect(result.content[0]).toMatchObject({ type: 'text' });
      expect((result.content[0] as { text: string }).text).toContain('o***@example.com');
      expect(mockAuth).toHaveBeenCalledWith({ acceptsToken: 'oauth_token' });
    } finally {
      await client.close().catch(() => {});
    }
  });

  it('runs a research tool with the gate-supplied actor', async () => {
    const client = await connect();
    try {
      const r = await client.callTool({ name: 'search_keywords', arguments: { schemaVersion: 1 } });
      expect(r.isError).toBeFalsy();
      expect(fakeService.search).toHaveBeenCalledWith(
        { localUserId: 'uuid-admin', clerkUserId: 'user_clerk_1', clientId: 'client_claude', channel: 'mcp', isAdmin: true },
        { schemaVersion: 1 },
      );
      expect(client.getInstructions()).toContain('get_research_guide');
    } finally {
      await client.close().catch(() => {});
    }
  });

  it('admits a standard user once MCP_AUDIENCE is all', async () => {
    envMock.env.MCP_AUDIENCE = 'all';
    mockFindFirst.mockResolvedValue(standardRow);
    const client = await connect();
    try {
      const result = await client.callTool({ name: 'whoami', arguments: {} });
      expect(result.structuredContent).toMatchObject({ ok: true, account: 'm***@example.com' });
    } finally {
      await client.close().catch(() => {});
    }
  });

  it('answers 503 (not a 401 challenge) when the account lookup fails, so clients keep their token', async () => {
    mockFindFirst.mockRejectedValueOnce(new Error('connect ETIMEDOUT'));
    const res = await post({ authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(503);
    expect(res.headers.get('www-authenticate')).toBeNull();
    expect(res.headers.get('retry-after')).toBe('30');
    expect((await res.json()).error).toBe('temporarily_unavailable');
  });

  it('refuses a client outside MCP_ALLOWED_CLIENT_IDS with a plain 403 before touching the database', async () => {
    envMock.env.MCP_ALLOWED_CLIENT_IDS = 'client_chatgpt';
    const res = await post({ authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(403);
    expect(res.headers.get('www-authenticate')).toBeNull();
    expect((await res.json()).reason).toBe('client_not_allowed');
    expect(mockFindFirst).not.toHaveBeenCalled();
  });

  it('admits a listed client', async () => {
    envMock.env.MCP_ALLOWED_CLIENT_IDS = 'client_chatgpt, client_claude';
    const client = await connect();
    try {
      expect((await client.callTool({ name: 'whoami', arguments: {} })).isError).toBeFalsy();
    } finally {
      await client.close().catch(() => {});
    }
  });

  it('answers 401 when Clerk itself throws, and no console method ever sees the token', async () => {
    mockAuth.mockRejectedValueOnce(new Error('clerk unreachable'));
    const res = await post({ authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(401);
    await post({ authorization: `Bearer ${TOKEN}` });
    expect(consoleLines().length).toBeGreaterThan(0);
    for (const line of consoleLines()) expect(line).not.toContain(TOKEN);
  });

  it('refuses a disconnected account with a plain 403 that points at the Connect AI page', async () => {
    mockGetConnection.mockResolvedValueOnce({ status: 'disconnected', lastRequestAt: null, lastClientId: null, disconnectedAt: new Date(), reconnectedAt: null });
    const res = await post({ authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(403);
    expect(res.headers.get('www-authenticate')).toBeNull();
    const body = await res.json();
    expect(body.reason).toBe('disconnected');
    expect(body.error_description).toContain('/connect-ai');
    expect(body.error_description).toContain('https://keywordquarry.com/connect-ai');
    expect(mockTouch).not.toHaveBeenCalled();
  });

  it('stamps last-seen for an admitted account with its local id and client id', async () => {
    const client = await connect();
    try {
      await client.callTool({ name: 'whoami', arguments: {} });
      expect(mockTouch).toHaveBeenCalledWith('uuid-admin', 'client_claude');
    } finally {
      await client.close().catch(() => {});
    }
  });

  it('answers 503 when the connection lookup itself fails', async () => {
    mockGetConnection.mockRejectedValueOnce(new Error('connect ETIMEDOUT'));
    const res = await post({ authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(503);
    expect(res.headers.get('www-authenticate')).toBeNull();
    expect(res.headers.get('retry-after')).toBe('30');
    expect((await res.json()).error).toBe('temporarily_unavailable');
  });

  it('logs a failed account or connection lookup by its log-safe fields only, never the query text or the bound params', async () => {
    // What production throws: drizzle-orm wraps the driver error in a DrizzleQueryError whose own message embeds the params.
    const dbError = () => new DrizzleQueryError('select "id" from "users" where "clerk_user_id" = $1', ['SECRET-PARAM'], Object.assign(new Error('Connection terminated unexpectedly'), { code: '08006' }));
    mockFindFirst.mockRejectedValueOnce(dbError());
    expect((await post({ authorization: `Bearer ${TOKEN}` })).status).toBe(503);
    mockGetConnection.mockRejectedValueOnce(dbError());
    expect((await post({ authorization: `Bearer ${TOKEN}` })).status).toBe(503);
    const failures = vi.mocked(console.error).mock.calls.filter((c) => c[0] === '[mcp auth]').map((c) => JSON.parse(String(c[1])));
    const safe = { clientId: 'client_claude', clerkUserId: 'user_clerk_1', error: 'Error', code: '08006', detail: 'Connection terminated unexpectedly' };
    expect(failures).toEqual([{ outcome: 'account_lookup_failed', ...safe }, { outcome: 'connection_lookup_failed', ...safe }]);
    for (const line of consoleLines()) {
      expect(line).not.toContain('SECRET-PARAM');
      expect(line).not.toContain('Failed query');
    }
  });
});

describe('/api/mcp with MCP_WRITE_ENABLED=1 (spec 2026-09-30 §2)', () => {
  const spies: Array<{ mockRestore(): void }> = [];
  beforeEach(() => {
    vi.clearAllMocks();
    // lib/mcp/handler.ts reads the flag and builds its instructions when the module loads, so
    // each test here re-imports the route (below) after setting the flag.
    vi.resetModules();
    envMock.env.MCP_ENABLED = '1';
    envMock.env.MCP_WRITE_ENABLED = '1';
    delete envMock.env.MCP_AUDIENCE;
    delete envMock.env.MCP_ALLOWED_CLIENT_IDS;
    mockAuth.mockResolvedValue(clerkOauth());
    mockFindFirst.mockResolvedValue(adminRow);
    mockGetConnection.mockResolvedValue(null);
    mockDatasetWeek.mockResolvedValue('2026-09-12');
    for (const m of ['log', 'warn', 'error'] as const) spies.push(vi.spyOn(console, m).mockImplementation(() => {}));
  });
  afterEach(() => {
    delete envMock.env.MCP_WRITE_ENABLED;
    spies.splice(0).forEach((s) => s.mockRestore());
  });

  it('lists the seven research tools, whoami and the eleven workspace tools, says so in the instructions, and runs a workspace tool with the gate-supplied actor', async () => {
    const client = await connectFresh('route-test-writes');
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(19);
      expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['list_saved_views', 'create_saved_view', 'delete_custom_category', 'remove_from_watchlist', 'whoami', 'search_keywords']));
      expect(client.getInstructions()).toContain('Workspace tools');
      const r = await client.callTool({ name: 'list_saved_views', arguments: {} });
      expect(r.isError).toBeFalsy();
      expect(fakeWorkspace.listSavedViews).toHaveBeenCalledWith({ localUserId: 'uuid-admin', clerkUserId: 'user_clerk_1', clientId: 'client_claude', channel: 'mcp', isAdmin: true }, {});
      expect(r.structuredContent).toEqual({ views: [], count: 0, limit: 5 });
    } finally {
      await client.close().catch(() => {});
    }
  });
});

describe('/api/mcp with MCP_WRITE_ENABLED=1 when the workspace service cannot be built (fail-soft)', () => {
  const spies: ReturnType<typeof vi.spyOn>[] = [];
  const consoleLines = () => spies.flatMap((s) => s.mock.calls.map((c: unknown[]) => c.map(String).join(' ')));
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules(); // as above: the route is re-imported per test
    envMock.env.MCP_ENABLED = '1';
    envMock.env.MCP_WRITE_ENABLED = '1';
    delete envMock.env.MCP_AUDIENCE;
    delete envMock.env.MCP_ALLOWED_CLIENT_IDS;
    mockAuth.mockResolvedValue(clerkOauth());
    mockFindFirst.mockResolvedValue(adminRow);
    mockGetConnection.mockResolvedValue(null);
    mockDatasetWeek.mockResolvedValue('2026-09-12');
    vi.doMock('@/lib/workspace/service', () => ({
      defaultWorkspaceService: () => {
        throw new DrizzleQueryError('select 1', ['SECRET-PARAM'], Object.assign(new Error('boom'), { code: '08006' }));
      },
    }));
    for (const m of ['log', 'warn', 'error'] as const) spies.push(vi.spyOn(console, m).mockImplementation(() => {}));
  });
  afterEach(() => {
    // Back to the file's hoisted fake for every later import (vi.doUnmock would drop the mock altogether).
    vi.doMock('@/lib/workspace/service', () => ({ defaultWorkspaceService: mockDefaultWorkspaceService }));
    delete envMock.env.MCP_WRITE_ENABLED;
    spies.splice(0).forEach((s) => s.mockRestore());
  });

  it('still lists whoami and the seven research tools, and logs the failure by its log-safe fields only', async () => {
    const client = await connectFresh('route-test-fail-soft');
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        'get_keyword_details', 'get_keyword_history', 'get_product_details', 'get_research_guide', 'resolve_categories', 'search_keywords', 'search_products', 'whoami',
      ]);
      const logged = vi.mocked(console.error).mock.calls.filter((c) => c[0] === '[mcp]').map((c) => JSON.parse(String(c[1])));
      expect(logged).toContainEqual({ outcome: 'workspace_tools_unavailable', error: 'Error', code: '08006', detail: 'boom' });
      for (const line of consoleLines()) expect(line).not.toContain('SECRET-PARAM');
    } finally {
      await client.close().catch(() => {});
    }
  });
});
