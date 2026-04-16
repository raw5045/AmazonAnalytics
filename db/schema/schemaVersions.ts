import { pgTable, uuid, integer, varchar, timestamp, pgEnum, jsonb, text } from 'drizzle-orm/pg-core';
import { users } from './users';

export const schemaVersionStatusEnum = pgEnum('schema_version_status', [
  'draft',
  'active',
  'retired',
]);

export const schemaVersions = pgTable('schema_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  versionNumber: integer('version_number').notNull(),
  status: schemaVersionStatusEnum('status').notNull().default('draft'),
  headerRowIndex: integer('header_row_index').notNull(),
  requiredColumnsJson: jsonb('required_columns_json').notNull(),
  headerHash: varchar('header_hash', { length: 64 }).notNull(),
  sampleFileId: uuid('sample_file_id'),
  approvedByUserId: uuid('approved_by_user_id').references(() => users.id),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type SchemaVersion = typeof schemaVersions.$inferSelect;
export type NewSchemaVersion = typeof schemaVersions.$inferInsert;
