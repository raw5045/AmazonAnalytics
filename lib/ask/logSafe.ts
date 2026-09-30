import { DrizzleQueryError } from 'drizzle-orm';

/**
 * Log-safe fields for an unknown catch value (Task 8 review, I2). drizzle-orm's pg-core session
 * (queryWithCache) rethrows every neon-http failure as `DrizzleQueryError`, whose OWN `.message` is
 * `Failed query: <sql>\nparams: <params>` — the bound params array can hold message text (a jsonb
 * `parts` value, a chat title), so a `DrizzleQueryError`'s `.message` must never be logged. Its
 * `.cause` is the real underlying error (e.g. a Postgres error with `.code`), which is what this
 * reads instead. For any other error, the error itself is used. `detail` is capped at 200 chars.
 */
export interface LogSafeFields {
  error: string;
  code?: string;
  detail?: string;
}

export function errFields(e: unknown): LogSafeFields {
  const src = e instanceof DrizzleQueryError ? e.cause : e;
  const code = (src as { code?: unknown } | null)?.code;
  return {
    error: src instanceof Error ? src.name : typeof src,
    ...(typeof code === 'string' ? { code } : {}),
    detail: src instanceof Error ? src.message.slice(0, 200) : undefined,
  };
}
