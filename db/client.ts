import { neon, Pool } from '@neondatabase/serverless';
import { drizzle as drizzleHttp } from 'drizzle-orm/neon-http';
import { drizzle as drizzlePool } from 'drizzle-orm/neon-serverless';
import { env } from '@/lib/env';
import * as schema from './schema';

/**
 * Which Drizzle driver to use is determined by the USE_NEON_WEBSOCKET env var.
 * - On Vercel serverless routes (web UI), use HTTP — stateless, fine for short requests.
 * - On the long-running Railway worker, use WebSocket Pool — robust against idle
 *   state and stale undici fetch pool issues that break HTTP on long workers.
 *
 * Both drivers expose the same Drizzle query API so callers don't need to care.
 */
const useWebSocket = process.env.USE_NEON_WEBSOCKET === '1';

// Export as the HTTP drizzle type for consistent caller-side typing.
// The two drivers are API-compatible for our query patterns; any runtime
// behavior difference we care about (Pool vs fetch) is what we want.
type Db = ReturnType<typeof drizzleHttp<typeof schema>>;

export const db: Db = useWebSocket
  ? (drizzlePool(new Pool({ connectionString: env.DATABASE_URL }), { schema }) as unknown as Db)
  : drizzleHttp(neon(env.DATABASE_URL), { schema });
