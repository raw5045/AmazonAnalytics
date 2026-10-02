import { describe, it, expect, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { grantAccess, getAccount } from '@/lib/ask/ledger';
import { createConversationWithFirstMessage, deleteConversation, listConversations, acquireTurnLock, releaseTurnLock, appendUserMessage, appendAssistantMessage, loadConversation, stampChangesApproved, recordAnswersAndAppend } from '@/lib/ask/conversations';
import { createTestUser, deleteTestUser } from './helpers';

// Run (owner-gated, after migration 0048): RUN_INTEGRATION=1 pnpm vitest run tests/integration/askConversations.test.ts
describe('ask conversations (integration, real Postgres)', () => {
  let userId: string | undefined;
  afterAll(async () => { await deleteTestUser(userId); });

  const msg = () => ({ id: crypto.randomUUID(), parts: [{ type: 'text' as const, text: 'hello there' }] });

  it('caps concurrent creates at five and decrements on delete', async () => {
    userId = (await createTestUser('itest')).id;
    const now = new Date();
    await grantAccess({ userId, allowanceMicro: 1, adminId: userId, now });
    const results = await Promise.all(Array.from({ length: 8 }, () => createConversationWithFirstMessage({ userId: userId!, model: 'claude-sonnet-5', message: msg(), now })));
    expect(results.filter((r) => r === 'cap')).toHaveLength(3);
    expect((await listConversations(userId))).toHaveLength(5);
    expect((await getAccount(userId))!.conversationCount).toBe(5);

    // Every chat from createConversationWithFirstMessage is born locked (in_flight_since = now()),
    // so it cannot be re-acquired or deleted until its first turn's onEnd releases it.
    const created = results.filter((r): r is { conversationId: string } => r !== 'cap');
    expect(await acquireTurnLock(userId, created[0].conversationId)).toBe(false); // born locked
    expect(await deleteConversation(userId, created[0].conversationId)).toBe('busy');
    for (const c of created) await releaseTurnLock(c.conversationId); // as the first turn's onEnd would

    const first = (await listConversations(userId))[0];
    expect(await deleteConversation(userId, first.id)).toBe('deleted');
    expect((await getAccount(userId))!.conversationCount).toBe(4);
    const gone = await db.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM ask_messages WHERE conversation_id = ${first.id}::uuid`);
    expect(Number(gone.rows[0].n)).toBe(0);
    expect(await deleteConversation(userId, crypto.randomUUID())).toBe('missing');
  });

  it('the turn lock admits one holder until released, and blocks deletion while held', async () => {
    const id = (await listConversations(userId!))[0].id;
    expect(await acquireTurnLock(userId!, id)).toBe(true);
    expect(await acquireTurnLock(userId!, id)).toBe(false);
    expect(await deleteConversation(userId!, id)).toBe('busy');
    expect((await getAccount(userId!))!.conversationCount).toBe(4);
    await releaseTurnLock(id);
    expect(await acquireTurnLock(userId!, id)).toBe(true);
    await releaseTurnLock(id);
  });

  it('appends messages up to and past the per-chat cap, and loadConversation returns them in order', async () => {
    const id = (await listConversations(userId!))[0].id;
    const now = new Date();
    expect(await appendUserMessage({ conversationId: id, userId: userId!, message: msg(), now })).toEqual({ seq: 2 });
    expect(await appendAssistantMessage({ conversationId: id, message: { id: crypto.randomUUID(), parts: [{ type: 'text' as const, text: 'here you go' }] }, status: 'stopped', now })).toBe(true);

    const loaded = (await loadConversation(userId!, id))!;
    expect(loaded.messages.map((m) => m.role)).toEqual(['user', 'user', 'assistant']);
    expect(loaded.messages.map((m) => m.metadata?.status)).toEqual(['complete', 'complete', 'stopped']);
    expect(loaded.messages[0].parts).toEqual([{ type: 'text', text: 'hello there' }]);
    expect(loaded.messages[2].parts).toEqual([{ type: 'text', text: 'here you go' }]);
    expect(loaded.conversation.messageCount).toBe(3);
    expect(loaded.conversation.createdAt).toBeInstanceOf(Date);
    expect(loaded.conversation.updatedAt).toBeInstanceOf(Date);

    // Force the chat to the cap without going through 198 real appends.
    await db.execute(sql`UPDATE ask_conversations SET message_count = 200 WHERE id = ${id}::uuid`);
    expect(await appendUserMessage({ conversationId: id, userId: userId!, message: msg(), now })).toBe('full');
    // The assistant's reply is never dropped for a full chat — it answers a message that was
    // already accepted, so it lands past the cap (seq 201) instead of being refused.
    expect(await appendAssistantMessage({ conversationId: id, message: { id: crypto.randomUUID(), parts: [{ type: 'text' as const, text: 'past the cap' }] }, status: 'complete', now })).toBe(true);
    const last = await db.execute<{ seq: number }>(sql`SELECT seq FROM ask_messages WHERE conversation_id = ${id}::uuid ORDER BY seq DESC LIMIT 1`);
    expect(last.rows[0].seq).toBe(201);
  });

  it('arc 4 (migration 0049): the changes stamp is first-wins and owner-scoped; recordAnswersAndAppend writes the answers and the hidden message together, or nothing', async () => {
    const now = new Date('2030-06-01T12:00:00Z');
    // The previous test forced one chat to the cap (message_count 200 + an assistant reply past it); the others hold one message each.
    const byCount = await db.execute<{ id: string; message_count: number }>(sql`SELECT id, message_count FROM ask_conversations WHERE user_id = ${userId}::uuid ORDER BY message_count DESC`);
    const full = byCount.rows[0].id;
    const open = byCount.rows[byCount.rows.length - 1].id;
    expect(byCount.rows[0].message_count).toBeGreaterThanOrEqual(200);
    expect(byCount.rows[byCount.rows.length - 1].message_count).toBeLessThan(10);

    // --- the stamp: first wins, re-stamping is a no-op that still answers true, another member writes nothing ---
    expect((await loadConversation(userId!, open))!.conversation.changesApprovedAt).toBeNull();
    expect(await stampChangesApproved(userId!, open, now)).toBe(true);
    expect(await stampChangesApproved(userId!, open, new Date('2030-06-02T00:00:00Z'))).toBe(true);
    expect((await loadConversation(userId!, open))!.conversation.changesApprovedAt).toEqual(now);
    const stranger = await createTestUser('itest');
    try {
      expect(await stampChangesApproved(stranger.id, open, new Date('2030-06-03T00:00:00Z'))).toBe(false);
    } finally {
      await deleteTestUser(stranger.id);
    }
    expect((await loadConversation(userId!, open))!.conversation.changesApprovedAt).toEqual(now);

    // --- record + append: one statement, all or nothing ---
    const paused = { id: crypto.randomUUID(), parts: [{ type: 'text', text: 'Saving.' }, { type: 'tool-create_saved_view', toolCallId: 'c1', state: 'approval-requested', input: { name: 'Lamps', search: {} }, approval: { id: 'ap_1' } }] };
    expect(await appendAssistantMessage({ conversationId: open, message: paused as never, status: 'complete', now })).toBe(true);
    const before = (await loadConversation(userId!, open))!;
    const answered = [paused.parts[0], { ...paused.parts[1], state: 'output-available', output: { view: { id: 'v1', name: 'Lamps' } }, approval: { id: 'ap_1', approved: true } }];
    const hidden = () => ({ id: crypto.randomUUID(), parts: [{ type: 'text' as const, text: '[approval-result] The person approved create_saved_view and it ran. Result: {"view":{"id":"v1","name":"Lamps"}}' }] });
    // A message id that belongs to another chat → 'missing', nothing written anywhere.
    expect(await recordAnswersAndAppend({ conversationId: full, userId: userId!, messageId: paused.id, parts: answered, message: hidden(), now })).toBe('missing');
    // A user-role message → 'missing' (the role guard).
    const userMessageId = before.messages.find((m) => m.role === 'user')!.id;
    expect(await recordAnswersAndAppend({ conversationId: open, userId: userId!, messageId: userMessageId, parts: answered, message: hidden(), now })).toBe('missing');
    // Another member → 'missing'.
    const stranger2 = await createTestUser('itest');
    try {
      expect(await recordAnswersAndAppend({ conversationId: open, userId: stranger2.id, messageId: paused.id, parts: answered, message: hidden(), now })).toBe('missing');
    } finally {
      await deleteTestUser(stranger2.id);
    }
    const untouched = (await loadConversation(userId!, open))!;
    expect(untouched.messages.map((m) => m.id)).toEqual(before.messages.map((m) => m.id));
    expect(untouched.conversation.messageCount).toBe(before.conversation.messageCount);
    expect(untouched.messages.find((m) => m.id === paused.id)!.parts[1]).toMatchObject({ state: 'approval-requested' });
    // Success: the parts are rewritten AND the hidden row exists with seq = the new count.
    const outcome = hidden();
    expect(await recordAnswersAndAppend({ conversationId: open, userId: userId!, messageId: paused.id, parts: answered, message: outcome, now })).toBe('ok');
    const after = (await loadConversation(userId!, open))!;
    expect(after.conversation.messageCount).toBe(before.conversation.messageCount + 1);
    expect(after.messages.find((m) => m.id === paused.id)!.parts[1]).toMatchObject({ state: 'output-available', output: { view: { id: 'v1', name: 'Lamps' } }, approval: { id: 'ap_1', approved: true } });
    const last = after.messages[after.messages.length - 1];
    expect([last.id, last.role]).toEqual([outcome.id, 'user']);
    const seqRow = await db.execute<{ seq: number; n: number }>(sql`SELECT m.seq, c.message_count AS n FROM ask_messages m JOIN ask_conversations c ON c.id = m.conversation_id WHERE m.id = ${outcome.id}::uuid`);
    expect(seqRow.rows[0].seq).toBe(seqRow.rows[0].n);
    // A full chat → 'full': neither the parts nor a new row.
    const fullLast = await db.execute<{ id: string }>(sql`SELECT id FROM ask_messages WHERE conversation_id = ${full}::uuid AND role = 'assistant' ORDER BY seq DESC LIMIT 1`);
    const snapshot = () => db.execute<{ n: string; parts: unknown }>(sql`SELECT (SELECT count(*) FROM ask_messages WHERE conversation_id = ${full}::uuid)::text AS n, parts FROM ask_messages WHERE id = ${fullLast.rows[0].id}::uuid`);
    const fullBefore = await snapshot();
    expect(await recordAnswersAndAppend({ conversationId: full, userId: userId!, messageId: fullLast.rows[0].id, parts: answered, message: hidden(), now })).toBe('full');
    expect((await snapshot()).rows[0]).toEqual(fullBefore.rows[0]);
  });

  it('deleting the user cascades every ask_* row', async () => {
    const uid = userId!;
    await deleteTestUser(uid);
    userId = undefined;
    for (const table of ['ask_conversations', 'ask_accounts', 'ask_ledger']) {
      const r = await db.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM ${sql.raw(table)} WHERE user_id = ${uid}::uuid`);
      expect(Number(r.rows[0].n)).toBe(0);
    }
  });
});
