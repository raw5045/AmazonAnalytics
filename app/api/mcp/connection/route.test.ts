import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRequireUser, mockGet, mockSet, envMock } = vi.hoisted(() => ({
  mockRequireUser: vi.fn(),
  mockGet: vi.fn(),
  mockSet: vi.fn(),
  envMock: {
    env: { APP_PUBLIC_URL: 'https://keywordquarry.com', NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_test_x' } as Record<
      string,
      string | undefined
    >,
  },
}));
vi.mock('@/lib/auth/requireAuthenticatedUser', () => ({ requireAuthenticatedUser: mockRequireUser }));
vi.mock('@/lib/mcp/connections', () => ({ getMcpConnection: mockGet, setMcpConnectionStatus: mockSet }));
vi.mock('@/lib/env', () => envMock);

import { GET, POST } from './route';
import { AuthError } from '@/lib/auth/AuthError';

const admin = { id: 'u1', role: 'admin', email: 'a@b.c' };
const post = (body: unknown, headers: Record<string, string> = {}) =>
  POST(
    new Request('http://localhost/api/mcp/connection', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...headers },
      body: JSON.stringify(body),
    }),
  );

describe('/api/mcp/connection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireUser.mockResolvedValue(admin);
    mockGet.mockResolvedValue(null);
    delete envMock.env.MCP_AUDIENCE;
    // M-5: MCP_ENABLED is live in production (Task 22 Step 3's ordering note) — default it on
    // here so every other test below exercises the route's real logic; the kill-switch test
    // further down unsets/zeros it explicitly.
    envMock.env.MCP_ENABLED = '1';
  });

  it('GET reports the status (never-connected reads as enabled) with no-store', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ status: 'enabled', connectedOnce: false, lastRequestAt: null, lastClientId: null });
  });

  it('POST disconnect and reconnect flip the record', async () => {
    mockSet.mockResolvedValueOnce({ status: 'disconnected' });
    expect(await (await post({ action: 'disconnect' })).json()).toEqual({ status: 'disconnected' });
    expect(mockSet).toHaveBeenCalledWith('u1', 'disconnected');

    mockSet.mockResolvedValueOnce({ status: 'enabled' });
    expect(await (await post({ action: 'reconnect' })).json()).toEqual({ status: 'enabled' });
    expect(mockSet).toHaveBeenLastCalledWith('u1', 'enabled');
  });

  it('refuses cross-site posts, unknown actions, and ineligible accounts', async () => {
    expect((await post({ action: 'disconnect' }, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await post({ action: 'explode' })).status).toBe(400);

    mockRequireUser.mockResolvedValue({ ...admin, role: 'standard_user' });
    expect((await post({ action: 'disconnect' })).status).toBe(404);
    expect((await GET()).status).toBe(404);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('rejects a null body and a non-JSON body with 400', async () => {
    expect((await post(null)).status).toBe(400);

    const res = await POST(
      new Request('http://localhost/api/mcp/connection', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
        body: 'not json',
      }),
    );
    expect(res.status).toBe(400);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('allows a POST with no sec-fetch-site header (plain same-origin requests may omit it)', async () => {
    mockSet.mockResolvedValueOnce({ status: 'disconnected' });
    const res = await POST(
      new Request('http://localhost/api/mcp/connection', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'disconnect' }),
      }),
    );
    expect(res.status).toBe(200);
  });

  it('allows sec-fetch-site: none (e.g. a typed URL or bookmark)', async () => {
    mockSet.mockResolvedValueOnce({ status: 'disconnected' });
    expect((await post({ action: 'disconnect' }, { 'sec-fetch-site': 'none' })).status).toBe(200);
  });

  it('a standard_user gets 200 on GET once the audience is all', async () => {
    envMock.env.MCP_AUDIENCE = 'all';
    mockRequireUser.mockResolvedValue({ ...admin, role: 'standard_user' });
    expect((await GET()).status).toBe(200);
  });

  it('an unauthenticated caller gets 401', async () => {
    mockRequireUser.mockRejectedValue(new AuthError('UNAUTHENTICATED', 'Not signed in'));
    expect((await GET()).status).toBe(401);
  });

  it('a FORBIDDEN AuthError maps to 403', async () => {
    mockRequireUser.mockRejectedValue(new AuthError('FORBIDDEN', 'Not allowed'));
    expect((await GET()).status).toBe(403);
  });

  it('M-5: the kill switch 404s both handlers when MCP_ENABLED is unset or "0", before touching auth or the DB', async () => {
    delete envMock.env.MCP_ENABLED;
    expect((await GET()).status).toBe(404);
    expect((await post({ action: 'disconnect' })).status).toBe(404);

    envMock.env.MCP_ENABLED = '0';
    expect((await GET()).status).toBe(404);
    expect((await post({ action: 'disconnect' })).status).toBe(404);

    expect(mockRequireUser).not.toHaveBeenCalled();
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockSet).not.toHaveBeenCalled();
  });
});
