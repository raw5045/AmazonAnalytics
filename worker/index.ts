/**
 * Inngest worker — runs outside Vercel so long-running jobs don't hit
 * serverless function timeouts.
 *
 * Registers all Inngest functions (rubric, validate, import-file, import-batch)
 * on this endpoint. Inngest Cloud routes events here; the worker executes them
 * with no timeout ceiling.
 *
 * Local dev: run via `pnpm worker:dev` which uses Node's --env-file flag.
 * Railway: env vars are injected by the platform; no dotenv needed.
 */
import express from 'express';
import { serve } from 'inngest/express';
import { inngest } from '../inngest/client';
import { functions } from '../inngest/functions';

const app = express();

// Inngest needs raw JSON body support
app.use(express.json({ limit: '10mb' }));

// Health check — Railway pings this to confirm the service is up.
// Includes the git commit SHA so we can verify which code is actually
// serving requests after a deploy. Railway sets RAILWAY_GIT_COMMIT_SHA
// automatically; we fall back to a few alternatives for portability.
const GIT_SHA =
  process.env.RAILWAY_GIT_COMMIT_SHA ??
  process.env.GIT_COMMIT_SHA ??
  process.env.VERCEL_GIT_COMMIT_SHA ??
  'unknown';
app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'amazon-sfr-analytics-worker',
    functions: functions.length,
    commit: GIT_SHA.slice(0, 7),
  });
});

// Inngest's serve handler — registers all functions at /api/inngest
app.use(
  '/api/inngest',
  serve({
    client: inngest,
    functions,
    // Longer serve-level timeout so multi-minute imports complete cleanly
    servePath: '/api/inngest',
  }),
);

const port = parseInt(process.env.PORT || '8080', 10);
app.listen(port, () => {
  console.log(`Inngest worker listening on port ${port}`);
  console.log(`Registered ${functions.length} function(s):`, functions.map((f) => f.id()).join(', '));
});
