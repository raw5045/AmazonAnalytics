import { pgTable, uuid, integer, date, varchar, text, timestamp, index } from 'drizzle-orm/pg-core';
import { uploadedFiles } from './uploads';
import { searchTerms } from './searchTerms';

/**
 * Audit log of duplicate search-term groups detected during a CSV
 * import. Populated by the dedup CTE in the kwm INSERT — every group
 * with `count(*) > 1` lands here so we can:
 *   - Verify the fix is actually catching duplicates
 *   - Spot if Amazon changes the export format and the noise pattern
 *     disappears or shifts
 *   - Investigate specific keywords post-hoc when ranks look weird
 *
 * One row per (file, week, search_term_id) with at least 2 candidate
 * rows during dedup. The winning rank is the LOWEST among the group;
 * `losing_ranks` lists all the ones we dropped.
 */
export const importDuplicateSearchTerms = pgTable(
  'import_duplicate_search_terms',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    uploadedFileId: uuid('uploaded_file_id')
      .notNull()
      .references(() => uploadedFiles.id),
    weekEndDate: date('week_end_date').notNull(),
    searchTermId: uuid('search_term_id')
      .notNull()
      .references(() => searchTerms.id),
    searchTermNormalized: varchar('search_term_normalized', { length: 512 }).notNull(),
    /** How many candidate rows existed in this group (always >= 2). */
    duplicateCount: integer('duplicate_count').notNull(),
    /** The rank we kept (lowest among the candidates). */
    winningRank: integer('winning_rank').notNull(),
    /** All ranks in the group, sorted ascending. winning_ranks[0] = winningRank. */
    losingRanks: integer('losing_ranks').array().notNull(),
    /**
     * Up to 3 example raw values from the duplicate group (truncated
     * to 200 chars each), so we can eyeball whether the noise pattern
     * is what we expected.
     */
    rawExamples: text('raw_examples').array().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    fileIdx: index('idst_file_idx').on(t.uploadedFileId),
    weekIdx: index('idst_week_idx').on(t.weekEndDate),
    // Serves the detail page's per-keyword reads (migration 0042): the
    // variants box (term + week) and the raw-history variants read (term
    // only, via the leading column) — the latter was a seq scan before.
    termWeekIdx: index('idst_term_week_idx').on(t.searchTermId, t.weekEndDate),
  }),
);

export type ImportDuplicateSearchTerm = typeof importDuplicateSearchTerms.$inferSelect;
export type NewImportDuplicateSearchTerm = typeof importDuplicateSearchTerms.$inferInsert;
