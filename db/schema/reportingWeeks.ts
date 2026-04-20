import { pgTable, uuid, date, boolean, timestamp } from 'drizzle-orm/pg-core';
import { uploadedFiles } from './uploads';

export const reportingWeeks = pgTable('reporting_weeks', {
  weekEndDate: date('week_end_date').primaryKey(),
  weekStartDate: date('week_start_date').notNull(),
  sourceFileId: uuid('source_file_id').references(() => uploadedFiles.id),
  isComplete: boolean('is_complete').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type ReportingWeek = typeof reportingWeeks.$inferSelect;
export type NewReportingWeek = typeof reportingWeeks.$inferInsert;
