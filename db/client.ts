import { neon } from '@neondatabase/serverless';
import { drizzle as drizzleHttp } from 'drizzle-orm/neon-http';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { env } from '@/lib/env';
import * as schema from './schema';

/**
 * Driver selection by runtime:
 * - On Vercel serverless routes (USE_PG_TCP unset): use neon-http. Stateless,
 *   no connection to maintain, ideal for short-lived edge functions.
 * - On the long-running Railway worker (USE_PG_TCP=1): use node-postgres TCP
 *   with keepalives. The @neondatabase/serverless WebSocket driver fails
 *   silently when Neon's compute auto-suspends or the LB closes idle sockets;
 *   pg with TCP keepalive detects dead sockets and reconnects automatically.
 *
 * See: https://neon.com/docs/connect/choose-connection
 */
const useTcp = process.env.USE_PG_TCP === '1';

type Db = ReturnType<typeof drizzleHttp<typeof schema>>;

function createDb(): Db {
  if (useTcp) {
    const pool = new Pool({
      connectionString: env.DATABASE_URL,
      max: 6,
      idleTimeoutMillis: 30_000,
      // TCP keepalive — first probe at 10s. When Neon's LB or compute closes
      // an idle socket, the next keepalive fails, pg-pool emits 'error' on
      // the idle client (caught below), and the dead client is evicted.
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
      // Headroom for Neon compute cold-start (typical: a few hundred ms,
      // worst case: 3-5s after auto-suspend).
      connectionTimeoutMillis: 20_000,
    });

    // Swallow background socket errors so they don't crash the worker.
    // The next pool.connect() / pool.query() will open a fresh socket.
    pool.on('error', (err) => {
      console.warn('[pg pool] idle client error (will reconnect):', err.message);
    });

    return drizzlePg(pool, { schema }) as unknown as Db;
  }
  return drizzleHttp(neon(env.DATABASE_URL), { schema });
}

export const db: Db = createDb();
