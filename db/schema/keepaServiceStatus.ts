// db/schema/keepaServiceStatus.ts
import { pgTable, boolean, text, integer, date, timestamp } from 'drizzle-orm/pg-core';

/** Single row: Keepa service heartbeat + the watcher's bookkeeping (spec 2026-10-05 §4.3). */
export const keepaServiceStatus = pgTable('keepa_service_status', {
  singleton: boolean('singleton').primaryKey().default(true),
  bootId: text('boot_id'),
  bootedAt: timestamp('booted_at', { withTimezone: true }),
  heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
  lastBatchAt: timestamp('last_batch_at', { withTimezone: true }),
  lastBatchLane: text('last_batch_lane'),
  tokensLeft: integer('tokens_left'),
  refillRate: integer('refill_rate'),
  tailEnabled: boolean('tail_enabled').notNull().default(false),
  lastErrorCode: text('last_error_code'),
  lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
  laneNewDrainedAt: timestamp('lane_new_drained_at', { withTimezone: true }),
  syncFiredAt: timestamp('sync_fired_at', { withTimezone: true }),
  nightlySyncDate: date('nightly_sync_date'),
  downAlarmSentAt: timestamp('down_alarm_sent_at', { withTimezone: true }),
  stallAlarmSentAt: timestamp('stall_alarm_sent_at', { withTimezone: true }),
});

export type KeepaServiceStatusRow = typeof keepaServiceStatus.$inferSelect;
