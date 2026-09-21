import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { mcpConnections, type McpConnectionRow } from '@/db/schema';

export type McpConnectionStatus = 'enabled' | 'disconnected';
export interface McpConnectionState {
  status: McpConnectionStatus;
  lastRequestAt: Date | null;
  lastClientId: string | null;
  disconnectedAt: Date | null;
  reconnectedAt: Date | null;
}

function toState(r: McpConnectionRow): McpConnectionState {
  return {
    status: r.status === 'disconnected' ? 'disconnected' : 'enabled',
    lastRequestAt: r.lastRequestAt,
    lastClientId: r.lastClientId,
    disconnectedAt: r.disconnectedAt,
    reconnectedAt: r.reconnectedAt,
  };
}

/** null = the account has never used MCP (treated as enabled by the gate). */
export async function getMcpConnection(userId: string): Promise<McpConnectionState | null> {
  const row = await db.query.mcpConnections.findFirst({ where: eq(mcpConnections.userId, userId) });
  return row ? toState(row) : null;
}

/** The app-level disconnect record (amendment §3.4): the next MCP request is refused until reconnected. */
export async function setMcpConnectionStatus(userId: string, status: McpConnectionStatus, now = new Date()): Promise<McpConnectionState> {
  const stamp = status === 'disconnected' ? { disconnectedAt: now } : { reconnectedAt: now };
  const [row] = await db
    .insert(mcpConnections)
    .values({ userId, status, ...stamp, updatedAt: now })
    .onConflictDoUpdate({ target: mcpConnections.userId, set: { status, ...stamp, updatedAt: now } })
    .returning();
  return toState(row);
}

/**
 * Per-process throttle for touchMcpConnection, keyed by userId. Bounded by
 * the number of distinct accounts that have ever called MCP in this
 * process's lifetime — fine for a beta of tens of users; a long-lived
 * worker process would keep one entry per account for as long as it runs.
 */
const lastTouch = new Map<string, number>();

/** Fire-and-forget last-seen stamp for the Connect AI page; never changes status; at most once a minute per account. */
export function touchMcpConnection(userId: string, clientId: string, nowMs = Date.now()): void {
  if (nowMs - (lastTouch.get(userId) ?? 0) < 60_000) return;
  lastTouch.set(userId, nowMs);
  const at = new Date(nowMs);
  void db
    .insert(mcpConnections)
    .values({ userId, status: 'enabled', lastRequestAt: at, lastClientId: clientId, updatedAt: at })
    .onConflictDoUpdate({ target: mcpConnections.userId, set: { lastRequestAt: at, lastClientId: clientId, updatedAt: at } })
    .catch((e: unknown) => console.warn('[mcp connections] touch failed:', e instanceof Error ? e.message : e));
}

/** Test-only: clears the per-process touch throttle so the next touchMcpConnection() call is never suppressed by a prior test. */
export function resetMcpConnectionTouchesForTests(): void {
  lastTouch.clear();
}
