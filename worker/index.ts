/**
 * Inngest worker — runs outside Vercel so long-running jobs don't hit
 * serverless function timeouts.
 *
 * Registers all Inngest functions (rubric, validate, import-batch) on
 * this endpoint. Inngest Cloud routes events here; the worker executes
 * them with no timeout ceiling.
 *
 * Local dev: run via `pnpm worker:dev` which uses Node's --env-file flag.
 * Railway: env vars are injected by the platform; no dotenv needed.
 */
import express from 'express';
import { serve } from 'inngest/express';
import { inngest } from '../inngest/client';
import { functions } from '../inngest/functions';
import { BOOT_ID, BOOTED_AT } from '../lib/runtime';
import { reclaimStaleKeepaRunsOnBoot } from './keepaJobs';

const GIT_SHA =
  process.env.RAILWAY_GIT_COMMIT_SHA ??
  process.env.GIT_COMMIT_SHA ??
  process.env.VERCEL_GIT_COMMIT_SHA ??
  'unknown';

const app = express();
app.use(express.json({ limit: '10mb' }));

// Health check — Railway pings this. Returns enough metadata that we can
// distinguish "the original process serving requests" from "Railway
// restarted us silently and a new process is here." The bootId is the
// strongest signal: it's regenerated on every process start.
app.get('/', (_req, res) => {
  const mem = process.memoryUsage();
  res.json({
    ok: true,
    service: 'amazon-sfr-analytics-worker',
    functions: functions.length,
    commit: GIT_SHA.slice(0, 7),
    bootId: BOOT_ID,
    bootedAt: BOOTED_AT.toISOString(),
    pid: process.pid,
    uptimeSec: Math.round(process.uptime()),
    memoryMb: {
      rss: Math.round(mem.rss / 1024 / 1024),
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
      external: Math.round(mem.external / 1024 / 1024),
    },
  });
});

app.use(
  '/api/inngest',
  serve({
    client: inngest,
    functions,
    servePath: '/api/inngest',
  }),
);

const port = parseInt(process.env.PORT || '8080', 10);
app.listen(port, () => {
  console.log(`Inngest worker listening on port ${port}`);
  console.log(`BOOT_ID=${BOOT_ID} pid=${process.pid}`);
  console.log(`Registered ${functions.length} function(s):`, functions.map((f) => f.id()).join(', '));

  // Boot-time reclaim: flip any Keepa run left 'running' by a dead previous
  // boot to 'orphaned' so its durable orchestrator wraps up promptly (next
  // ≤5-min poll) instead of burning the full 24h budget. Fire-and-forget —
  // never blocks startup; import path is intentionally excluded (see
  // reclaimStaleKeepaRunsOnBoot + the 2026-05-16 false-orphan note).
  reclaimStaleKeepaRunsOnBoot()
    .then((ids) => {
      if (ids.length > 0) {
        console.warn(`[boot] reclaimed ${ids.length} stale Keepa run(s): ${ids.map((i) => i.slice(0, 8)).join(', ')}`);
      }
    })
    .catch((e) => console.error('[boot] Keepa run reclaim failed:', e));
});
