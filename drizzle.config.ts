import { defineConfig } from 'drizzle-kit';
import { config } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve .env.local relative to this config file, not to CWD, so drizzle-kit
// works correctly no matter where it's invoked from.
const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(here, '.env.local') });

if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL is not set. Check that .env.local exists at the repo root and contains a valid Neon connection string.',
  );
}

export default defineConfig({
  schema: './db/schema/index.ts',
  out: './db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
  verbose: true,
  strict: true,
});
