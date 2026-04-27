import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  pgEnum,
  jsonb,
  integer,
  boolean,
  date,
  text,
} from 'drizzle-orm/pg-core';
import { users } from './users';
import { schemaVersions } from './schemaVersions';

export const batchTypeEnum = pgEnum('batch_type', ['single_csv', 'zip_backfill']);
export const batchStatusEnum = pgEnum('batch_status', [
  'uploaded',
  'validating',
  'clean',
  'partial_review',
  'blocked',
  'importing',
  'imported',
  'imported_partial',
  'failed',
]);
export const validationStatusEnum = pgEnum('validation_status', [
  'pending',
  'pass',
  'pass_with_warnings',
  'fail',
  'import_failed',
  'imported',
]);
export const ingestionSeverityEnum = pgEnum('ingestion_severity', ['error', 'warning', 'info']);
export const fakeVolumeEvalStatusEnum = pgEnum('fake_volume_eval_status', [
  'evaluated',
  'unknown_missing_conversion',
  'unknown_missing_click',
]);

export const uploadBatches = pgTable('upload_batches', {
  id: uuid('id').primaryKey().defaultRandom(),
  batchType: batchTypeEnum('batch_type').notNull(),
  status: batchStatusEnum('status').notNull().default('uploaded'),
  schemaVersionId: uuid('schema_version_id').references(() => schemaVersions.id),
  failureThresholdPct: integer('failure_threshold_pct').notNull().default(10),
  totalFiles: integer('total_files').notNull().default(0),
  passedFiles: integer('passed_files').notNull().default(0),
  warningFiles: integer('warning_files').notNull().default(0),
  failedFiles: integer('failed_files').notNull().default(0),
  createdByUserId: uuid('created_by_user_id')
    .notNull()
    .references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  summaryJson: jsonb('summary_json'),
});

export const uploadedFiles = pgTable('uploaded_files', {
  id: uuid('id').primaryKey().defaultRandom(),
  batchId: uuid('batch_id')
    .notNull()
    .references(() => uploadBatches.id),
  schemaVersionId: uuid('schema_version_id').references(() => schemaVersions.id),
  storageKey: varchar('storage_key', { length: 1024 }).notNull(),
  originalFilename: varchar('original_filename', { length: 512 }).notNull(),
  fileChecksum: varchar('file_checksum', { length: 64 }),
  weekEndDate: date('week_end_date'),
  weekStartDate: date('week_start_date'),
  reportingDateRaw: varchar('reporting_date_raw', { length: 64 }),
  metadataRowRaw: text('metadata_row_raw'),
  validationStatus: validationStatusEnum('validation_status').notNull().default('pending'),
  validationErrorsJson: jsonb('validation_errors_json'),
  validationWarningsJson: jsonb('validation_warnings_json'),
  validationInfoJson: jsonb('validation_info_json'),
  rowCountRaw: integer('row_count_raw'),
  rowCountLoaded: integer('row_count_loaded'),
  isReplacement: boolean('is_replacement').notNull().default(false),
  replacesFileId: uuid('replaces_file_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  importedAt: timestamp('imported_at', { withTimezone: true }),
  replacedAt: timestamp('replaced_at', { withTimezone: true }),
  // Set when a background import job takes ownership of this file.
  // Together with import_heartbeat_at below, forms a DB-level mutex against
  // duplicate work when Inngest's transport-level retries cause multiple
  // invocations of processFileImport for the same file.
  importStartedAt: timestamp('import_started_at', { withTimezone: true }),
  // Updated every 60s by the running import job. Lock is considered
  // "orphaned" (the previous worker died) if heartbeat is > 3 min stale.
  // Keeps the lock honest when imports run longer than the startedAt-based
  // fixed expiry — necessary because imports now routinely exceed 60 min
  // as the DB grows.
  importHeartbeatAt: timestamp('import_heartbeat_at', { withTimezone: true }),
  // Live phase indicator. Set by processFileImport at the start of each
  // phase (copy_to_staging, search_terms_upsert, kwm_insert, etc.). Lets
  // us see exactly where a stuck import froze without waiting for the
  // (completion-only) import_phase_timings table to populate.
  importPhase: text('import_phase'),
  // Identifies which worker process owns the lock. If this differs from
  // the current worker's BOOT_ID at retry time, we know the previous
  // worker died (process crash, container restart, etc.) and the orphan
  // is reclaimable. Critical for diagnosing the failure mode where the
  // health endpoint shows a different process than the one that started
  // the import.
  importWorkerBootId: text('import_worker_boot_id'),
});

export const ingestionErrors = pgTable('ingestion_errors', {
  id: uuid('id').primaryKey().defaultRandom(),
  uploadedFileId: uuid('uploaded_file_id')
    .notNull()
    .references(() => uploadedFiles.id),
  severity: ingestionSeverityEnum('severity').notNull(),
  code: varchar('code', { length: 64 }).notNull(),
  message: text('message').notNull(),
  rowNumber: integer('row_number'),
  columnName: varchar('column_name', { length: 128 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type UploadBatch = typeof uploadBatches.$inferSelect;
export type UploadedFile = typeof uploadedFiles.$inferSelect;
export type IngestionError = typeof ingestionErrors.$inferSelect;
