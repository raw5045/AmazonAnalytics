import { pgTable, uuid, varchar, jsonb, timestamp } from 'drizzle-orm/pg-core';
import { users } from './users';

export const auditLog = pgTable('audit_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id),
  action: varchar('action', { length: 128 }).notNull(),
  entityType: varchar('entity_type', { length: 128 }),
  entityId: uuid('entity_id'),
  metadataJson: jsonb('metadata_json'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
