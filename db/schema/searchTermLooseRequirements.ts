import { pgTable, uuid, smallint, boolean, text, timestamp, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { searchTerms } from './searchTerms';

/**
 * Precomputed search-side loose-match needles, one row per search_term.
 * See db/migrations/0018_search_term_loose_requirements.sql for the
 * full doc. The backfill + import path read this table to produce a
 * flat POSITION-based predicate instead of regenerating token forms
 * per kwm row.
 */
export const searchTermLooseRequirements = pgTable(
  'search_term_loose_requirements',
  {
    searchTermId: uuid('search_term_id')
      .primaryKey()
      .references(() => searchTerms.id, { onDelete: 'cascade' }),
    tokenCount: smallint('token_count').notNull(),
    overflow: boolean('overflow').notNull().default(false),

    t1f1: text('t1_f1'), t1f2: text('t1_f2'), t1f3: text('t1_f3'), t1f4: text('t1_f4'),
    t2f1: text('t2_f1'), t2f2: text('t2_f2'), t2f3: text('t2_f3'), t2f4: text('t2_f4'),
    t3f1: text('t3_f1'), t3f2: text('t3_f2'), t3f3: text('t3_f3'), t3f4: text('t3_f4'),
    t4f1: text('t4_f1'), t4f2: text('t4_f2'), t4f3: text('t4_f3'), t4f4: text('t4_f4'),
    t5f1: text('t5_f1'), t5f2: text('t5_f2'), t5f3: text('t5_f3'), t5f4: text('t5_f4'),
    t6f1: text('t6_f1'), t6f2: text('t6_f2'), t6f3: text('t6_f3'), t6f4: text('t6_f4'),
    t7f1: text('t7_f1'), t7f2: text('t7_f2'), t7f3: text('t7_f3'), t7f4: text('t7_f4'),
    t8f1: text('t8_f1'), t8f2: text('t8_f2'), t8f3: text('t8_f3'), t8f4: text('t8_f4'),

    logicVersion: smallint('logic_version').notNull().default(1),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    overflowIdx: index('search_term_loose_requirements_overflow_idx')
      .on(t.searchTermId)
      .where(sql`overflow IS TRUE`),
  }),
);

export type SearchTermLooseRequirement = typeof searchTermLooseRequirements.$inferSelect;
export type NewSearchTermLooseRequirement = typeof searchTermLooseRequirements.$inferInsert;

/** Number of token slots in the requirements table. Must match migration 0018. */
export const LOOSE_REQ_TOKEN_SLOTS = 8;
/** Number of form slots per token. Must match migration 0018. */
export const LOOSE_REQ_FORM_SLOTS = 4;
/** Logic version persisted with each row. Bump when matcher rules change. */
export const LOOSE_REQ_LOGIC_VERSION = 1;
