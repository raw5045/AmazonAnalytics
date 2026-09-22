// tests/integration/globalSetup.ts
//
// Suite-wide guard for integration tests. After the whole integration run
// finishes, sweep any orphaned synthetic test users out of the PRODUCTION
// database. Per-test afterAll/deleteTestUser is the primary cleanup; this is
// the backstop that keeps `users` at zero orphans even when a run is killed
// before afterAll, or a future test forgets to clean up.
//
// Wired in via vitest.config.ts (integration branch only). Runs in the Vitest
// main process — separate from the test fork — so it loads .env.local itself
// and imports the helper lazily (importing it pulls in @/db/client, which
// validates env at module load).
import { config } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(here, '../../.env.local') });

export async function teardown(): Promise<void> {
  const { sweepOrphanTestUsers } = await import('./helpers');
  try {
    const removed = await sweepOrphanTestUsers();
    if (removed.length > 0) {
      console.warn(
        `[integration teardown] swept ${removed.length} orphaned test user(s): ` +
          `${removed.join(', ')}. A test left these behind — check its ` +
          `afterAll / deleteTestUser.`,
      );
    }
  } catch (err) {
    // Never fail the run on cleanup trouble — surface it loudly instead.
    console.error('[integration teardown] orphan sweep failed:', err);
  }
}
