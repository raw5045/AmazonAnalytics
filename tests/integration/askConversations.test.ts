import { describe, it, expect, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { grantAccess, getAccount } from '@/lib/ask/ledger';
import { createConversationWithFirstMessage, deleteConversation, listConversations, acquireTurnLock, releaseTurnLock, appendUserMessage, appendAssistantMessage, loadConversation } from '@/lib/ask/conversations';
import { createTestUser, deleteTestUser } from './helpers';

// Run (owner-gated, after migration 0048): cross-env RUN_INTEGRATION=1 pnpm vitest run tests/integration/askConversations.test.ts
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
