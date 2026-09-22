import type { Pool } from 'pg';
import { env } from '@/lib/env';
import { createTcpPool } from '@/lib/db/tcpPool';
import { researchLimits } from './limits';

let pool: Pool | null = null;
/** Dedicated research pool (amendment §3.6) — separate from the Explorer's pool. Lazily created; one per process. */
export function getResearchPool(): Pool {
  // M-4 (Task 15 re-review): a search does two connects against the route's own maxDuration =
  // 30 (page + count, lib/research/service.ts's search()) — the pg-pool default of 20s alone
  // could exceed that budget before either connect even resolves. 8s stays comfortably above
  // Neon's own cold-start range (3-5s) while leaving headroom inside the 30s route deadline.
  if (!pool) pool = createTcpPool({ name: 'research', max: researchLimits().poolMax, connectionString: env.DATABASE_URL, connectionTimeoutMillis: 8_000 });
  return pool;
}
export function resetResearchPoolForTests(): void {
  pool = null;
}
