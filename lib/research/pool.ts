import type { Pool } from 'pg';
import { env } from '@/lib/env';
import { createTcpPool } from '@/lib/db/tcpPool';
import { researchLimits } from './limits';

let pool: Pool | null = null;
/** Dedicated research pool (amendment §3.6) — separate from the Explorer's pool. Lazily created; one per process. */
export function getResearchPool(): Pool {
  if (!pool) pool = createTcpPool({ name: 'research', max: researchLimits().poolMax, connectionString: env.DATABASE_URL });
  return pool;
}
export function resetResearchPoolForTests(): void {
  pool = null;
}
