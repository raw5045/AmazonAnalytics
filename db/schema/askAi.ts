import { sql } from 'drizzle-orm';
import { pgTable, uuid, varchar, text, integer, bigint, boolean, date, jsonb, timestamp, index, check, unique } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * Ask AI (spec §8, migration 0048). Typing and reads only — every atomic write goes through
 * single-statement SQL in lib/ask/{ledger,conversations}.ts because neon-http has no transactions.
 * Money columns are integer micro-dollars (bigint in Postgres, read as JS numbers: well under 2^53).
 */
export const askConversations = pgTable(
  'ask_conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    model: varchar('model', { length: 64 }).notNull(),
    messageCount: integer('message_count').notNull().default(0),
    inFlightSince: timestamp('in_flight_since', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ userUpdatedIdx: index('ask_conversations_user_updated_idx').on(t.userId, t.updatedAt) }),
);
export type AskConversationRow = typeof askConversations.$inferSelect;

export const askMessages = pgTable(
  'ask_messages',
  {
    id: uuid('id').primaryKey(),
    conversationId: uuid('conversation_id').notNull().references(() => askConversations.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    role: varchar('role', { length: 16 }).notNull(),
    parts: jsonb('parts').notNull(),
    status: varchar('status', { length: 16 }).notNull().default('complete'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    conversationSeq: unique('ask_messages_conversation_seq_key').on(t.conversationId, t.seq),
    roleCheck: check('ask_messages_role_check', sql`${t.role} IN ('user','assistant')`),
    statusCheck: check('ask_messages_status_check', sql`${t.status} IN ('complete','stopped','failed')`),
  }),
);
export type AskMessageRow = typeof askMessages.$inferSelect;

export const askAccounts = pgTable('ask_accounts', {
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  access: boolean('access').notNull().default(true),
  monthlyAllowanceMicro: bigint('monthly_allowance_micro', { mode: 'number' }).notNull().default(10_000_000),
  allowanceUsedMicro: bigint('allowance_used_micro', { mode: 'number' }).notNull().default(0),
  periodStart: date('period_start').notNull(),
  creditMicro: bigint('credit_micro', { mode: 'number' }).notNull().default(0),
  conversationCount: integer('conversation_count').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
export type AskAccountRow = typeof askAccounts.$inferSelect;

export const askLedger = pgTable(
  'ask_ledger',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedByDefaultAsIdentity(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 24 }).notNull(),
    amountMicro: bigint('amount_micro', { mode: 'number' }).notNull(),
    conversationId: uuid('conversation_id').references(() => askConversations.id, { onDelete: 'set null' }),
    messageId: uuid('message_id'),
    model: varchar('model', { length: 64 }),
    inputTokens: integer('input_tokens'),
    cacheWriteTokens: integer('cache_write_tokens'),
    cacheReadTokens: integer('cache_read_tokens'),
    outputTokens: integer('output_tokens'),
    fromAllowanceMicro: bigint('from_allowance_micro', { mode: 'number' }),
    fromCreditMicro: bigint('from_credit_micro', { mode: 'number' }),
    absorbedMicro: bigint('absorbed_micro', { mode: 'number' }),
    note: text('note'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userCreatedIdx: index('ask_ledger_user_created_idx').on(t.userId, t.createdAt),
    createdIdx: index('ask_ledger_created_idx').on(t.createdAt),
    kindCheck: check('ask_ledger_kind_check', sql`${t.kind} IN ('allowance_reset','grant','credit','usage','adjustment','revoke')`),
  }),
);
export type AskLedgerRow = typeof askLedger.$inferSelect;

export const askGlobalUsage = pgTable('ask_global_usage', {
  month: date('month').primaryKey(),
  costMicro: bigint('cost_micro', { mode: 'number' }).notNull().default(0),
  questions: integer('questions').notNull().default(0),
  alerted80At: timestamp('alerted_80_at', { withTimezone: true }),
  alerted100At: timestamp('alerted_100_at', { withTimezone: true }),
});
export type AskGlobalUsageRow = typeof askGlobalUsage.$inferSelect;
