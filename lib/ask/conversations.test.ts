import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('@/lib/env', () => ({ env: { DATABASE_URL: 'postgres://test' } }));
const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('@/db/client', () => ({ db: { execute } }));
import { titleFrom, listConversations, loadConversation, createConversationWithFirstMessage, appendUserMessage, appendAssistantMessage, acquireTurnLock, releaseTurnLock, deleteConversation, storedToUiMessage } from './conversations';

const sqlOf = (i = 0) => JSON.stringify(execute.mock.calls[i][0]);
const convRow = { id: 'c1', user_id: 'u1', title: 'Lighting keywords', model: 'claude-sonnet-5', message_count: 2, in_flight_since: null, created_at: '2026-09-28T10:00:00.000Z', updated_at: '2026-09-28T10:05:00.000Z' };
const userMsg = { id: '11111111-1111-4111-8111-111111111111', role: 'user' as const, parts: [{ type: 'text' as const, text: 'Show me lighting keywords' }] };

describe('conversations', () => {
  beforeEach(() => vi.clearAllMocks());

  it('titleFrom collapses whitespace and cuts at 60 characters with an ellipsis', () => {
    expect(titleFrom('  Show   me\n lighting  ')).toBe('Show me lighting');
    const long = 'a'.repeat(80);
    expect(titleFrom(long)).toBe('a'.repeat(60) + '…');
    expect(titleFrom('')).toBe('New chat');
  });
  it('lists newest first', async () => {
    execute.mockResolvedValueOnce({ rows: [convRow] });
    const list = await listConversations('u1');
    expect(list[0]).toMatchObject({ id: 'c1', title: 'Lighting keywords', model: 'claude-sonnet-5', messageCount: 2, inFlightSince: null });
    expect(list[0].updatedAt).toBeInstanceOf(Date);
    expect(sqlOf()).toContain('ORDER BY updated_at DESC');
  });
  it('loads a conversation with its messages in seq order, scoped to the owner', async () => {
    execute.mockResolvedValueOnce({ rows: [convRow] });
    execute.mockResolvedValueOnce({ rows: [{ id: 'm1', seq: 1, role: 'user', parts: userMsg.parts, status: 'complete' }, { id: 'm2', seq: 2, role: 'assistant', parts: [{ type: 'text', text: 'Here' }], status: 'stopped' }] });
    const loaded = await loadConversation('u1', 'c1');
    expect(loaded?.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(loaded?.messages[1]).toMatchObject({ role: 'assistant', metadata: { status: 'stopped' } });
    expect(sqlOf(0)).toContain('user_id');
    execute.mockResolvedValueOnce({ rows: [] });
    await expect(loadConversation('u1', 'nope')).resolves.toBeNull();
  });
  it('creates the conversation and its first message in one statement, bounded by conversation_count < 5', async () => {
    execute.mockResolvedValueOnce({ rows: [{ id: 'c9' }] });
    await expect(createConversationWithFirstMessage({ userId: 'u1', model: 'claude-opus-5-5', message: userMsg, now: new Date() })).resolves.toEqual({ conversationId: 'c9' });
    const s = sqlOf();
    expect(s).toContain('conversation_count <');
    expect(s).toContain('{"value":["5"]}');
    expect(s).toContain('INSERT INTO ask_conversations');
    expect(s).toContain('INSERT INTO ask_messages');
    expect(execute).toHaveBeenCalledTimes(1);
    execute.mockResolvedValueOnce({ rows: [] });
    await expect(createConversationWithFirstMessage({ userId: 'u1', model: 'claude-opus-5-5', message: userMsg, now: new Date() })).resolves.toBe('cap');
  });
  it('appends a user message only under the 200 cap, bumping message_count', async () => {
    execute.mockResolvedValueOnce({ rows: [{ seq: 3 }] });
    await expect(appendUserMessage({ conversationId: 'c1', userId: 'u1', message: userMsg, now: new Date() })).resolves.toEqual({ seq: 3 });
    expect(sqlOf()).toContain('message_count <');
    expect(sqlOf()).toContain('{"value":["200"]}');
    execute.mockResolvedValueOnce({ rows: [] });
    await expect(appendUserMessage({ conversationId: 'c1', userId: 'u1', message: userMsg, now: new Date() })).resolves.toBe('full');
  });
  it('appends the assistant message with its status and touches updated_at', async () => {
    execute.mockResolvedValueOnce({ rows: [{ seq: 4 }] });
    await appendAssistantMessage({ conversationId: 'c1', message: { id: userMsg.id, parts: [{ type: 'text', text: 'Hi' }] }, status: 'complete', now: new Date() });
    expect(sqlOf()).toContain("'assistant'");
    expect(sqlOf()).toContain('updated_at = now()');
  });
  it('acquires the turn lock only when free or expired, and releases it', async () => {
    execute.mockResolvedValueOnce({ rows: [{ id: 'c1' }] });
    await expect(acquireTurnLock('u1', 'c1')).resolves.toBe(true);
    expect(sqlOf()).toContain("interval '5 minutes'");
    execute.mockResolvedValueOnce({ rows: [] });
    await expect(acquireTurnLock('u1', 'c1')).resolves.toBe(false);
    execute.mockResolvedValueOnce({ rows: [] });
    await releaseTurnLock('c1');
    expect(sqlOf(2)).toContain('in_flight_since = NULL');
  });
  it('deletes an owned, idle conversation and decrements the count in one statement', async () => {
    execute.mockResolvedValueOnce({ rows: [{ id: 'c1' }] });
    await expect(deleteConversation('u1', 'c1')).resolves.toBe('deleted');
    expect(sqlOf()).toContain('GREATEST(0, conversation_count - 1)');
    expect(sqlOf()).toContain("interval '5 minutes'");
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('refuses to delete a chat whose turn is in flight (busy) and reports a foreign or unknown chat as missing', async () => {
    execute.mockResolvedValueOnce({ rows: [] });
    execute.mockResolvedValueOnce({ rows: [{ one: 1 }] });
    await expect(deleteConversation('u1', 'c1')).resolves.toBe('busy');
    expect(sqlOf(1)).toContain('user_id');
    execute.mockResolvedValueOnce({ rows: [] });
    execute.mockResolvedValueOnce({ rows: [] });
    await expect(deleteConversation('u1', 'c1')).resolves.toBe('missing');
  });
  it('storedToUiMessage carries status as metadata', () => {
    expect(storedToUiMessage({ id: 'm', seq: 1, role: 'assistant', parts: [], status: 'failed' })).toEqual({ id: 'm', role: 'assistant', parts: [], metadata: { status: 'failed' } });
  });
});
