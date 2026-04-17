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
