import { pgTable, uuid, varchar, timestamp } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * One row per account that has used MCP: the app-level disconnect record
 * (source of truth, amendment §3.4) plus last-seen data for the Connect AI
 * page. No tokens are ever stored. See migration 0047.
 */
export const mcpConnections = pgTable('mcp_connections', {
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  status: varchar('status', { length: 16 }).notNull().default('enabled'),
  disconnectedAt: timestamp('disconnected_at', { withTimezone: true }),
  reconnectedAt: timestamp('reconnected_at', { withTimezone: true }),
  lastRequestAt: timestamp('last_request_at', { withTimezone: true }),
  lastClientId: varchar('last_client_id', { length: 128 }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
export type McpConnectionRow = typeof mcpConnections.$inferSelect;
