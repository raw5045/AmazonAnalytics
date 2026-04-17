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
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './'),
    },
  },
});
