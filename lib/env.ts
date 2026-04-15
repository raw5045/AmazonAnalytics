import { z } from 'zod';

const serverSchema = z.object({
  DATABASE_URL: z.string().url(),
  CLERK_SECRET_KEY: z.string().min(1),
  CLERK_WEBHOOK_SIGNING_SECRET: z.string().min(1),
  R2_ACCOUNT_ID: z.string().min(1),
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
  R2_BUCKET_NAME: z.string().min(1),
  INNGEST_EVENT_KEY: z.string().min(1).optional(),
  INNGEST_SIGNING_KEY: z.string().min(1).optional(),
  INITIAL_ADMIN_EMAIL: z.string().email().optional(),
  APP_PUBLIC_URL: z.string().url(),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

const clientSchema = z.object({
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().min(1),
  NEXT_PUBLIC_APP_URL: z.string().url(),
});

/**
 * Converts empty-string env values to undefined so that zod's `.optional()`
 * treats unset-but-declared env vars correctly. Without this, a `.env` file
 * line like `INNGEST_EVENT_KEY=` produces `""` which fails `.min(1)`.
 */
function emptyToUndefined(source: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(source)) {
    out[k] = v === '' ? undefined : v;
  }
  return out;
}

function parseEnv() {
  const source = emptyToUndefined(process.env);
  const isServer = typeof window === 'undefined';
  const client = clientSchema.parse({
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: source.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
    NEXT_PUBLIC_APP_URL: source.NEXT_PUBLIC_APP_URL,
  });
  if (!isServer) return { ...client };
  const server = serverSchema.parse(source);
  return { ...client, ...server };
}

export const env = parseEnv();
export type Env = ReturnType<typeof parseEnv>;
