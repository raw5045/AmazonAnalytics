import { pgTable, uuid, varchar, boolean, jsonb, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';

/**
 * Configurable fake-volume rule definitions.
 *
 * V1 (Plan 3.1): seeded with one row (`v1-default`) marked active. The
 * rule SQL in processFileImport hard-codes the same thresholds — JSON
 * stored here is for audit + future admin-editing use (Plan 3.5).
 *
 * Future (Plan 3.5): admin UI lets staff edit thresholds; the
 * processFileImport CASE expression is rebuilt from the active row's
 * JSON at import time.
 */
export const fakeVolumeRules = pgTable(
  'fake_volume_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    versionName: varchar('version_name', { length: 64 }).notNull(),
    isActive: boolean('is_active').notNull().default(false),
    // Looser thresholds (orange tier)
    warningRulesJson: jsonb('warning_rules_json').notNull(),
    // Stricter thresholds (red tier)
    criticalRulesJson: jsonb('critical_rules_json').notNull(),
    createdByUserId: uuid('created_by_user_id').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Only one rule version can be active at a time (partial unique index)
    activeIdx: uniqueIndex('fake_volume_rules_active_idx')
      .on(t.isActive)
      .where(sql`${t.isActive} = true`),
  }),
);

export type FakeVolumeRule = typeof fakeVolumeRules.$inferSelect;
export type NewFakeVolumeRule = typeof fakeVolumeRules.$inferInsert;
