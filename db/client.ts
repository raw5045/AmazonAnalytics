import { neon, Pool } from '@neondatabase/serverless';
import { drizzle as drizzleHttp } from 'drizzle-orm/neon-http';
import { drizzle as drizzlePool } from 'drizzle-orm/neon-serverless';
import { env } from '@/lib/env';
import * as schema from './schema';

/**
 * Which Drizzle driver to use is determined by the USE_NEON_WEBSOCKET env var.
 * - On Vercel serverless routes (web UI), use HTTP — stateless, fine for short requests.
 * - On the long-running Railway worker, use WebSocket Pool — robust against the
 *   idle-state HTTP fetch issues that plagued us.
 *
 * Both drivers expose the same Drizzle query API so callers don't need to care.
 */
const useWebSocket = process.env.USE_NEON_WEBSOCKET === '1';

type Db = ReturnType<typeof drizzleHttp<typeof schema>>;

function createDb(): Db {
  if (useWebSocket) {
    const pool = new Pool({
      connectionString: env.DATABASE_URL,
      // Close idle connections quickly so stale WebSockets don't accumulate
      // in the long-running worker. New queries open fresh connections.
      idleTimeoutMillis: 30_000,
      // Don't hold more than a few concurrent WebSocket sessions.
      max: 6,
    });
    return drizzlePool(pool, { schema }) as unknown as Db;
  }
  return drizzleHttp(neon(env.DATABASE_URL), { schema });
}

export const db: Db = createDb();
