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
        }
      : {}),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './'),
    },
  },
});
