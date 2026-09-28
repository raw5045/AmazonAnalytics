import { describe, it, expect, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { grantAccess, getAccount } from '@/lib/ask/ledger';
import { createConversationWithFirstMessage, deleteConversation, listConversations, acquireTurnLock, releaseTurnLock } from '@/lib/ask/conversations';
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
    await releaseTurnLock(id);
    expect(await acquireTurnLock(userId!, id)).toBe(true);
    await releaseTurnLock(id);
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
