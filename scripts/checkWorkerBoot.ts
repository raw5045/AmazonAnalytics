/**
 * Worker-boot smoke check.
 *
 * Imports the Inngest function registry exactly the way the Railway
 * worker does on startup (worker/index.ts: `import { functions } from
 * '../inngest/functions'`), under plain Node via tsx — NOT vitest.
 *
 * Why this exists: typecheck, the vitest suite, and the Next.js build all
 * pass even when a worker-reachable module does something that's only
 * fatal in the plain-Node worker runtime — most notably `import
 * 'server-only'`, which throws at import outside a Next Server Component
 * and crash-loops the worker on boot (taking down ALL Inngest jobs).
 * vitest can't catch it because it stubs 'server-only' via a config
 * alias. This check runs in the real runtime, so an accidental
 * server-only (or any import-time throw) fails here, before deploy.
 *
 * Run: `npm run worker:check` (loads .env.local, since the import chain
 * pulls in lib/env which validates required env vars).
 *
 * Exit 0 = the worker's function graph imports cleanly. Any import-time
 * throw aborts the process with a non-zero exit automatically.
 */
import { functions } from '../inngest/functions';

if (!Array.isArray(functions) || functions.length === 0) {
  console.error(
    `worker-boot check FAILED: expected a non-empty functions array, got ${JSON.stringify(functions)}`,
  );
  process.exit(1);
}

console.log(
  `worker-boot check OK — ${functions.length} Inngest function(s) import cleanly under the worker runtime`,
);
