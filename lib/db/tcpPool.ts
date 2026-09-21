import { Pool, type PoolClient } from 'pg';

/**
 * Small node-postgres pools for work the neon-http driver cannot do:
 * multi-statement transactions with `SET LOCAL statement_timeout`. The
 * Explorer's broad-search path keeps its own copy of this pattern in
 * lib/explorer/runQuery.ts (deliberately untouched); research queries use
 * a dedicated pool so a burst of tool calls cannot starve page loads.
 *
 * `connectionTimeoutMillis` also bounds how long a caller waits in the
 * pending queue when all `max` clients are busy — that wait rejects with a
 * plain Error (no SQLSTATE), which callers must treat as retryable.
 */
export interface TcpPoolOptions {
  /** Appears in log lines. */
  name: string;
  max: number;
  connectionString: string;
  /** Defaults to 20_000. */
  connectionTimeoutMillis?: number;
}

export function createTcpPool(opts: TcpPoolOptions): Pool {
  const pool = new Pool({
    connectionString: opts.connectionString,
    max: opts.max,
    keepAlive: true,
    connectionTimeoutMillis: opts.connectionTimeoutMillis ?? 20_000,
  });
  pool.on('error', (e: Error) => console.warn(`[${opts.name} pool] idle client error:`, e.message));
  return pool;
}

export type TxClient = Pick<PoolClient, 'query'>;

/**
 * Runs `fn` inside `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` with a
 * statement timeout, so every statement inside sees one snapshot and none can
 * run longer than the budget. Resolves to 'timeout' when Postgres cancels a
 * statement (SQLSTATE 57014); any other error is rethrown after ROLLBACK.
 */
export async function withReadOnlyTx<T>(
  pool: Pool,
  statementTimeoutMs: number,
  fn: (client: TxClient) => Promise<T>,
): Promise<T | 'timeout'> {
  if (
    !Number.isSafeInteger(statementTimeoutMs) ||
    statementTimeoutMs <= 0 ||
    statementTimeoutMs > 2_147_483_647
  ) {
    throw new Error(`statementTimeoutMs must be a positive integer up to 2147483647, got ${statementTimeoutMs}`);
  }
  const client = await pool.connect();
  // pg-pool removes its own idle-client 'error' listener the instant a
  // client is checked out, so a socket drop mid-transaction would otherwise
  // be an uncaught event on `client`. A no-op listener absorbs it; the real
  // failure still reaches the caller via the rejected query/ROLLBACK below.
  const onSocketError = () => {};
  client.on('error', onSocketError);
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    // SET LOCAL takes no bind parameter; the value is validated as an integer above.
    await client.query(`SET LOCAL statement_timeout = ${statementTimeoutMs}`);
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* connection may be dead */ }
    if ((e as { code?: string } | null)?.code === '57014') return 'timeout';
    throw e;
  } finally {
    client.removeListener('error', onSocketError);
    client.release();
  }
}

/**
 * True when `err` is pg-pool's connect-queue timeout: a plain `Error` (no `code`, unlike a
 * Postgres-originated error, which always carries a SQLSTATE) with the exact message
 * `'timeout exceeded when trying to connect'`, raised when a caller waits
 * `connectionTimeoutMillis` for a client without one freeing up. Callers should treat this
 * as retryable — the pool itself is healthy, the caller just lost the race for a client.
 *
 * The literal is pinned to pg-pool@3.13.0 (index.js:224); re-verify it on a pg/pg-pool bump.
 * Deliberately does NOT match two other, similarly-worded timeouts, both confirmed against
 * the same installed versions: pg-pool's own `'Connection terminated due to connection
 * timeout'` (index.js:276 — the underlying socket's connect timeout, not the queue wait; it
 * carries a `cause`) and node-postgres Client's `'timeout expired'` (pg/lib/client.js:150 — a
 * query/statement timeout, unrelated to connecting at all).
 */
export function isPoolConnectTimeout(err: unknown): boolean {
  return err instanceof Error && err.message === 'timeout exceeded when trying to connect';
}
