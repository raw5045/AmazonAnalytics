import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockRequireUser, mockSend, mockBump, AuthErrorMock } = vi.hoisted(() => ({
  mockRequireUser: vi.fn(),
  mockSend: vi.fn(),
  mockBump: vi.fn().mockResolvedValue(undefined),
  AuthErrorMock: class extends Error {
    constructor(
      public code: 'UNAUTHENTICATED' | 'FORBIDDEN',
      msg: string,
    ) {
      super(msg);
    }
  },
}));

vi.mock('@/lib/auth/requireAuthenticatedUser', () => ({ requireAuthenticatedUser: mockRequireUser }));
vi.mock('@/lib/auth/requireAdmin', () => ({ AuthError: AuthErrorMock }));
vi.mock('@/lib/notifications/sendFeedbackEmail', () => ({ sendFeedbackEmail: mockSend }));
vi.mock('@/lib/activity/bump', () => ({ bumpAppActivity: mockBump }));

import { POST } from './route';

const user = { id: 'uuid-1', email: 'jane@example.com', name: 'Jane Doe', role: 'standard_user' };

function makeRequest(body: unknown, raw = false) {
  return new Request('http://localhost/api/feedback', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw ? (body as string) : JSON.stringify(body),
  });
}

describe('POST /api/feedback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireUser.mockResolvedValue(user);
    vi.stubEnv('APP_PUBLIC_URL', 'https://test.example');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('returns 401 when not signed in', async () => {
    mockRequireUser.mockRejectedValueOnce(new AuthErrorMock('UNAUTHENTICATED', 'Not signed in'));
    const res = await POST(makeRequest({ message: 'A perfectly fine message.' }));
    expect(res.status).toBe(401);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('returns 400 on a short message and on a malformed body', async () => {
    expect((await POST(makeRequest({ message: 'short' }))).status).toBe(400);
    expect((await POST(makeRequest('{not json', true))).status).toBe(400);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('returns 503 and does not bump the counter when the sender fails', async () => {
    mockSend.mockResolvedValueOnce({ sent: false, reason: 'send failed' });
    const res = await POST(makeRequest({ message: 'A perfectly fine message.', page: '/explorer' }));
    expect(res.status).toBe(503);
    expect(mockBump).not.toHaveBeenCalled();
  });

  it('sends with the account identity, validated page, and app URL, then bumps the counter', async () => {
    mockSend.mockResolvedValueOnce({ sent: true });
    const res = await POST(
      makeRequest({ message: '  A perfectly fine message.  ', page: '/explorer?rank_max=100' }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mockSend).toHaveBeenCalledWith({
      message: 'A perfectly fine message.',
      page: '/explorer?rank_max=100',
      user: { id: 'uuid-1', email: 'jane@example.com', name: 'Jane Doe' },
      appUrl: 'https://test.example',
    });
    expect(mockBump).toHaveBeenCalledWith('feedback_submission');
  });

  it('nulls an off-site page instead of rejecting the message', async () => {
    mockSend.mockResolvedValueOnce({ sent: true });
    const res = await POST(makeRequest({ message: 'A perfectly fine message.', page: 'https://evil.example' }));
    expect(res.status).toBe(200);
    expect(mockSend.mock.calls[0][0].page).toBeNull();
  });
});
