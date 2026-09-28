// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
const envMock = vi.hoisted(() => ({ env: { APP_PUBLIC_URL: 'https://keywordquarry.com', ASK_AI_ENABLED: '1', ANTHROPIC_API_KEY: 'sk-ant-test', DATABASE_URL: 'postgres://test' } as Record<string, string | undefined> }));
vi.mock('@/lib/env', () => envMock);
vi.mock('@clerk/nextjs/server', () => ({ auth: vi.fn() }));
vi.mock('@/db/client', () => ({ db: { execute: vi.fn() } }));
const auth = vi.hoisted(() => ({ user: null as null | { id: string; role: 'admin' | 'standard_user'; clerkUserId: string; email: string } }));
vi.mock('@/lib/auth/requireAuthenticatedUser', () => ({
  requireAuthenticatedUser: async () => {
    if (!auth.user) { const { AuthError } = await import('@/lib/auth/AuthError'); throw new AuthError('UNAUTHENTICATED', 'Not signed in'); }
    return auth.user;
  },
}));
const gates = vi.hoisted(() => ({ runGates: vi.fn() }));
vi.mock('@/lib/ask/gates', () => gates);
const conv = vi.hoisted(() => ({
  createConversationWithFirstMessage: vi.fn(), loadConversation: vi.fn(), appendUserMessage: vi.fn(), appendAssistantMessage: vi.fn(),
  acquireTurnLock: vi.fn(), releaseTurnLock: vi.fn(),
}));
vi.mock('@/lib/ask/conversations', () => conv);
const turn = vi.hoisted(() => ({ runTurn: vi.fn(), windowHistory: (h: unknown[]) => h }));
vi.mock('@/lib/ask/turn', () => turn);
const ledger = vi.hoisted(() => ({ settleTurn: vi.fn() }));
vi.mock('@/lib/ask/ledger', () => ledger);
vi.mock('@/lib/ask/tools', () => ({ buildAskTools: () => ({}) }));
vi.mock('@/lib/ask/prompt', () => ({ buildSystemPrompt: () => 'sys' }));
vi.mock('@/lib/research/service', () => ({ defaultResearchService: () => ({}) }));
const snapshot = vi.hoisted(() => ({ loadSnapshotMetaHttp: vi.fn(async () => ({ currentWeekEndDate: '2026-09-19' })) }));
vi.mock('@/lib/research/snapshot', () => snapshot);
vi.mock('@/lib/research/catalog', () => ({ buildGuide: () => ({ guideVersion: 1 }) }));
vi.mock('@/lib/research/limits', () => ({ researchLimits: () => ({}) }));
vi.mock('@/lib/mcp/config', () => ({ mcpAudience: () => 'all' }));
vi.mock('@/lib/activity/bump', () => ({ bumpUserActivity: vi.fn(async () => {}) }));
vi.mock('@ai-sdk/anthropic', () => ({ createAnthropic: () => (id: string) => ({ modelId: id }) }));
vi.mock('@/lib/ask/alerts', () => ({ maybeAlertCeiling: vi.fn(async () => {}) }));
import { POST } from './route';

const member = { id: 'u1', role: 'standard_user' as const, clerkUserId: 'user_1', email: 'm@example.com' };
const account = { userId: 'u1', access: true, monthlyAllowanceMicro: 10_000_000, allowanceUsedMicro: 0, periodStart: '2026-09-01', creditMicro: 0, conversationCount: 0 };
const headers = { 'content-type': 'application/json', origin: 'https://keywordquarry.com', 'sec-fetch-site': 'same-origin' };
const post = (body: unknown, h: Record<string, string> = headers) => POST(new Request('https://keywordquarry.com/api/ask/chat', { method: 'POST', headers: h, body: typeof body === 'string' ? body : JSON.stringify(body) }));
const newChat = { conversationId: null, model: 'claude-sonnet-5', message: { text: 'Show me lighting keywords' } };
const existingId = '11111111-1111-4111-8111-111111111111';

describe('POST /api/ask/chat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envMock.env = { APP_PUBLIC_URL: 'https://keywordquarry.com', ASK_AI_ENABLED: '1', ANTHROPIC_API_KEY: 'sk-ant-test', DATABASE_URL: 'postgres://test' };
    auth.user = member;
    gates.runGates.mockResolvedValue({ ok: true, account });
    conv.createConversationWithFirstMessage.mockResolvedValue({ conversationId: 'c9' });
    conv.acquireTurnLock.mockResolvedValue(true);
    conv.appendUserMessage.mockResolvedValue({ seq: 3 });
    conv.appendAssistantMessage.mockResolvedValue(true);
    conv.releaseTurnLock.mockResolvedValue(undefined);
    snapshot.loadSnapshotMetaHttp.mockResolvedValue({ currentWeekEndDate: '2026-09-19' });
    turn.runTurn.mockImplementation(async () => new Response('stream', { status: 200 }));
    ledger.settleTurn.mockResolvedValue({ fromAllowanceMicro: 5, fromCreditMicro: 0, absorbedMicro: 0, globalCostMicro: 5, globalQuestions: 1 });
  });

  it('is dark (404) when the kill switch is off, before auth', async () => {
    envMock.env.ASK_AI_ENABLED = undefined;
    auth.user = null;
    expect((await post(newChat)).status).toBe(404);
  });
  it('refuses cross-site (403) and unauthenticated (401)', async () => {
    expect((await post(newChat, { ...headers, 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    auth.user = null;
    expect((await post(newChat)).status).toBe(401);
  });
  it('validates the body: too long, empty, unknown model, bad JSON', async () => {
    expect((await post({ ...newChat, message: { text: 'x'.repeat(4001) } })).status).toBe(400);
    expect((await post({ ...newChat, message: { text: '   ' } })).status).toBe(400);
    expect((await post({ ...newChat, model: 'claude-fable-5-1' })).status).toBe(400);
    expect((await post('{not json')).status).toBe(400);
  });
  it('passes gate refusals through with their status, message and Retry-After', async () => {
    gates.runGates.mockResolvedValueOnce({ ok: false, refusal: { status: 429, code: 'daily_limit', message: 'limit', retryAfterSeconds: 60 } });
    const res = await post(newChat);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
    expect(await res.json()).toEqual({ error: 'limit', code: 'daily_limit' });
    gates.runGates.mockResolvedValueOnce({ ok: false, refusal: { status: 404, code: 'not_eligible', message: 'Not found' } });
    expect((await post(newChat)).status).toBe(404);
  });
  it('tells an eligible member when the key is missing (503), only after the gates', async () => {
    envMock.env.ANTHROPIC_API_KEY = undefined;
    const res = await post(newChat);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Ask AI isn't configured yet.", code: 'not_configured' });
  });
  it('a first send creates the conversation (already locked) with the chosen model and streams with the id in the start metadata', async () => {
    const res = await post(newChat);
    expect(res.status).toBe(200);
    expect(conv.createConversationWithFirstMessage).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', model: 'claude-sonnet-5', message: expect.objectContaining({ role: 'user', parts: [{ type: 'text', text: 'Show me lighting keywords' }] }) }));
    expect(conv.acquireTurnLock).not.toHaveBeenCalled();
    const input = turn.runTurn.mock.calls[0][0];
    expect(input.startMetadata).toEqual({ conversationId: 'c9' });
    expect(input.history).toEqual([]);
    expect(input.instructions).toBe('sys');
    expect(input.model).toEqual({ modelId: 'claude-sonnet-5' });
  });
  it('a first send at the cap is 409', async () => {
    conv.createConversationWithFirstMessage.mockResolvedValueOnce('cap');
    const res = await post(newChat);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'You have 5 chats. Delete one to start another.', code: 'chat_cap' });
  });
  it('a follow-up loads the owned conversation with the history window, locks it, appends, and streams', async () => {
    conv.loadConversation.mockResolvedValueOnce({ conversation: { id: 'c1', model: 'claude-opus-5-5', messageCount: 4 }, messages: [{ id: 'm1', role: 'user', parts: [] }] });
    const res = await post({ ...newChat, conversationId: existingId, model: undefined });
    expect(res.status).toBe(200);
    expect(conv.loadConversation).toHaveBeenCalledWith('u1', existingId, { lastN: 20 });
    expect(conv.acquireTurnLock).toHaveBeenCalledWith('u1', 'c1');
    expect(conv.appendUserMessage).toHaveBeenCalled();
    expect(turn.runTurn.mock.calls[0][0].history).toEqual([{ id: 'm1', role: 'user', parts: [] }]);
    expect(turn.runTurn.mock.calls[0][0].model).toEqual({ modelId: 'claude-opus-5-5' });
    expect(turn.runTurn.mock.calls[0][0].startMetadata).toBeUndefined();
  });
  it('a foreign or missing conversation is 404; full is 409; busy is 409', async () => {
    conv.loadConversation.mockResolvedValueOnce(null);
    expect((await post({ ...newChat, conversationId: existingId })).status).toBe(404);
    conv.loadConversation.mockResolvedValueOnce({ conversation: { id: 'c1', model: 'claude-sonnet-5', messageCount: 200 }, messages: [] });
    expect((await post({ ...newChat, conversationId: existingId })).status).toBe(409);
    conv.loadConversation.mockResolvedValueOnce({ conversation: { id: 'c1', model: 'claude-sonnet-5', messageCount: 2 }, messages: [] });
    conv.acquireTurnLock.mockResolvedValueOnce(false);
    const busy = await post({ ...newChat, conversationId: existingId });
    expect(busy.status).toBe(409);
    expect(await busy.json()).toEqual({ error: 'Wait for the current answer to finish.', code: 'busy' });
  });
  it('releases the lock and answers 503 when the turn setup fails before streaming', async () => {
    snapshot.loadSnapshotMetaHttp.mockRejectedValueOnce(new Error('neon down'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await post(newChat);
    expect(res.status).toBe(503);
    expect(conv.releaseTurnLock).toHaveBeenCalledWith('c9');
    expect(turn.runTurn).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
  });
  it('releases the lock and answers 503 when runTurn itself throws before the stream exists (e.g. convertToModelMessages)', async () => {
    turn.runTurn.mockRejectedValueOnce(new Error('convert failed'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await post(newChat);
    expect(res.status).toBe(503);
    expect(conv.releaseTurnLock).toHaveBeenCalledWith('c9');
    expect(conv.acquireTurnLock).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
  });
  it('onEnd settles BEFORE saving the answer, checks the ceiling, logs an unsaved answer, and releases the lock even when something throws', async () => {
    await post(newChat);
    const { onEnd } = turn.runTurn.mock.calls[0][0];
    const assistant = { id: '22222222-2222-4222-8222-222222222222', role: 'assistant', parts: [{ type: 'text', text: 'Hi' }] };
    const order: string[] = [];
    ledger.settleTurn.mockImplementationOnce(async () => { order.push('settle'); return { fromAllowanceMicro: 5, fromCreditMicro: 0, absorbedMicro: 0, globalCostMicro: 5, globalQuestions: 1 }; });
    conv.appendAssistantMessage.mockImplementationOnce(async () => { order.push('append'); return false; });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await onEnd({ assistant, status: 'complete', usage: { noCacheTokens: 5000, cacheWriteTokens: 1000, cacheReadTokens: 10000, outputTokens: 1000 }, steps: 2 });
    expect(order).toEqual(['settle', 'append']);
    expect(ledger.settleTurn).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', conversationId: 'c9', messageId: assistant.id, model: 'claude-sonnet-5', costMicro: 24_500 }));
    expect(conv.appendAssistantMessage).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'c9', status: 'complete', message: assistant }));
    expect(error).toHaveBeenCalled(); // the unsaved-answer log line
    expect(conv.releaseTurnLock).toHaveBeenCalledWith('c9');
    ledger.settleTurn.mockRejectedValueOnce(new Error('db down'));
    await onEnd({ assistant: null, status: 'failed', usage: { noCacheTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 }, steps: 1 });
    expect(conv.releaseTurnLock).toHaveBeenCalledTimes(2);
  });
});
