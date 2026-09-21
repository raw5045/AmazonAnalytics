import { Pool, type PoolClient } from 'pg';
import { env } from '@/lib/env';

/**
 * Small node-postgres pools for work the neon-http driver cannot do:
 * multi-statement transactions with `SET LOCAL statement_timeout`. The
 * Explorer's broad-search path keeps its own copy of this pattern in
 * lib/explorer/runQuery.ts (deliberately untouched); research queries use
 * a dedicated pool so a burst of tool calls cannot starve page loads.
 */
export interface TcpPoolOptions {
  /** Appears in log lines. */
  name: string;
  max: number;
}

export function createTcpPool(opts: TcpPoolOptions): Pool {
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: opts.max,
    keepAlive: true,
    connectionTimeoutMillis: 20_000,
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
  if (!Number.isInteger(statementTimeoutMs) || statementTimeoutMs <= 0) {
    throw new Error(`statementTimeoutMs must be a positive integer, got ${statementTimeoutMs}`);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    // SET LOCAL takes no bind parameter; the value is validated as an integer above.
    await client.query(`SET LOCAL statement_timeout = ${statementTimeoutMs}`);
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* connection may be dead */ }
    if ((e as { code?: string }).code === '57014') return 'timeout';
    throw e;
  } finally {
    client.release();
  }
}
