import { sql } from 'drizzle-orm';
import { pgTable, uuid, varchar, timestamp, check } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * One row per account that has used MCP: the app-level disconnect record
 * (source of truth, amendment §3.4) plus last-seen data for the Connect AI
 * page. No tokens are ever stored. See migration 0047.
 *
 * `status` is CHECK-constrained to ('enabled', 'disconnected') at the database (mirrored,
 * under the identical constraint name `mcp_connections_status_check`, in the SQL migration):
 * this column gates every MCP request, and a security-relevant gate that fails OPEN on an
 * unrecognized value is worse than a database that simply refuses to write one.
 */
export const mcpConnections = pgTable(
  'mcp_connections',
  {
    userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
    status: varchar('status', { length: 16 }).notNull().default('enabled'),
    disconnectedAt: timestamp('disconnected_at', { withTimezone: true }),
    reconnectedAt: timestamp('reconnected_at', { withTimezone: true }),
    lastRequestAt: timestamp('last_request_at', { withTimezone: true }),
    lastClientId: varchar('last_client_id', { length: 128 }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    statusCheck: check('mcp_connections_status_check', sql`${t.status} IN ('enabled', 'disconnected')`),
  }),
);
export type McpConnectionRow = typeof mcpConnections.$inferSelect;
