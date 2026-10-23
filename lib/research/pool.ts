import type { Pool } from 'pg';
import { env } from '@/lib/env';
import { createTcpPool } from '@/lib/db/tcpPool';
import { researchLimits } from './limits';

let pool: Pool | null = null;
/** Dedicated research pool (amendment §3.6) — separate from the Explorer's pool. Lazily created; one per process. */
export function getResearchPool(): Pool {
  // M-4 (Task 15 re-review): a search does two connects (page + count, lib/research/service.ts's
  // search()) inside the keyword tools' 30s budget — the pg-pool default of 20s alone could exceed
  // it before either connect even resolves. The MCP route's maxDuration is now 60 (room for the
  // product tools' 30s statement cap, app/api/mcp/route.ts); the keyword tools still budget for 30s.
  // 8s stays comfortably above Neon's own cold-start range (3-5s) and still leaves headroom.
  if (!pool) pool = createTcpPool({ name: 'research', max: researchLimits().poolMax, connectionString: env.DATABASE_URL, connectionTimeoutMillis: 8_000 });
  return pool;
}
export function resetResearchPoolForTests(): void {
  pool = null;
}
