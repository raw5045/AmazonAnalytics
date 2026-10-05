// services/keepa/db.ts
import { Pool } from 'pg';
import { errFields, logLine } from './log';

/** The service's own pool (spec §3.1): never the app's db/client, which loads the full env schema. */
export function createPool(connectionString: string): Pool {
  const pool = new Pool({
    connectionString,
    max: 3,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    connectionTimeoutMillis: 20_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 300_000,
  });
  pool.on('error', (e) => logLine({ event: 'pool_error', ...errFields(e) }));
  return pool;
}
