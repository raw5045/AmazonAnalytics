import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockAuth, mockFindFirst } = vi.hoisted(() => ({ mockAuth: vi.fn(), mockFindFirst: vi.fn() }));
vi.mock('@clerk/nextjs/server', () => ({ auth: mockAuth }));
vi.mock('@/db/client', () => ({ db: { query: { users: { findFirst: mockFindFirst } } } }));
vi.mock('@/lib/env', () => ({ env: {} }));

import {
  authorizeMcpAccount,
  authorizeMcpClient,
  mcpAuthExtra,
  resolveMcpAccount,
  verifyMcpToken,
} from './verifyMcpToken';
import { MCP_SCOPE } from './config';

const TOKEN = 'oat_secret_token_value_123';
const req = () => new Request('https://keywordquarry.com/api/mcp', { method: 'POST' });
const clerkOauth = (over: Record<string, unknown> = {}) => ({
  isAuthenticated: true,
  tokenType: 'oauth_token',
  userId: 'user_clerk_1',
  clientId: 'client_claude',
  scopes: [MCP_SCOPE, 'profile'],
  ...over,
});
const admin = { localUserId: 'uuid-admin', role: 'admin' as const, email: 'owner@example.com' };
const standard = { localUserId: 'uuid-std', role: 'standard_user' as const, email: 'member@example.com' };

describe('verifyMcpToken', () => {
  const spies: ReturnType<typeof vi.spyOn>[] = [];
  const consoleLines = () => spies.flatMap((s) => s.mock.calls.map((c: unknown[]) => c.map(String).join(' ')));
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue(clerkOauth());
    for (const m of ['log', 'warn', 'error'] as const) spies.push(vi.spyOn(console, m).mockImplementation(() => {}));
  });
  afterEach(() => spies.splice(0).forEach((s) => s.mockRestore()));

  it('returns undefined without a bearer token and never asks Clerk', async () => {
    expect(await verifyMcpToken(req(), undefined)).toBeUndefined();
    expect(mockAuth).not.toHaveBeenCalled();
  });

  it('asks Clerk to verify the token as an OAuth access token only', async () => {
    await verifyMcpToken(req(), TOKEN);
    expect(mockAuth).toHaveBeenCalledWith({ acceptsToken: 'oauth_token' });
  });

  it('returns undefined when Clerk does not authenticate the token', async () => {
    mockAuth.mockResolvedValueOnce(clerkOauth({ isAuthenticated: false, userId: null, clientId: null, scopes: null }));
    expect(await verifyMcpToken(req(), TOKEN)).toBeUndefined();
  });

  it('returns undefined for a token of another type (e.g. a session JWT)', async () => {
    mockAuth.mockResolvedValueOnce({ isAuthenticated: true, tokenType: 'session_token', userId: 'user_clerk_1' });
    expect(await verifyMcpToken(req(), TOKEN)).toBeUndefined();
  });

  it('returns the scopes as issued when the research scope is missing, so the wrapper can answer 403', async () => {
    mockAuth.mockResolvedValueOnce(clerkOauth({ scopes: ['profile', 'email'] }));
    expect(await verifyMcpToken(req(), TOKEN)).toEqual({ token: TOKEN, clientId: 'client_claude', scopes: ['profile', 'email'] });
  });

  it('returns token facts plus the Clerk user id, and never touches the database', async () => {
    expect(await verifyMcpToken(req(), TOKEN)).toEqual({
      token: TOKEN,
      clientId: 'client_claude',
      scopes: [MCP_SCOPE, 'profile'],
      extra: { clerkUserId: 'user_clerk_1', account: null },
    });
    expect(mockFindFirst).not.toHaveBeenCalled();
  });

  it('logs one structured line per outcome, and no console method ever sees the token', async () => {
    await verifyMcpToken(req(), undefined);
    mockAuth.mockResolvedValueOnce(clerkOauth({ isAuthenticated: false, userId: null, clientId: null, scopes: null }));
    await verifyMcpToken(req(), TOKEN);
    await verifyMcpToken(req(), TOKEN);
    const lines = consoleLines();
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line).toContain('[mcp auth]');
      expect(line).not.toContain(TOKEN);
      expect(line).not.toContain('secret');
    }
    expect(lines[2]).toContain('"outcome":"ok"');
  });
});

describe('resolveMcpAccount', () => {
  beforeEach(() => vi.clearAllMocks());

  it('maps the users row for the Clerk user id to the account block', async () => {
    mockFindFirst.mockResolvedValueOnce({ id: 'uuid-admin', clerkUserId: 'user_clerk_1', email: 'owner@example.com', role: 'admin' });
    expect(await resolveMcpAccount('user_clerk_1')).toEqual(admin);
    expect(mockFindFirst).toHaveBeenCalledTimes(1);
  });

  it('returns null when no row exists', async () => {
    mockFindFirst.mockResolvedValueOnce(undefined);
    expect(await resolveMcpAccount('user_clerk_1')).toBeNull();
  });

  it('lets a database failure propagate for the gate to answer 503', async () => {
    mockFindFirst.mockRejectedValueOnce(new Error('connect ETIMEDOUT'));
    await expect(resolveMcpAccount('user_clerk_1')).rejects.toThrow('ETIMEDOUT');
  });
});

describe('mcpAuthExtra', () => {
  const info = (extra: unknown) => ({ token: 't', clientId: 'c', scopes: [], extra: extra as Record<string, unknown> });
  it('reads the block back, or null when absent or malformed', () => {
    expect(mcpAuthExtra(info({ clerkUserId: 'u', account: admin }))).toEqual({ clerkUserId: 'u', account: admin });
    expect(mcpAuthExtra(info({ clerkUserId: 'u', account: null }))).toEqual({ clerkUserId: 'u', account: null });
    expect(mcpAuthExtra(info({ clerkUserId: 'u' }))).toEqual({ clerkUserId: 'u', account: null });
    expect(mcpAuthExtra(info({ clerkUserId: 'u', account: { ...admin, role: 'root' } }))).toEqual({ clerkUserId: 'u', account: null });
    expect(mcpAuthExtra(info({ clerkUserId: 42 }))).toBeNull();
    expect(mcpAuthExtra({ token: 't', clientId: 'c', scopes: [] })).toBeNull();
    expect(mcpAuthExtra(undefined)).toBeNull();
  });
});

describe('authorizeMcpClient', () => {
  it('admits any client while the allowlist is empty', () => {
    expect(authorizeMcpClient('client_x', [])).toBeNull();
  });
  it('admits a listed client and denies an unlisted one', () => {
    expect(authorizeMcpClient('client_claude', ['client_chatgpt', 'client_claude'])).toBeNull();
    expect(authorizeMcpClient('client_x', ['client_chatgpt'])?.reason).toBe('client_not_allowed');
  });
});

describe('authorizeMcpAccount', () => {
  it('denies a login with no KeywordQuarry account, whatever the audience', () => {
    expect(authorizeMcpAccount(null, 'admin')?.reason).toBe('no_account');
    expect(authorizeMcpAccount(null, 'all')?.reason).toBe('no_account');
  });
  it('limits the admin audience to admin accounts', () => {
    expect(authorizeMcpAccount(standard, 'admin')?.reason).toBe('admin_only');
    expect(authorizeMcpAccount(admin, 'admin')).toBeNull();
  });
  it('admits every account under the all audience', () => {
    expect(authorizeMcpAccount(standard, 'all')).toBeNull();
    expect(authorizeMcpAccount(admin, 'all')).toBeNull();
  });
  it('explains each denial in plain words the client can show', () => {
    expect(authorizeMcpAccount(null, 'all')?.message).toMatch(/sign in at keywordquarry\.com/i);
    expect(authorizeMcpAccount(standard, 'admin')?.message).toMatch(/admin accounts/i);
    expect(authorizeMcpClient('x', ['y'])?.message).toMatch(/not allowed/i);
  });
});
