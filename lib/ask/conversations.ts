import { sql } from 'drizzle-orm';
import type { UIMessage } from 'ai';
import { db } from '@/db/client';
import { ASK_LIMITS, isAskModelId, type AskModelId } from './config';

/** Spec §7. Single-statement writes (neon-http has no transactions). */
export interface AskConversation {
  id: string; userId: string; title: string; model: AskModelId; messageCount: number; inFlightSince: Date | null; changesApprovedAt: Date | null; createdAt: Date; updatedAt: Date;
}
export type MessageStatus = 'complete' | 'stopped' | 'failed';
export type StoredMessage = { id: string; seq: number; role: 'user' | 'assistant'; parts: unknown[]; status: MessageStatus };
/**
 * Message metadata the page reads (`metadata.status`); the turn adds `conversationId` on a first
 * send. `finishReason` and `stopReason` are set live as the turn streams (lib/ask/turn.ts) — the
 * model's own finish reason on a `finish` part, or why an `abort` part happened (the turn deadline
 * vs. a member-initiated Stop/closed tab), merged into the message's metadata as they arrive.
 */
export interface AskMessageMetadata { status?: MessageStatus; conversationId?: string; finishReason?: string; stopReason?: 'deadline' | 'user' }
export type AskUIMessage = UIMessage<AskMessageMetadata>;
export type DeleteOutcome = 'deleted' | 'busy' | 'missing';

type ConvRow = { id: string; user_id: string; title: string; model: string; message_count: number; in_flight_since: string | Date | null; changes_approved_at: string | Date | null; created_at: string | Date; updated_at: string | Date };

/** Throws on a model the code no longer recognizes: retiring a model id needs a data migration, not a silent pass-through. */
function toConv(r: ConvRow): AskConversation {
  if (!isAskModelId(r.model)) throw new Error(`ask_conversations ${r.id} has unknown model ${r.model}; retiring a model needs a data migration`);
  return {
    id: r.id, userId: r.user_id, title: r.title, model: r.model, messageCount: Number(r.message_count),
    inFlightSince: r.in_flight_since === null ? null : new Date(r.in_flight_since),
    // The undefined guard: a missing column reads as not approved, so the card shows.
    changesApprovedAt: r.changes_approved_at === null || r.changes_approved_at === undefined ? null : new Date(r.changes_approved_at),
    createdAt: new Date(r.created_at), updatedAt: new Date(r.updated_at),
  };
}
const CONV_COLUMNS = sql.raw('id, user_id, title, model, message_count, in_flight_since, changes_approved_at, created_at, updated_at');
/** Spec §7: a stale in-flight flag (the route crashed mid-turn) expires this long after it was set. */
const IN_FLIGHT_EXPIRY = sql.raw(`interval '${ASK_LIMITS.inFlightExpiryMinutes} minutes'`);

/** Collapses whitespace and cuts by Unicode code point (never mid-surrogate-pair — a lone surrogate cannot be stored as UTF-8; expect the statement to be rejected). */
export function titleFrom(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return 'New chat';
  const cps = Array.from(t);
  return cps.length > 60 ? `${cps.slice(0, 60).join('').trimEnd()}…` : t;
}

export function storedToUiMessage(m: StoredMessage): AskUIMessage {
  return { id: m.id, role: m.role, parts: m.parts as AskUIMessage['parts'], metadata: { status: m.status } };
}

/**
 * Strips U+0000 and repairs lone surrogates before something is stored — Postgres rejects both
 * outright (Task 8 review, I1/M6c). The chat route's own zod schema already sanitises the member's
 * first-turn message text in the request body the same way, but nothing upstream cleans an
 * assistant message's parts (they come straight from the model's output) or the title text
 * re-derived from a first message here, so this file cleans at the DB boundary rather than
 * trusting a caller (Task 8 re-review): `cleanPartsJson` for a parts array
 * (createConversationWithFirstMessage, appendUserMessage, appendAssistantMessage and
 * recordAnswersAndAppend all use it), `cleanString` for the plain text a title is cut from.
 */
function cleanString(s: string): string {
  return s.replaceAll('\u0000', '').toWellFormed();
}

function cleanPartsJson(parts: unknown[]): string {
  return JSON.stringify(parts, (_k, v) => (typeof v === 'string' ? cleanString(v) : v));
}

export async function listConversations(userId: string): Promise<AskConversation[]> {
  const r = await db.execute<ConvRow>(sql`SELECT ${CONV_COLUMNS} FROM ask_conversations WHERE user_id = ${userId}::uuid ORDER BY updated_at DESC`);
  return r.rows.map(toConv);
}

/** Full history by default; pass `lastN` (Task 8 uses `ASK_LIMITS.historyWindowMessages`) to fetch only the newest N messages — the route's history window, not the page's, which always loads everything. */
export async function loadConversation(userId: string, id: string, opts?: { lastN?: number }): Promise<{ conversation: AskConversation; messages: AskUIMessage[] } | null> {
  const lastN = opts?.lastN;
  if (lastN !== undefined && (!Number.isSafeInteger(lastN) || lastN <= 0)) {
    throw new Error('loadConversation: lastN must be a positive safe integer');
  }
  const c = await db.execute<ConvRow>(sql`SELECT ${CONV_COLUMNS} FROM ask_conversations WHERE id = ${id}::uuid AND user_id = ${userId}::uuid`);
  if (!c.rows[0]) return null;
  const m = lastN
    ? await db.execute<StoredMessage>(sql`SELECT id, seq, role, parts, status FROM ask_messages WHERE conversation_id = ${id}::uuid ORDER BY seq DESC LIMIT ${lastN}`)
    : await db.execute<StoredMessage>(sql`SELECT id, seq, role, parts, status FROM ask_messages WHERE conversation_id = ${id}::uuid ORDER BY seq`);
  const rows = lastN ? [...m.rows].reverse() : m.rows;
  return { conversation: toConv(c.rows[0]), messages: rows.map(storedToUiMessage) };
}

function firstText(message: Pick<AskUIMessage, 'parts'>): string {
  return message.parts.map((p) => (p.type === 'text' ? p.text : '')).join(' ');
}

/**
 * Spec §7: created on the first send, in the same statement as its first message, only if the
 * account row's conversation_count is under the cap. Returns 'cap' when at five, and also when no
 * ask_accounts row exists at all — the route's gates (ledger.ensureAccount / the access checks)
 * guarantee one exists before this is ever called, so a missing row is treated the same as a full
 * one rather than crashing.
 *
 * Inserted already locked (`in_flight_since = now()`): the first send's own turn is about to start
 * streaming, so there is no separate acquireTurnLock round trip and no window where the chat
 * exists but is unlocked (Task 8's route relies on this — it creates and starts the turn without
 * an extra lock call).
 */
export async function createConversationWithFirstMessage(a: { userId: string; model: AskModelId; message: Pick<AskUIMessage, 'id' | 'parts'>; now: Date }): Promise<{ conversationId: string } | 'cap'> {
  const r = await db.execute<{ id: string }>(sql`
    WITH acct AS (
      UPDATE ask_accounts SET conversation_count = conversation_count + 1, updated_at = now()
      WHERE user_id = ${a.userId}::uuid AND conversation_count < ${sql.raw(String(ASK_LIMITS.maxChats))} RETURNING user_id
    ), conv AS (
      INSERT INTO ask_conversations (user_id, title, model, message_count, in_flight_since, created_at, updated_at)
      SELECT user_id, ${titleFrom(cleanString(firstText(a.message)))}, ${a.model}, 1, now(), ${a.now.toISOString()}::timestamptz, ${a.now.toISOString()}::timestamptz FROM acct RETURNING id
    ), msg AS (
      INSERT INTO ask_messages (id, conversation_id, seq, role, parts, status, created_at)
      SELECT ${a.message.id}::uuid, id, 1, 'user', ${cleanPartsJson(a.message.parts)}::jsonb, 'complete', ${a.now.toISOString()}::timestamptz FROM conv RETURNING id
    )
    SELECT conv.id FROM conv, msg`);
  return r.rows[0] ? { conversationId: r.rows[0].id } : 'cap';
}

/**
 * Appends under the per-chat cap; 'full' at 200 — also for a chat that is missing or not owned by
 * `userId`, since the route always loads and locks the chat before appending, so those cases are
 * already ruled out by the time this runs and get the same "can't append" answer as a full chat.
 * Owner-scoped.
 */
export async function appendUserMessage(a: { conversationId: string; userId: string; message: Pick<AskUIMessage, 'id' | 'parts'>; now: Date }): Promise<{ seq: number } | 'full'> {
  const r = await db.execute<{ seq: number }>(sql`
    WITH conv AS (
      UPDATE ask_conversations SET message_count = message_count + 1, updated_at = now()
      WHERE id = ${a.conversationId}::uuid AND user_id = ${a.userId}::uuid AND message_count < ${sql.raw(String(ASK_LIMITS.maxMessagesPerChat))}
      RETURNING id, message_count
    )
    INSERT INTO ask_messages (id, conversation_id, seq, role, parts, status, created_at)
    SELECT ${a.message.id}::uuid, id, message_count, 'user', ${cleanPartsJson(a.message.parts)}::jsonb, 'complete', ${a.now.toISOString()}::timestamptz FROM conv RETURNING seq`);
  return r.rows[0] ? { seq: Number(r.rows[0].seq) } : 'full';
}

/**
 * The assistant's message is appended even past the cap (it answers a message that was accepted),
 * and touches updated_at. Returns whether the chat still existed to receive it (false when the
 * conversation was deleted while the turn was streaming) so the route can log an answer that could
 * not be saved instead of silently dropping it.
 */
export async function appendAssistantMessage(a: { conversationId: string; message: Pick<AskUIMessage, 'id' | 'parts'>; status: MessageStatus; now: Date }): Promise<boolean> {
  const r = await db.execute(sql`
    WITH conv AS (
      UPDATE ask_conversations SET message_count = message_count + 1, updated_at = now() WHERE id = ${a.conversationId}::uuid RETURNING id, message_count
    )
    INSERT INTO ask_messages (id, conversation_id, seq, role, parts, status, created_at)
    SELECT ${a.message.id}::uuid, id, message_count, 'assistant', ${cleanPartsJson(a.message.parts)}::jsonb, ${a.status}, ${a.now.toISOString()}::timestamptz FROM conv RETURNING seq`);
  return r.rows.length > 0;
}

/** Spec §7: one turn in flight per chat; a stale flag (crashed function) expires after ASK_LIMITS.inFlightExpiryMinutes. */
export async function acquireTurnLock(userId: string, conversationId: string): Promise<boolean> {
  const r = await db.execute(sql`
    UPDATE ask_conversations SET in_flight_since = now()
    WHERE id = ${conversationId}::uuid AND user_id = ${userId}::uuid
      AND (in_flight_since IS NULL OR in_flight_since < now() - ${IN_FLIGHT_EXPIRY})
    RETURNING id`);
  return r.rows.length > 0;
}

/**
 * Unconditional: the lock carries no holder token, so this clears `in_flight_since` for whichever
 * chat id it's given regardless of who set it — it does not check that the caller is still the
 * turn that acquired it. That is safe only because the route's `maxDuration` (300s) cannot outlive
 * the `ASK_LIMITS.inFlightExpiryMinutes`-minute expiry (5 minutes = 300s) acquireTurnLock enforces:
 * the platform kills an overrunning turn no later than the moment its own lock would have gone
 * stale anyway, so no other turn is ever still genuinely in flight when this runs.
 */
export async function releaseTurnLock(conversationId: string): Promise<void> {
  await db.execute(sql`UPDATE ask_conversations SET in_flight_since = NULL WHERE id = ${conversationId}::uuid`);
}

/**
 * Spec 2026-10-01 §6: "Approve" on a change card allows changes for the rest of this chat. First
 * stamp wins; never cleared by the app. True when the chat is this member's, including one that
 * was already stamped (the earlier stamp is kept); false when the chat is missing or not theirs.
 */
export async function stampChangesApproved(userId: string, conversationId: string, now: Date): Promise<boolean> {
  const r = await db.execute(sql`
    UPDATE ask_conversations SET changes_approved_at = COALESCE(changes_approved_at, ${now.toISOString()}::timestamptz)
    WHERE id = ${conversationId}::uuid AND user_id = ${userId}::uuid RETURNING id`);
  return r.rows.length > 0;
}

/** recordAnswersAndAppend's result. 'ok': both written. 'full' and 'missing': nothing written. */
export type RecordAndAppendResult = 'ok' | 'full' | 'missing';

/**
 * Spec 2026-10-01 §6: records the answers to a chat's approval cards on the stored assistant message
 * that asked (its parts rewritten: output-available / output-denied) AND appends the hidden outcome
 * message the model continues from, in ONE statement — so the cards never read as answered without
 * that message after them (two statements could fail in between: a retry then found nothing open
 * and the model never learned the outcome). Each write runs only when the other can:
 * - the parts rewrite: that message id, in that chat, `role = 'assistant'` (never a member's message
 *   or an outcome message), and only together with the append's bump;
 * - the append mirrors appendUserMessage exactly (owner-scoped, under ASK_LIMITS.maxMessagesPerChat,
 *   message_count and updated_at bumped, seq = the new count), and only when the message that asked
 *   is in this member's chat.
 * 'full': the chat is at the cap. 'missing': no such assistant message in this member's chat.
 * Precondition, as for every write here: the route holds the chat's lock (acquired and loaded under
 * the member's id), and `messageId` comes from that loaded history, never from a request body.
 */
export async function recordAnswersAndAppend(a: {
  conversationId: string; userId: string; messageId: string; parts: unknown[]; message: Pick<AskUIMessage, 'id' | 'parts'>; now: Date;
}): Promise<RecordAndAppendResult> {
  const r = await db.execute<{ appended: boolean; found: boolean }>(sql`
    WITH target AS (
      SELECT m.id FROM ask_messages m JOIN ask_conversations c ON c.id = m.conversation_id
      WHERE m.id = ${a.messageId}::uuid AND m.conversation_id = ${a.conversationId}::uuid AND m.role = 'assistant' AND c.user_id = ${a.userId}::uuid
    ), conv AS (
      UPDATE ask_conversations SET message_count = message_count + 1, updated_at = now()
      WHERE id = ${a.conversationId}::uuid AND user_id = ${a.userId}::uuid AND message_count < ${sql.raw(String(ASK_LIMITS.maxMessagesPerChat))}
        AND EXISTS (SELECT 1 FROM target)
      RETURNING id, message_count
    ), rec AS (
      UPDATE ask_messages SET parts = ${cleanPartsJson(a.parts)}::jsonb
      WHERE id = ${a.messageId}::uuid AND conversation_id = ${a.conversationId}::uuid AND role = 'assistant' AND EXISTS (SELECT 1 FROM conv)
      RETURNING id
    ), msg AS (
      INSERT INTO ask_messages (id, conversation_id, seq, role, parts, status, created_at)
      SELECT ${a.message.id}::uuid, conv.id, conv.message_count, 'user', ${cleanPartsJson(a.message.parts)}::jsonb, 'complete', ${a.now.toISOString()}::timestamptz FROM conv, rec
      RETURNING seq
    )
    SELECT EXISTS (SELECT 1 FROM msg) AS appended, EXISTS (SELECT 1 FROM target) AS found`);
  const row = r.rows[0];
  if (row?.appended === true) return 'ok';
  return row?.found === true ? 'full' : 'missing';
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
        AND (in_flight_since IS NULL OR in_flight_since < now() - ${IN_FLIGHT_EXPIRY})
      RETURNING id, user_id
    ), acct AS (
      UPDATE ask_accounts SET conversation_count = GREATEST(0, conversation_count - 1), updated_at = now() WHERE user_id IN (SELECT user_id FROM gone) RETURNING user_id
    )
    SELECT id FROM gone`);
  if (r.rows.length > 0) return 'deleted';
  const exists = await db.execute<{ one: number }>(sql`SELECT 1 AS one FROM ask_conversations WHERE id = ${id}::uuid AND user_id = ${userId}::uuid`);
  return exists.rows.length > 0 ? 'busy' : 'missing';
}
