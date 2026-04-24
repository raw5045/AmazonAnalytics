import { pgTable, bigserial, uuid, text, timestamp, bigint, jsonb } from 'drizzle-orm/pg-core';
import { uploadedFiles } from './uploads';

/**
 * Per-phase timing log for file imports. One row per phase per file.
 *
 * Enables data-driven optimization decisions — before this, we were guessing
 * at which pipeline step dominated import time. Written at the end of each
 * phase of processFileImport; cheap (single INSERT, no indexes besides PK),
 * so the overhead is negligible even on the hot path.
 *
 * Example queries:
 *   SELECT phase, AVG(duration_ms), MAX(duration_ms), AVG(rows_affected)
 *   FROM import_phase_timings
 *   WHERE started_at > NOW() - INTERVAL '1 day'
 *   GROUP BY phase ORDER BY AVG(duration_ms) DESC;
 */
export const importPhaseTimings = pgTable('import_phase_timings', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  uploadedFileId: uuid('uploaded_file_id')
    .notNull()
    .references(() => uploadedFiles.id, { onDelete: 'cascade' }),
  phase: text('phase').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  endedAt: timestamp('ended_at', { withTimezone: true }).notNull(),
  durationMs: bigint('duration_ms', { mode: 'number' }).notNull(),
  rowsAffected: bigint('rows_affected', { mode: 'number' }),
  notes: jsonb('notes'),
});

export type ImportPhaseTiming = typeof importPhaseTimings.$inferSelect;
export type NewImportPhaseTiming = typeof importPhaseTimings.$inferInsert;
