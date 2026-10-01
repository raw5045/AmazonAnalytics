/**
 * Whatever string `code` a thrown error carries, on itself or else on its `cause`: a Postgres
 * SQLSTATE for a database error, but just as well e.g. `ECONNRESET` for a socket error, so a
 * caller must compare against the exact code it means. drizzle-orm (0.45, neon-http and
 * node-postgres alike) rethrows every driver failure as a DrizzleQueryError and keeps the driver
 * error on `cause`, so the code usually lives one level down; a raw driver error carries it on
 * itself. `isUniqueViolation` below is the only semantic helper.
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
