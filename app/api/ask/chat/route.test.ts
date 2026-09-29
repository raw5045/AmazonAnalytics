// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
const envMock = vi.hoisted(() => ({ env: { APP_PUBLIC_URL: 'https://keywordquarry.com', ASK_AI_ENABLED: '1', ANTHROPIC_API_KEY: 'sk-ant-test', DATABASE_URL: 'postgres://test' } as Record<string, string | undefined> }));
vi.mock('@/lib/env', () => envMock);
vi.mock('@clerk/nextjs/server', () => ({ auth: vi.fn() }));
vi.mock('@/db/client', () => ({ db: { execute: vi.fn() } }));
// after() throws "outside a request scope" when called from plain vitest, and the route now
// registers it once the turn lock is held (Task 8 review, I3) — override just that export.
const nextServerMock = vi.hoisted(() => ({ after: vi.fn() }));
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: nextServerMock.after }));
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
const turn = vi.hoisted(() => ({ runTurn: vi.fn(), windowHistory: (h: unknown[]) => h, TURN_DEADLINE: 'ask turn deadline' }));
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
const activity = vi.hoisted(() => ({ bumpUserActivity: vi.fn(async () => {}) }));
vi.mock('@/lib/activity/bump', () => activity);
vi.mock('@ai-sdk/anthropic', () => ({ createAnthropic: () => (id: string) => ({ modelId: id }) }));
const alerts = vi.hoisted(() => ({ maybeAlertCeiling: vi.fn(async () => {}) }));
vi.mock('@/lib/ask/alerts', () => alerts);
import { DrizzleQueryError } from 'drizzle-orm';
import { BAD_REQUEST_MESSAGE, BUSY_MESSAGE, CHAT_CAP_MESSAGE, CHAT_FULL_MESSAGE, NOT_CONFIGURED_MESSAGE, TOO_LONG_MESSAGE } from '@/lib/ask/messages';
import { POST } from './route';

const member = { id: 'u1', role: 'standard_user' as const, clerkUserId: 'user_1', email: 'm@example.com' };
const account = { userId: 'u1', access: true, monthlyAllowanceMicro: 10_000_000, allowanceUsedMicro: 0, periodStart: '2026-09-01', creditMicro: 0, conversationCount: 0 };
const headers = { 'content-type': 'application/json', origin: 'https://keywordquarry.com', 'sec-fetch-site': 'same-origin' };
const post = (body: unknown, h: Record<string, string> = headers) => POST(new Request('https://keywordquarry.com/api/ask/chat', { method: 'POST', headers: h, body: typeof body === 'string' ? body : JSON.stringify(body) }));
const newChat = { conversationId: null, model: 'claude-sonnet-5', message: { text: 'Show me lighting keywords' } };
const existingId = '11111111-1111-4111-8111-111111111111';
/** Every log line here is `console.X('[ask ...]', JSON.stringify({ outcome, ... }))`; pull just the outcome codes actually logged. */
const outcomesLogged = (spy: { mock: { calls: unknown[][] } }): string[] =>
  spy.mock.calls.map((c) => { try { return (JSON.parse(String(c[1])) as { outcome?: string }).outcome; } catch { return undefined; } }).filter((o): o is string => o !== undefined);

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
  it('a content-length over the limit is 413 without reading the body (the actual body is a valid small request)', async () => {
    const res = await post(newChat, { ...headers, 'content-length': '100000' });
    expect(res.status).toBe(413);
    expect(gates.runGates).not.toHaveBeenCalled();
  });
  it('validates the body: too long and empty get the length message; unknown model and bad JSON get the generic bad-request message', async () => {
    expect(await (await post({ ...newChat, message: { text: 'x'.repeat(4001) } })).json()).toEqual({ error: TOO_LONG_MESSAGE, code: 'bad_request' });
    expect(await (await post({ ...newChat, message: { text: '   ' } })).json()).toEqual({ error: TOO_LONG_MESSAGE, code: 'bad_request' });
    expect(await (await post({ ...newChat, model: 'claude-fable-5-1' })).json()).toEqual({ error: BAD_REQUEST_MESSAGE, code: 'bad_request' });
    expect(await (await post('{not json')).json()).toEqual({ error: BAD_REQUEST_MESSAGE, code: 'bad_request' });
  });
  it('rejects unknown body keys, top-level and nested inside message, with 400 and the generic bad-request message (Task 8 re-review)', async () => {
    const top = await post({ ...newChat, extra: 'nope' });
    expect(top.status).toBe(400);
    expect(await top.json()).toEqual({ error: BAD_REQUEST_MESSAGE, code: 'bad_request' });
    const nested = await post({ ...newChat, message: { ...newChat.message, extra: 'nope' } });
    expect(nested.status).toBe(400);
    expect(await nested.json()).toEqual({ error: BAD_REQUEST_MESSAGE, code: 'bad_request' });
  });
  it('a NUL-only message is empty once sanitised and gets the same 400 as an empty message (Task 8 review, I1)', async () => {
    const res = await post({ ...newChat, message: { text: '\u0000\u0000' } });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: TOO_LONG_MESSAGE, code: 'bad_request' });
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
    expect(await res.json()).toEqual({ error: NOT_CONFIGURED_MESSAGE, code: 'not_configured' });
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
    expect(input.modelId).toBe('claude-sonnet-5');
    expect(activity.bumpUserActivity).toHaveBeenCalledTimes(1);
    expect(activity.bumpUserActivity).toHaveBeenCalledWith('u1', 'ask_question');
  });
  it('a first send at the cap is 409', async () => {
    conv.createConversationWithFirstMessage.mockResolvedValueOnce('cap');
    const res = await post(newChat);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: CHAT_CAP_MESSAGE, code: 'chat_cap' });
    expect(activity.bumpUserActivity).not.toHaveBeenCalled();
  });
  it('a create failure on a first send answers 503 with no lock to release (Task 8 review, I1/I2)', async () => {
    conv.createConversationWithFirstMessage.mockRejectedValueOnce(new Error('conn reset'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await post(newChat);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Something went wrong on our side. Try again in a minute.', code: 'setup_failed' });
    expect(conv.releaseTurnLock).not.toHaveBeenCalled();
    expect(outcomesLogged(error)).toContain('create_failed');
    error.mockRestore();
  });
  it('a follow-up loads the owned conversation with the history window, locks it, appends (pinning the owner-scoped args), and streams with the stored model', async () => {
    conv.loadConversation.mockResolvedValueOnce({ conversation: { id: 'c1', model: 'claude-opus-5-5', messageCount: 4 }, messages: [{ id: 'm1', role: 'user', parts: [] }] });
    const res = await post({ ...newChat, conversationId: existingId, model: undefined });
    expect(res.status).toBe(200);
    expect(conv.loadConversation).toHaveBeenCalledWith('u1', existingId, { lastN: 20 });
    expect(conv.acquireTurnLock).toHaveBeenCalledWith('u1', 'c1');
    expect(conv.appendUserMessage).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'c1', userId: 'u1', message: expect.objectContaining({ role: 'user', parts: [{ type: 'text', text: 'Show me lighting keywords' }] }), now: expect.any(Date) }));
    expect(turn.runTurn.mock.calls[0][0].history).toEqual([{ id: 'm1', role: 'user', parts: [] }]);
    expect(turn.runTurn.mock.calls[0][0].model).toEqual({ modelId: 'claude-opus-5-5' });
    expect(turn.runTurn.mock.calls[0][0].modelId).toBe('claude-opus-5-5');
    expect(turn.runTurn.mock.calls[0][0].startMetadata).toBeUndefined();
    expect(activity.bumpUserActivity).toHaveBeenCalledTimes(1);
    expect(activity.bumpUserActivity).toHaveBeenCalledWith('u1', 'ask_question');
  });
  it('a foreign or missing conversation is 404; a chat at the message cap is 409; busy is 409 and never releases (no holder token to release with)', async () => {
    conv.loadConversation.mockResolvedValueOnce(null);
    expect((await post({ ...newChat, conversationId: existingId })).status).toBe(404);
    conv.loadConversation.mockResolvedValueOnce({ conversation: { id: 'c1', model: 'claude-sonnet-5', messageCount: 200 }, messages: [] });
    expect((await post({ ...newChat, conversationId: existingId })).status).toBe(409);
    conv.loadConversation.mockResolvedValueOnce({ conversation: { id: 'c1', model: 'claude-sonnet-5', messageCount: 2 }, messages: [] });
    conv.acquireTurnLock.mockResolvedValueOnce(false);
    const busy = await post({ ...newChat, conversationId: existingId });
    expect(busy.status).toBe(409);
    expect(await busy.json()).toEqual({ error: BUSY_MESSAGE, code: 'busy' });
    expect(conv.releaseTurnLock).not.toHaveBeenCalled();
    expect(activity.bumpUserActivity).not.toHaveBeenCalled();
  });
  it('appendUserMessage returning \'full\' (the chat filled up between the load and the append) is 409 and releases the lock', async () => {
    conv.loadConversation.mockResolvedValueOnce({ conversation: { id: 'c1', model: 'claude-sonnet-5', messageCount: 2 }, messages: [] });
    conv.appendUserMessage.mockResolvedValueOnce('full');
    const res = await post({ ...newChat, conversationId: existingId, model: undefined });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: CHAT_FULL_MESSAGE, code: 'chat_full' });
    expect(conv.releaseTurnLock).toHaveBeenCalledWith('c1');
    expect(turn.runTurn).not.toHaveBeenCalled();
    // This return happens before the turn's lifetime tracking begins (nothing to stream yet), so
    // after() is never registered for it — unlike the setup-failure catch further down.
    expect(nextServerMock.after).not.toHaveBeenCalled();
  });
  it('an append failure on a follow-up releases the lock, logs append_failed (never the message text), and answers 503', async () => {
    conv.loadConversation.mockResolvedValueOnce({ conversation: { id: 'c1', model: 'claude-sonnet-5', messageCount: 2 }, messages: [] });
    conv.appendUserMessage.mockRejectedValueOnce(new Error('conn reset'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await post({ ...newChat, conversationId: existingId, model: undefined });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Something went wrong on our side. Try again in a minute.', code: 'setup_failed' });
    expect(conv.releaseTurnLock).toHaveBeenCalledWith('c1');
    expect(outcomesLogged(error)).toContain('append_failed');
    expect(turn.runTurn).not.toHaveBeenCalled();
    error.mockRestore();
  });
  it('releases the lock, resolves the after-promise, and answers 503 when the turn setup fails before streaming', async () => {
    snapshot.loadSnapshotMetaHttp.mockRejectedValueOnce(new Error('neon down'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await post(newChat);
    expect(res.status).toBe(503);
    expect(conv.releaseTurnLock).toHaveBeenCalledWith('c9');
    expect(turn.runTurn).not.toHaveBeenCalled();
    expect(outcomesLogged(error)).toContain('setup_failed');
    // The setup catch aborts the turn's own controller (Task 8 review, I3c) and — because after()
    // was already registered once the lock was taken — must resolve that promise before returning,
    // or the invocation would idle until maxDuration with nothing left to do.
    expect(nextServerMock.after).toHaveBeenCalledTimes(1);
    const registered = nextServerMock.after.mock.calls[0][0] as () => Promise<void>;
    await expect(Promise.race([registered(), new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), 1000))])).resolves.toBeUndefined();
    error.mockRestore();
  });
  it('releases the lock and answers 503 when runTurn itself throws before the stream exists (e.g. convertToModelMessages)', async () => {
    turn.runTurn.mockRejectedValueOnce(new Error('convert failed'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await post(newChat);
    expect(res.status).toBe(503);
    expect(conv.releaseTurnLock).toHaveBeenCalledWith('c9');
    expect(conv.acquireTurnLock).not.toHaveBeenCalled();
    expect(outcomesLogged(error)).toContain('setup_failed');
    // The setup catch aborts the turn's own controller unconditionally (Task 8 review, I3c); the
    // signal handed to runTurn is the same object, so by the time the catch has run it must read
    // as aborted too — confirming the abort actually reaches whatever the turn was doing, not just
    // that the route logged and answered 503 (Task 8 re-review, 5c).
    expect(turn.runTurn.mock.calls[0][0].abortSignal.aborted).toBe(true);
    error.mockRestore();
  });
  it('an already-aborted request signal cancels the returned stream body once runTurn resolves, and after() was registered once', async () => {
    const cancelSpy = vi.fn();
    turn.runTurn.mockImplementationOnce(async () => new Response(new ReadableStream({ cancel: cancelSpy })));
    const controller = new AbortController();
    controller.abort();
    const req = new Request('https://keywordquarry.com/api/ask/chat', { method: 'POST', headers, body: JSON.stringify(newChat), signal: controller.signal });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(nextServerMock.after).toHaveBeenCalledTimes(1);
    // The request signal was already aborted before POST ever ran, so the aborted-already check
    // must have propagated it onto the route's own controller before runTurn was ever called
    // (Task 8 re-review, 5c) — not just "eventually", but by the time runTurn sees it.
    expect(turn.runTurn.mock.calls[0][0].abortSignal.aborted).toBe(true);
  });
  it('finishTurn() resolves the after()-lifetime promise only once onEnd completes, not before — on Vercel, skipping this would pin the function alive until maxDuration (Task 8 re-review, nit 1)', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await post(newChat);
    expect(res.status).toBe(200);
    const registered = nextServerMock.after.mock.calls[0][0] as () => Promise<void>;
    const p = registered();
    const PENDING = Symbol('pending');
    const raced = await Promise.race([
      p.then(() => 'resolved' as const),
      new Promise((resolve) => setTimeout(() => resolve(PENDING), 20)),
    ]);
    expect(raced).toBe(PENDING);
    const { onEnd } = turn.runTurn.mock.calls[0][0];
    await onEnd({ assistant: null, status: 'complete', usage: { noCacheTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 }, steps: 1 });
    await expect(p).resolves.toBeUndefined();
    log.mockRestore();
    error.mockRestore();
  });

  describe('onEnd: settlement, ceiling alert, persistence and lock release', () => {
    it('settles BEFORE saving the answer, alerts the ceiling with the settled global cost, and logs answer_not_saved when the chat vanished underneath it', async () => {
      await post(newChat);
      const { onEnd } = turn.runTurn.mock.calls[0][0];
      const assistant = { id: '22222222-2222-4222-8222-222222222222', role: 'assistant', parts: [{ type: 'text', text: 'Hi' }] };
      const order: string[] = [];
      ledger.settleTurn.mockImplementationOnce(async () => { order.push('settle'); return { fromAllowanceMicro: 5, fromCreditMicro: 0, absorbedMicro: 0, globalCostMicro: 5, globalQuestions: 1 }; });
      conv.appendAssistantMessage.mockImplementationOnce(async () => { order.push('append'); return false; });
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      await onEnd({ assistant, status: 'complete', usage: { noCacheTokens: 5000, cacheWriteTokens: 1000, cacheReadTokens: 10000, outputTokens: 1000 }, steps: 2 });
      expect(order).toEqual(['settle', 'append']);
      expect(ledger.settleTurn).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', conversationId: 'c9', messageId: assistant.id, model: 'claude-sonnet-5', costMicro: 24_500 }));
      expect(alerts.maybeAlertCeiling).toHaveBeenCalledWith(5, expect.any(Date), 1);
      expect(conv.appendAssistantMessage).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'c9', status: 'complete', message: assistant }));
      expect(outcomesLogged(error)).toContain('answer_not_saved');
      // The success line (settle worked) is console.log, not console.error, and carries a duration.
      const success = log.mock.calls.map((c) => { try { return JSON.parse(String(c[1])); } catch { return undefined; } }).find((o) => o?.outcome === 'complete');
      expect(success).toMatchObject({ costMicro: 24_500, globalCostMicro: 5 });
      expect(typeof success.durationMs).toBe('number');
      expect(conv.releaseTurnLock).toHaveBeenCalledWith('c9');
      error.mockRestore();
      log.mockRestore();
    });
    it('a settle failure is logged as settle_failed with enough to reconcile by hand, but the answer is still saved and the lock still released', async () => {
      await post(newChat);
      const { onEnd } = turn.runTurn.mock.calls[0][0];
      const assistant = { id: '22222222-2222-4222-8222-222222222222', role: 'assistant', parts: [{ type: 'text', text: 'Hi' }] };
      ledger.settleTurn.mockRejectedValueOnce(new Error('db down'));
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      await onEnd({ assistant, status: 'complete', usage: { noCacheTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 }, steps: 1 });
      const line = error.mock.calls.find((c) => String(c[1]).includes('settle_failed'));
      expect(line).toBeDefined();
      const logged = JSON.parse(line![1] as string) as Record<string, unknown>;
      expect(logged).toMatchObject({ outcome: 'settle_failed', userId: 'u1', conversationId: 'c9', messageId: assistant.id, model: 'claude-sonnet-5', status: 'complete' });
      expect(conv.appendAssistantMessage).toHaveBeenCalledWith(expect.objectContaining({ message: assistant }));
      expect(conv.releaseTurnLock).toHaveBeenCalledWith('c9');
      error.mockRestore();
    });
    it('an alert failure is logged as alert_failed, separate from settle_failed, since the settle already succeeded', async () => {
      await post(newChat);
      const { onEnd } = turn.runTurn.mock.calls[0][0];
      alerts.maybeAlertCeiling.mockRejectedValueOnce(new Error('resend down'));
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      await onEnd({ assistant: null, status: 'failed', usage: { noCacheTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 }, steps: 1 });
      const found = outcomesLogged(error);
      expect(found).toContain('alert_failed');
      expect(found).not.toContain('settle_failed');
      expect(conv.releaseTurnLock).toHaveBeenCalledWith('c9');
      error.mockRestore();
    });
    it('an append (save) failure is logged as save_failed and the lock is still released', async () => {
      await post(newChat);
      const { onEnd } = turn.runTurn.mock.calls[0][0];
      const assistant = { id: '22222222-2222-4222-8222-222222222222', role: 'assistant', parts: [{ type: 'text', text: 'Hi' }] };
      conv.appendAssistantMessage.mockRejectedValueOnce(new Error('conn reset'));
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      await onEnd({ assistant, status: 'complete', usage: { noCacheTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 }, steps: 1 });
      expect(outcomesLogged(error)).toContain('save_failed');
      expect(conv.releaseTurnLock).toHaveBeenCalledWith('c9');
      error.mockRestore();
    });
    it('a DrizzleQueryError-shaped save error never lets the message text (or the bound SQL params it hides in) reach a console call', async () => {
      await post(newChat);
      const { onEnd } = turn.runTurn.mock.calls[0][0];
      const secretText = 'the private answer text nobody else should see';
      const assistant = { id: '22222222-2222-4222-8222-222222222222', role: 'assistant', parts: [{ type: 'text', text: secretText }] };
      const cause = Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
      const drizzleErr = new DrizzleQueryError('INSERT INTO ask_messages (parts) VALUES ($1)', [JSON.stringify(assistant.parts)], cause);
      conv.appendAssistantMessage.mockRejectedValueOnce(drizzleErr);
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      await onEnd({ assistant, status: 'complete', usage: { noCacheTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 }, steps: 1 });
      const everything = [...error.mock.calls, ...log.mock.calls].flat().map((a) => (typeof a === 'string' ? a : JSON.stringify(a)));
      expect(everything.some((s) => s.includes(secretText))).toBe(false);
      expect(outcomesLogged(error)).toContain('save_failed');
      error.mockRestore();
      log.mockRestore();
    });
  });
});
