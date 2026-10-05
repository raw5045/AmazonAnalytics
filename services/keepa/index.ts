// services/keepa/index.ts
/**
 * Keepa service entry point (spec 2026-10-05 §3.1, §5.1 step 1). Runs on its own Railway
 * service: `pnpm tsx services/keepa/index.ts`. Talks to Keepa and Neon only.
 *
 * Env: DATABASE_URL, KEEPA_API_KEY (required); KEEPA_TAIL_LANE=1 enables tier 2; PORT (Railway).
 */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { fetchKeepaBatch, fetchTokenStatus } from '@/lib/keepa/batchClient';
import { createPool } from './db';
import { PgKeepaStore } from './pgStore';
import { runForever } from './loop';
import { errFields, logLine } from './log';

const BOOT_ID = randomUUID();
const BOOTED_AT = new Date();
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const apiKey = process.env.KEEPA_API_KEY;
  const dbUrl = process.env.DATABASE_URL;
  if (!apiKey || !dbUrl) {
    console.error('[keepa-svc] KEEPA_API_KEY and DATABASE_URL are required');
    process.exit(1);
  }
  const tailEnabled = process.env.KEEPA_TAIL_LANE === '1';
  const port = parseInt(process.env.PORT || '8080', 10);
  const live = { lastBatchAt: null as Date | null };

  createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      ok: true,
      service: 'keepa-service',
      bootId: BOOT_ID,
      bootedAt: BOOTED_AT.toISOString(),
      uptimeSec: Math.round(process.uptime()),
      lastBatchAt: live.lastBatchAt?.toISOString() ?? null,
      tailEnabled,
    }));
  }).listen(port, () => logLine({ event: 'listening', port, bootId: BOOT_ID, tailEnabled }));

  const pool = createPool(dbUrl);
  const store = new PgKeepaStore(pool);
  await store.recordBoot(BOOT_ID, tailEnabled);
  // Our pool-level statement_timeout is a startup parameter the pooler may ignore: log what the
  // server applies ('0' = none) so a silent mismatch is visible in the first boot line.
  try {
    const { rows } = await pool.query('SHOW statement_timeout');
    logLine({ event: 'server_statement_timeout', value: String(Object.values((rows[0] as Record<string, unknown> | undefined) ?? {})[0] ?? '?') });
  } catch (e) {
    logLine({ event: 'server_statement_timeout_failed', ...errFields(e) });
  }
  await runForever({
    store,
    keepa: {
      fetchBatch: (asins) => fetchKeepaBatch(asins, { apiKey }),
      tokenStatus: () => fetchTokenStatus({ apiKey }),
    },
    sleep,
    now: () => new Date(),
    log: logLine,
    exit: (code) => process.exit(code),
    bootId: BOOT_ID,
    tailEnabled,
    onBatch: (at) => {
      live.lastBatchAt = at;
    },
  });
}

main().catch((e) => {
  // A boot-time failure (database unreachable, status row missing) exits non-zero so Railway
  // restarts the service with a fresh pool.
  logLine({ event: 'boot_failed', ...errFields(e) });
  process.exit(1);
});
