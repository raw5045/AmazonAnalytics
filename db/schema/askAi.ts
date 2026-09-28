import { sql } from 'drizzle-orm';
import { pgTable, uuid, varchar, text, integer, bigint, bigserial, boolean, date, jsonb, timestamp, index, check, unique } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * Ask AI (spec §8, migration 0048). Typing and reads only — every atomic write goes through
 * single-statement SQL in lib/ask/{ledger,conversations}.ts because neon-http has no transactions.
 * Money columns are integer micro-dollars (bigint in Postgres, read as JS numbers: well under 2^53).
 *
 * That JS-number mapping is Drizzle's own column read path — it does not apply to a raw
 * `db.execute(sql\`...\`)` over neon-http, which returns `bigint` columns as strings and `date`
 * columns as JS `Date` objects. Raw readers (lib/ask/ledger.ts) must cast explicitly: `Number(...)`
 * for the bigint/micro-dollar columns, and `::text` in the SQL for a date column read raw.
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
  (t) => ({ userUpdatedIdx: index('ask_conversations_user_updated_idx').on(t.userId, t.updatedAt.desc()) }),
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

export const askAccounts = pgTable(
  'ask_accounts',
  {
    userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
    access: boolean('access').notNull().default(true),
    monthlyAllowanceMicro: bigint('monthly_allowance_micro', { mode: 'number' }).notNull().default(10_000_000),
    allowanceUsedMicro: bigint('allowance_used_micro', { mode: 'number' }).notNull().default(0),
    periodStart: date('period_start').notNull(),
    creditMicro: bigint('credit_micro', { mode: 'number' }).notNull().default(0),
    /**
     * Invariant: equals this member's row count in ask_conversations. Maintained only by
     * lib/ask/conversations.ts (create and delete, Task 6) as part of the same single statement
     * that inserts/deletes the conversation. A delete made outside that module (manual SQL, a
     * future retention job) must repair it:
     *   UPDATE ask_accounts a SET conversation_count = c.n FROM (
     *     SELECT a2.user_id, count(c2.id)::int AS n FROM ask_accounts a2
     *     LEFT JOIN ask_conversations c2 ON c2.user_id = a2.user_id GROUP BY 1
     *   ) c WHERE c.user_id = a.user_id AND a.conversation_count <> c.n;
     */
    conversationCount: integer('conversation_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Task 5 code review: no SQL path (settleTurn's split, an admin op, a future retention job)
    // can drive the ledger negative — belt-and-suspenders alongside the application-level guards
    // in lib/ask/ledger.ts (settleTurn, grantAccess, setAllowance, addCredit all validate first).
    nonnegativeCheck: check(
      'ask_accounts_nonnegative_check',
      sql`${t.creditMicro} >= 0 AND ${t.allowanceUsedMicro} >= 0 AND ${t.monthlyAllowanceMicro} >= 0 AND ${t.conversationCount} >= 0`,
    ),
  }),
);
export type AskAccountRow = typeof askAccounts.$inferSelect;

export const askLedger = pgTable(
  'ask_ledger',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 24 }).notNull(),
    /**
     * Semantics depend on `kind` — never sum this column blindly across kinds:
     * - 'usage', 'credit': a DELTA (usage is negative, the cost just charged; credit is positive,
     *   the amount just added to credit_micro).
     * - 'grant', 'adjustment', 'allowance_reset': a LEVEL (the resulting monthly_allowance_micro
     *   value — grant/adjustment set it directly, allowance_reset records what the new period
     *   starts with), not a change relative to the previous value.
     * - 'revoke': always 0, a marker with no amount of its own.
     */
    amountMicro: bigint('amount_micro', { mode: 'number' }).notNull(),
    // no FK: append-only audit; a chat deleted mid-answer must never abort the settle (see spec §8 amendment)
    conversationId: uuid('conversation_id'),
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
    userCreatedIdx: index('ask_ledger_user_created_idx').on(t.userId, t.createdAt.desc()),
    createdIdx: index('ask_ledger_created_idx').on(t.createdAt),
    createdByIdx: index('ask_ledger_created_by_idx').on(t.createdBy).where(sql`${t.createdBy} IS NOT NULL`),
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
