import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

const isIntegration = !!process.env.RUN_INTEGRATION;

export default defineConfig({
  plugins: [react()],
  test: {
    environment: isIntegration ? 'node' : 'jsdom',
    globals: true,
    setupFiles: isIntegration
      ? ['./tests/integration/setup.ts']
      : ['./vitest.setup.ts'],
    exclude: [
      '**/node_modules/**',
      '**/.next/**',
      // The desktop app checks out side-session worktrees under .claude/worktrees,
      // inside the repo; without this every test file is collected once per worktree.
      '**/.claude/**',
      ...(isIntegration ? [] : ['tests/integration/**']),
    ],
    // Integration tests hit a shared Neon database and collide on unique
    // constraints (e.g. reporting_weeks.week_end_date) when run in parallel.
    // Run files sequentially under RUN_INTEGRATION.
    ...(isIntegration
      ? {
          pool: 'forks' as const,
          forks: { singleFork: true },
          fileParallelism: false,
          sequence: { concurrent: false },
          // Suite-wide backstop: sweep orphaned synthetic test users out of the
          // production DB after the run, in case a test was killed before its
          // afterAll. See tests/integration/globalSetup.ts.
          globalSetup: ['./tests/integration/globalSetup.ts'],
        }
      : {}),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './'),
      // pnpm's strict layout hides `server-only` (a transitive dep of next)
      // from vitest's import-analysis. Stub it out in tests; the runtime
      // contract is enforced by Next.js when actually serving requests.
      'server-only': path.resolve(__dirname, './tests/stubs/server-only.ts'),
    },
  },
});
