import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('@/lib/env', () => ({ env: { DATABASE_URL: 'postgres://test' } }));
const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('@/db/client', () => ({ db: { execute } }));
import { PgDialect } from 'drizzle-orm/pg-core';
import { titleFrom, listConversations, loadConversation, createConversationWithFirstMessage, appendUserMessage, appendAssistantMessage, acquireTurnLock, releaseTurnLock, deleteConversation, storedToUiMessage, stampChangesApproved, recordAnswersAndAppend } from './conversations';

// Renders the real SQL text (placeholders as $1, $2…) and the bound parameter values separately,
// mirroring lib/ask/ledger.test.ts (Task 5 review) — a sql.raw() fragment (e.g. the maxChats/
// maxMessagesPerChat caps, the in-flight expiry) is inlined into the SQL text, not a parameter, so
// substring checks on it belong on sqlOf(); an interpolated VALUE only ever shows up in paramsOf().
const dialect = new PgDialect();
const sqlOf = (i = 0) => dialect.sqlToQuery(execute.mock.calls[i][0]).sql;
const paramsOf = (i = 0) => dialect.sqlToQuery(execute.mock.calls[i][0]).params;
const convRow = { id: 'c1', user_id: 'u1', title: 'Lighting keywords', model: 'claude-sonnet-5', message_count: 2, in_flight_since: null, changes_approved_at: null, created_at: '2026-09-28T10:00:00.000Z', updated_at: '2026-09-28T10:05:00.000Z' };
const userMsg = { id: '11111111-1111-4111-8111-111111111111', role: 'user' as const, parts: [{ type: 'text' as const, text: 'Show me lighting keywords' }] };

describe('conversations', () => {
  beforeEach(() => vi.clearAllMocks());

  it('titleFrom collapses whitespace and cuts by code point at 60 with an ellipsis', () => {
    expect(titleFrom('  Show   me\n lighting  ')).toBe('Show me lighting');
    const long = 'a'.repeat(80);
    expect(titleFrom(long)).toBe('a'.repeat(60) + '…');
    expect(titleFrom('')).toBe('New chat');
    // A cut that lands inside a surrogate pair would produce a lone surrogate: a lone surrogate
    // cannot be stored as UTF-8; expect the statement to be rejected. Cutting by Array.from's code
    // points keeps the emoji whole instead of splitting it.
    expect(titleFrom('a'.repeat(59) + '🔦 lights')).toBe('a'.repeat(59) + '🔦…');
  });
  it('lists newest first, scoped to the owner', async () => {
    execute.mockResolvedValueOnce({ rows: [convRow] });
    const list = await listConversations('u1');
    expect(list[0]).toMatchObject({ id: 'c1', title: 'Lighting keywords', model: 'claude-sonnet-5', messageCount: 2, inFlightSince: null });
    expect(list[0].updatedAt).toBeInstanceOf(Date);
    expect(sqlOf()).toContain('WHERE user_id = $1::uuid');
    expect(sqlOf()).toContain('ORDER BY updated_at DESC');
  });
  it('rejects a stored model the code no longer recognizes (retiring a model needs a data migration)', async () => {
    execute.mockResolvedValueOnce({ rows: [{ ...convRow, model: 'claude-nope' }] });
    await expect(listConversations('u1')).rejects.toThrow(/unknown model/);
  });
  it('loads a conversation with its messages in seq order, scoped to the owner', async () => {
    execute.mockResolvedValueOnce({ rows: [convRow] });
    execute.mockResolvedValueOnce({ rows: [{ id: 'm1', seq: 1, role: 'user', parts: userMsg.parts, status: 'complete' }, { id: 'm2', seq: 2, role: 'assistant', parts: [{ type: 'text', text: 'Here' }], status: 'stopped' }] });
    const loaded = await loadConversation('u1', 'c1');
    expect(loaded?.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(loaded?.messages[1]).toMatchObject({ role: 'assistant', metadata: { status: 'stopped' } });
    expect(sqlOf(0)).toContain('WHERE id = $1::uuid AND user_id = $2::uuid');
    execute.mockResolvedValueOnce({ rows: [] });
    await expect(loadConversation('u1', 'nope')).resolves.toBeNull();
  });
  it('loadConversation with lastN fetches only the newest N messages and restores ascending order', async () => {
    execute.mockResolvedValueOnce({ rows: [convRow] });
    execute.mockResolvedValueOnce({ rows: [{ id: 'm2', seq: 2, role: 'assistant', parts: [{ type: 'text', text: 'Here' }], status: 'stopped' }, { id: 'm1', seq: 1, role: 'user', parts: userMsg.parts, status: 'complete' }] });
    const loaded = await loadConversation('u1', 'c1', { lastN: 2 });
    expect(loaded?.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(sqlOf(1)).toContain('ORDER BY seq DESC LIMIT $2');
    expect(paramsOf(1)).toContain(2);
  });
  it('loadConversation rejects a non-positive or non-integer lastN before any DB call', async () => {
    await expect(loadConversation('u1', 'c1', { lastN: 0 })).rejects.toThrow(/positive safe integer/);
    await expect(loadConversation('u1', 'c1', { lastN: 1.5 })).rejects.toThrow(/positive safe integer/);
    expect(execute).not.toHaveBeenCalled();
  });
  it('creates the conversation and its first message in one already-locked statement, bounded by conversation_count < 5', async () => {
    execute.mockResolvedValueOnce({ rows: [{ id: 'c9' }] });
    await expect(createConversationWithFirstMessage({ userId: 'u1', model: 'claude-opus-5-5', message: userMsg, now: new Date() })).resolves.toEqual({ conversationId: 'c9' });
    const s = sqlOf();
    expect(s).toContain('conversation_count < 5');
    expect(s).toContain('message_count, in_flight_since, created_at, updated_at');
    // Pins the created-locked value itself: message_count 1, in_flight_since set from the DB's own
    // now() (not a bound parameter), then the bound created_at timestamptz right after it.
    expect(s).toContain('1, now(), $4::timestamptz');
    expect(s).toContain('INSERT INTO ask_conversations');
    expect(s).toContain('INSERT INTO ask_messages');
    expect(execute).toHaveBeenCalledTimes(1);
    execute.mockResolvedValueOnce({ rows: [] });
    await expect(createConversationWithFirstMessage({ userId: 'u1', model: 'claude-opus-5-5', message: userMsg, now: new Date() })).resolves.toBe('cap');
  });
  it('createConversationWithFirstMessage strips U+0000 and repairs a lone surrogate in both the stored parts and the derived title (Task 8 re-review)', async () => {
    execute.mockResolvedValueOnce({ rows: [{ id: 'c9' }] });
    const dirty = { id: userMsg.id, parts: [{ type: 'text' as const, text: 'a\u0000b\ud800c' }] };
    await createConversationWithFirstMessage({ userId: 'u1', model: 'claude-sonnet-5', message: dirty, now: new Date() });
    const params = paramsOf();
    expect(params).toContain('ab�c');
    const storedParts = params.find((p) => typeof p === 'string' && p.includes('"text"')) as string;
    expect(storedParts).not.toContain('\u0000');
    expect(storedParts).not.toContain('\ud800');
    expect(JSON.parse(storedParts)).toEqual([{ type: 'text', text: 'ab�c' }]);
  });
  it('appends a user message only under the 200 cap, bumping message_count, owner-scoped', async () => {
    execute.mockResolvedValueOnce({ rows: [{ seq: 3 }] });
    await expect(appendUserMessage({ conversationId: 'c1', userId: 'u1', message: userMsg, now: new Date() })).resolves.toEqual({ seq: 3 });
    expect(sqlOf()).toContain('AND user_id = $2::uuid AND message_count < 200');
    execute.mockResolvedValueOnce({ rows: [] });
    await expect(appendUserMessage({ conversationId: 'c1', userId: 'u1', message: userMsg, now: new Date() })).resolves.toBe('full');
  });
  it('appendUserMessage strips U+0000 and repairs a lone surrogate in the stored parts (Task 8 review, I1)', async () => {
    execute.mockResolvedValueOnce({ rows: [{ seq: 3 }] });
    const dirty = { id: userMsg.id, parts: [{ type: 'text' as const, text: 'a\u0000b\ud800c' }] };
    await appendUserMessage({ conversationId: 'c1', userId: 'u1', message: dirty, now: new Date() });
    const stored = paramsOf().find((p) => typeof p === 'string' && p.includes('"text"')) as string;
    expect(stored).not.toContain('\u0000');
    expect(stored).not.toContain('\ud800');
    expect(JSON.parse(stored)).toEqual([{ type: 'text', text: 'ab�c' }]);
  });
  it('appends the assistant message with its status, touches updated_at, and reports whether the chat still existed', async () => {
    execute.mockResolvedValueOnce({ rows: [{ seq: 4 }] });
    await expect(appendAssistantMessage({ conversationId: 'c1', message: { id: userMsg.id, parts: [{ type: 'text', text: 'Hi' }] }, status: 'complete', now: new Date() })).resolves.toBe(true);
    expect(sqlOf()).toContain("'assistant'");
    expect(sqlOf()).toContain('updated_at = now()');
    execute.mockResolvedValueOnce({ rows: [] });
    await expect(appendAssistantMessage({ conversationId: 'gone', message: { id: userMsg.id, parts: [{ type: 'text', text: 'Hi' }] }, status: 'complete', now: new Date() })).resolves.toBe(false);
  });
  it('appendAssistantMessage strips U+0000 and repairs a lone surrogate in the stored parts (Task 8 review, M6c — the model\'s own output is never sanitised upstream)', async () => {
    execute.mockResolvedValueOnce({ rows: [{ seq: 4 }] });
    const dirty = { id: userMsg.id, parts: [{ type: 'text' as const, text: 'x\u0000\ud800y' }] };
    await appendAssistantMessage({ conversationId: 'c1', message: dirty, status: 'complete', now: new Date() });
    const stored = paramsOf().find((p) => typeof p === 'string' && p.includes('"text"')) as string;
    expect(stored).not.toContain('\u0000');
    expect(stored).not.toContain('\ud800');
    expect(JSON.parse(stored)).toEqual([{ type: 'text', text: 'x�y' }]);
  });
  it('acquires the turn lock only when free or expired, scoped to the owner, and releases it', async () => {
    execute.mockResolvedValueOnce({ rows: [{ id: 'c1' }] });
    await expect(acquireTurnLock('u1', 'c1')).resolves.toBe(true);
    expect(sqlOf()).toContain('AND user_id = $2::uuid');
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
    const s = sqlOf();
    expect(s).toContain('id = $1::uuid AND user_id = $2::uuid');
    expect(s).toContain("in_flight_since < now() - interval '5 minutes'");
    expect(s).toContain('GREATEST(0, conversation_count - 1)');
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('refuses to delete a chat whose turn is in flight (busy) and reports a foreign or unknown chat as missing', async () => {
    execute.mockResolvedValueOnce({ rows: [] });
    execute.mockResolvedValueOnce({ rows: [{ one: 1 }] });
    await expect(deleteConversation('u1', 'c1')).resolves.toBe('busy');
    expect(sqlOf(0)).toContain('id = $1::uuid AND user_id = $2::uuid');
    expect(sqlOf(1)).toContain('id = $1::uuid AND user_id = $2::uuid');
    execute.mockResolvedValueOnce({ rows: [] });
    execute.mockResolvedValueOnce({ rows: [] });
    await expect(deleteConversation('u1', 'c1')).resolves.toBe('missing');
  });
  it('storedToUiMessage carries status as metadata', () => {
    expect(storedToUiMessage({ id: 'm', seq: 1, role: 'assistant', parts: [], status: 'failed' })).toEqual({ id: 'm', role: 'assistant', parts: [], metadata: { status: 'failed' } });
  });
});

describe('write approval state (arc 4)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('loads changesApprovedAt (null until stamped) and the stamp is owner-scoped', async () => {
    execute.mockResolvedValueOnce({ rows: [{ ...convRow, changes_approved_at: '2026-10-01T12:00:00.000Z' }] }).mockResolvedValueOnce({ rows: [] });
    const loaded = await loadConversation('u1', 'c1');
    expect(loaded?.conversation.changesApprovedAt).toEqual(new Date('2026-10-01T12:00:00.000Z'));
    expect(sqlOf()).toContain('changes_approved_at');
    execute.mockResolvedValueOnce({ rows: [{ id: 'c1' }] });
    await expect(stampChangesApproved('u1', 'c1', new Date('2026-10-01T12:00:00.000Z'))).resolves.toBe(true);
    expect(sqlOf(2)).toContain('UPDATE ask_conversations SET changes_approved_at = COALESCE(changes_approved_at, $1::timestamptz)');
    expect(sqlOf(2)).toContain('WHERE id = $2::uuid AND user_id = $3::uuid');
    expect(sqlOf(2)).toContain('RETURNING id');
    expect(paramsOf(2)).toEqual(['2026-10-01T12:00:00.000Z', 'c1', 'u1']);
    execute.mockResolvedValueOnce({ rows: [] });
    await expect(stampChangesApproved('u2', 'c1', new Date('2026-10-01T12:00:00.000Z'))).resolves.toBe(false);
    expect(paramsOf(3)).toEqual(['2026-10-01T12:00:00.000Z', 'c1', 'u2']);
    execute.mockResolvedValueOnce({ rows: [convRow] });
    await expect(listConversations('u1')).resolves.toMatchObject([{ changesApprovedAt: null }]);
  });
  const outcome = { id: '22222222-2222-4222-8222-222222222222', parts: [{ type: 'text' as const, text: '[approval-result] The person denied delete_saved_view.\u0000' }] };
  const record = () => recordAnswersAndAppend({ conversationId: 'c1', userId: 'u1', messageId: 'm2', parts: [{ type: 'text', text: 'a\u0000b' }], message: outcome, now: new Date('2026-10-01T12:00:00.000Z') });
  it('recordAnswersAndAppend records the answers AND appends the outcome message in ONE statement, each write only when the other can run', async () => {
    execute.mockResolvedValueOnce({ rows: [{ appended: true, found: true }] });
    await expect(record()).resolves.toBe('ok');
    expect(execute).toHaveBeenCalledTimes(1);
    const s = sqlOf();
    // The message that asked: that id, in this member's chat, assistant only (never a member's
    // message or an outcome message).
    expect(s).toContain("WHERE m.id = $1::uuid AND m.conversation_id = $2::uuid AND m.role = 'assistant' AND c.user_id = $3::uuid");
    // The append's bump mirrors appendUserMessage (owner-scoped, under the cap, count and updated_at),
    // and runs only when the message that asked is there.
    expect(s).toContain('UPDATE ask_conversations SET message_count = message_count + 1, updated_at = now()');
    expect(s).toContain('WHERE id = $4::uuid AND user_id = $5::uuid AND message_count < 200');
    expect(s).toContain('AND EXISTS (SELECT 1 FROM target)');
    // The parts rewrite: that message, in that chat, assistant only — and only together with the bump.
    expect(s).toContain('UPDATE ask_messages SET parts = $6::jsonb');
    expect(s).toContain("WHERE id = $7::uuid AND conversation_id = $8::uuid AND role = 'assistant' AND EXISTS (SELECT 1 FROM conv)");
    // The outcome message: a user message at seq = the new count, inserted only when both writes ran.
    expect(s).toContain("SELECT $9::uuid, conv.id, conv.message_count, 'user', $10::jsonb, 'complete', $11::timestamptz FROM conv, rec");
    expect(s).toContain('SELECT EXISTS (SELECT 1 FROM msg) AS appended, EXISTS (SELECT 1 FROM target) AS found');
    // Both parts arrays are cleaned at the DB boundary (NULs stripped).
    expect(paramsOf()).toEqual([
      'm2', 'c1', 'u1', 'c1', 'u1', JSON.stringify([{ type: 'text', text: 'ab' }]), 'm2', 'c1',
      outcome.id, JSON.stringify([{ type: 'text', text: '[approval-result] The person denied delete_saved_view.' }]), '2026-10-01T12:00:00.000Z',
    ]);
  });
  it('recordAnswersAndAppend answers full when the chat is at the cap and missing when the message is not in this member\'s chat — nothing written either way', async () => {
    execute.mockResolvedValueOnce({ rows: [{ appended: false, found: true }] });
    await expect(record()).resolves.toBe('full');
    execute.mockResolvedValueOnce({ rows: [{ appended: false, found: false }] });
    await expect(record()).resolves.toBe('missing');
    execute.mockResolvedValueOnce({ rows: [] });
    await expect(record()).resolves.toBe('missing');
  });
});
