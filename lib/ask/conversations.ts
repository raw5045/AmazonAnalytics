import { sql } from 'drizzle-orm';
import type { UIMessage } from 'ai';
import { db } from '@/db/client';
import { ASK_LIMITS, type AskModelId } from './config';

/** Spec §7. Single-statement writes (neon-http has no transactions). */
export interface AskConversation {
  id: string; userId: string; title: string; model: AskModelId; messageCount: number; inFlightSince: Date | null; createdAt: Date; updatedAt: Date;
}
export type MessageStatus = 'complete' | 'stopped' | 'failed';
export type StoredMessage = { id: string; seq: number; role: 'user' | 'assistant'; parts: unknown[]; status: MessageStatus };
/** Message metadata the page reads (`metadata.status`); the turn adds `conversationId` on a first send. */
export interface AskMessageMetadata { status?: MessageStatus; conversationId?: string }
export type AskUIMessage = UIMessage<AskMessageMetadata>;
export type DeleteOutcome = 'deleted' | 'busy' | 'missing';

type ConvRow = { id: string; user_id: string; title: string; model: string; message_count: number; in_flight_since: string | Date | null; created_at: string | Date; updated_at: string | Date };
const toConv = (r: ConvRow): AskConversation => ({
  id: r.id, userId: r.user_id, title: r.title, model: r.model as AskModelId, messageCount: Number(r.message_count),
  inFlightSince: r.in_flight_since === null ? null : new Date(r.in_flight_since), createdAt: new Date(r.created_at), updatedAt: new Date(r.updated_at),
});
const CONV_COLUMNS = sql.raw('id, user_id, title, model, message_count, in_flight_since, created_at, updated_at');

export function titleFrom(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return 'New chat';
  return t.length > 60 ? `${t.slice(0, 60)}…` : t;
}

export function storedToUiMessage(m: StoredMessage): AskUIMessage {
  return { id: m.id, role: m.role, parts: m.parts as AskUIMessage['parts'], metadata: { status: m.status } };
}

export async function listConversations(userId: string): Promise<AskConversation[]> {
  const r = await db.execute<ConvRow>(sql`SELECT ${CONV_COLUMNS} FROM ask_conversations WHERE user_id = ${userId}::uuid ORDER BY updated_at DESC`);
  return r.rows.map(toConv);
}

export async function loadConversation(userId: string, id: string): Promise<{ conversation: AskConversation; messages: AskUIMessage[] } | null> {
  const c = await db.execute<ConvRow>(sql`SELECT ${CONV_COLUMNS} FROM ask_conversations WHERE id = ${id}::uuid AND user_id = ${userId}::uuid`);
  if (!c.rows[0]) return null;
  const m = await db.execute<StoredMessage>(sql`SELECT id, seq, role, parts, status FROM ask_messages WHERE conversation_id = ${id}::uuid ORDER BY seq`);
  return { conversation: toConv(c.rows[0]), messages: m.rows.map(storedToUiMessage) };
}

function firstText(message: Pick<AskUIMessage, 'parts'>): string {
  return message.parts.map((p) => (p.type === 'text' ? p.text : '')).join(' ');
}

/** Spec §7: created on the first send, in the same statement as its first message, only if the account row's conversation_count is under the cap. Returns 'cap' when at five. */
export async function createConversationWithFirstMessage(a: { userId: string; model: AskModelId; message: Pick<AskUIMessage, 'id' | 'parts'>; now: Date }): Promise<{ conversationId: string } | 'cap'> {
  const r = await db.execute<{ id: string }>(sql`
    WITH acct AS (
      UPDATE ask_accounts SET conversation_count = conversation_count + 1, updated_at = now()
      WHERE user_id = ${a.userId}::uuid AND conversation_count < ${sql.raw(String(ASK_LIMITS.maxChats))} RETURNING user_id
    ), conv AS (
      INSERT INTO ask_conversations (user_id, title, model, message_count, created_at, updated_at)
      SELECT user_id, ${titleFrom(firstText(a.message))}, ${a.model}, 1, ${a.now.toISOString()}::timestamptz, ${a.now.toISOString()}::timestamptz FROM acct RETURNING id
    ), msg AS (
      INSERT INTO ask_messages (id, conversation_id, seq, role, parts, status, created_at)
      SELECT ${a.message.id}::uuid, id, 1, 'user', ${JSON.stringify(a.message.parts)}::jsonb, 'complete', ${a.now.toISOString()}::timestamptz FROM conv RETURNING id
    )
    SELECT conv.id FROM conv, msg`);
  return r.rows[0] ? { conversationId: r.rows[0].id } : 'cap';
}

/** Appends under the per-chat cap; 'full' at 200. Owner-scoped. */
export async function appendUserMessage(a: { conversationId: string; userId: string; message: Pick<AskUIMessage, 'id' | 'parts'>; now: Date }): Promise<{ seq: number } | 'full'> {
  const r = await db.execute<{ seq: number }>(sql`
    WITH conv AS (
      UPDATE ask_conversations SET message_count = message_count + 1, updated_at = now()
      WHERE id = ${a.conversationId}::uuid AND user_id = ${a.userId}::uuid AND message_count < ${sql.raw(String(ASK_LIMITS.maxMessagesPerChat))}
      RETURNING id, message_count
    )
    INSERT INTO ask_messages (id, conversation_id, seq, role, parts, status, created_at)
    SELECT ${a.message.id}::uuid, id, message_count, 'user', ${JSON.stringify(a.message.parts)}::jsonb, 'complete', ${a.now.toISOString()}::timestamptz FROM conv RETURNING seq`);
  return r.rows[0] ? { seq: Number(r.rows[0].seq) } : 'full';
}

/** The assistant's message is appended even past the cap (it answers a message that was accepted), and touches updated_at. */
export async function appendAssistantMessage(a: { conversationId: string; message: Pick<AskUIMessage, 'id' | 'parts'>; status: MessageStatus; now: Date }): Promise<void> {
  await db.execute(sql`
    WITH conv AS (
      UPDATE ask_conversations SET message_count = message_count + 1, updated_at = now() WHERE id = ${a.conversationId}::uuid RETURNING id, message_count
    )
    INSERT INTO ask_messages (id, conversation_id, seq, role, parts, status, created_at)
    SELECT ${a.message.id}::uuid, id, message_count, 'assistant', ${JSON.stringify(a.message.parts)}::jsonb, ${a.status}, ${a.now.toISOString()}::timestamptz FROM conv RETURNING seq`);
}

/** Spec §7: one turn in flight per chat; a stale flag (crashed function) expires after five minutes. */
export async function acquireTurnLock(userId: string, conversationId: string): Promise<boolean> {
  const r = await db.execute(sql`
    UPDATE ask_conversations SET in_flight_since = now()
    WHERE id = ${conversationId}::uuid AND user_id = ${userId}::uuid
      AND (in_flight_since IS NULL OR in_flight_since < now() - interval '5 minutes')
    RETURNING id`);
  return r.rows.length > 0;
}
export async function releaseTurnLock(conversationId: string): Promise<void> {
  await db.execute(sql`UPDATE ask_conversations SET in_flight_since = NULL WHERE id = ${conversationId}::uuid`);
}

/**
 * Owner-scoped delete (spec §7 + the Task 2 review amendment): refused while a turn is in flight
 * (a fresh lock), so an answer can never be written into a chat that vanished under it. Messages
 * cascade; the account's count goes down in the same statement. When the DELETE removes nothing,
 * one owner-scoped existence check decides: a row that still exists is 'busy' (the member simply
 * retries), no row is 'missing'. `in_flight_since` is deliberately NOT re-read here — the turn's
 * `finally` may clear it between the two statements.
 */
export async function deleteConversation(userId: string, id: string): Promise<DeleteOutcome> {
  const r = await db.execute<{ id: string }>(sql`
    WITH gone AS (
      DELETE FROM ask_conversations
      WHERE id = ${id}::uuid AND user_id = ${userId}::uuid
        AND (in_flight_since IS NULL OR in_flight_since < now() - interval '5 minutes')
      RETURNING id, user_id
    ), acct AS (
      UPDATE ask_accounts SET conversation_count = GREATEST(0, conversation_count - 1), updated_at = now() WHERE user_id IN (SELECT user_id FROM gone) RETURNING user_id
    )
    SELECT id FROM gone`);
  if (r.rows.length > 0) return 'deleted';
  const exists = await db.execute<{ one: number }>(sql`SELECT 1 AS one FROM ask_conversations WHERE id = ${id}::uuid AND user_id = ${userId}::uuid`);
  return exists.rows.length > 0 ? 'busy' : 'missing';
}
