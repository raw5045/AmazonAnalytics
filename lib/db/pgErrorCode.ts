/**
 * The Postgres SQLSTATE of a thrown error. drizzle-orm (0.45, neon-http and node-postgres alike)
 * rethrows every driver failure as a DrizzleQueryError and keeps the Postgres error on `cause`,
 * so the code lives one level down; a raw driver error carries it on itself. lib/db/retry.ts
 * reads both levels the same way.
 */
export function pgErrorCode(e: unknown): string | undefined {
  for (const err of [e, (e as { cause?: unknown } | null)?.cause]) {
    if (err && typeof err === 'object') {
      const code = (err as { code?: unknown }).code;
      if (typeof code === 'string') return code;
    }
  }
  return undefined;
}

/** True for a Postgres unique-constraint violation (SQLSTATE 23505), wrapped in a DrizzleQueryError or not. */
export function isUniqueViolation(e: unknown): boolean {
  return pgErrorCode(e) === '23505';
}
