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
  });

  it('refuses cross-site posts, unknown actions, and ineligible accounts', async () => {
    expect((await post({ action: 'disconnect' }, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await post({ action: 'explode' })).status).toBe(400);

    mockRequireUser.mockResolvedValue({ ...admin, role: 'standard_user' });
    expect((await post({ action: 'disconnect' })).status).toBe(404);
    expect((await GET()).status).toBe(404);
    expect(mockSet).not.toHaveBeenCalled();
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
});
