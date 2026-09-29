// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
const envMock = vi.hoisted(() => ({ env: { APP_PUBLIC_URL: 'https://keywordquarry.com', ASK_AI_ENABLED: '1' } as Record<string, string | undefined> }));
vi.mock('@/lib/env', () => envMock);
vi.mock('@clerk/nextjs/server', () => ({ auth: vi.fn() }));
vi.mock('@/db/client', () => ({ db: { execute: vi.fn() } }));
const auth = vi.hoisted(() => ({ user: null as null | { id: string; role: 'admin' | 'standard_user' } }));
vi.mock('@/lib/auth/requireAuthenticatedUser', () => ({
  requireAuthenticatedUser: async () => {
    if (!auth.user) { const { AuthError } = await import('@/lib/auth/AuthError'); throw new AuthError('UNAUTHENTICATED', 'Not signed in'); }
    return auth.user;
  },
}));
const ledger = vi.hoisted(() => ({ getAccount: vi.fn() }));
vi.mock('@/lib/ask/ledger', () => ledger);
const conv = vi.hoisted(() => ({ deleteConversation: vi.fn() }));
vi.mock('@/lib/ask/conversations', () => conv);
import { DELETE } from './route';

const id = '11111111-1111-4111-8111-111111111111';
const del = (target = id, h: Record<string, string> = { origin: 'https://keywordquarry.com', 'sec-fetch-site': 'same-origin' }) =>
  DELETE(new Request(`https://keywordquarry.com/api/ask/conversations/${target}`, { method: 'DELETE', headers: h }), { params: Promise.resolve({ id: target }) });

describe('DELETE /api/ask/conversations/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envMock.env = { APP_PUBLIC_URL: 'https://keywordquarry.com', ASK_AI_ENABLED: '1' };
    auth.user = { id: 'u1', role: 'standard_user' };
    ledger.getAccount.mockResolvedValue({ access: true });
    conv.deleteConversation.mockResolvedValue('deleted');
  });
  it('deletes an owned idle chat (204), refuses a busy one (409 with the message), and 404s an unknown one', async () => {
    expect((await del()).status).toBe(204);
    expect(conv.deleteConversation).toHaveBeenCalledWith('u1', id);
    conv.deleteConversation.mockResolvedValueOnce('busy');
    const busy = await del();
    expect(busy.status).toBe(409);
    expect(await busy.json()).toEqual({ error: 'Wait for the current answer to finish.', code: 'busy' });
    conv.deleteConversation.mockResolvedValueOnce('missing');
    expect((await del()).status).toBe(404);
  });
  it('is dark when disabled, 403 cross-site, 401 unauthenticated, 404 for an ineligible member, 400 for a non-uuid', async () => {
    envMock.env.ASK_AI_ENABLED = undefined;
    expect((await del()).status).toBe(404);
    envMock.env.ASK_AI_ENABLED = '1';
    expect((await del(id, { origin: 'https://evil.example' })).status).toBe(403);
    auth.user = null;
    expect((await del()).status).toBe(401);
    auth.user = { id: 'u1', role: 'standard_user' };
    ledger.getAccount.mockResolvedValueOnce({ access: false });
    expect((await del()).status).toBe(404);
    expect((await del('not-a-uuid')).status).toBe(400);
  });
  it('checks the id shape before touching the database: a non-uuid never calls getAccount or deleteConversation', async () => {
    const res = await del('not-a-uuid');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Bad request.', code: 'bad_request' });
    expect(ledger.getAccount).not.toHaveBeenCalled();
    expect(conv.deleteConversation).not.toHaveBeenCalled();
  });
});
