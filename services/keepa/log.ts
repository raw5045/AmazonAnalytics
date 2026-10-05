// services/keepa/log.ts
/**
 * Log-safe logging for the Keepa service: one JSON line per event, coded fields only.
 * An error contributes its class name, a Postgres `code`, an HTTP `status` and its cause's `code`
 * (fetch wraps ENOTFOUND, ECONNRESET, UND_ERR_CONNECT_TIMEOUT… in a TypeError) — never a message
 * (a pg message can carry the connection string's user; a fetch error can carry a URL).
 */
export interface ErrFields {
  error: string;
  code?: string;
  status?: number;
  causeCode?: string;
}

export function errFields(e: unknown): ErrFields {
  const o = (e ?? null) as { name?: unknown; code?: unknown; status?: unknown; cause?: unknown } | null;
  const cause = (o?.cause ?? null) as { code?: unknown } | null;
  return {
    error: e instanceof Error ? e.name : typeof e,
    ...(typeof o?.code === 'string' ? { code: o.code } : {}),
    ...(typeof o?.status === 'number' ? { status: o.status } : {}),
    ...(typeof cause?.code === 'string' ? { causeCode: cause.code } : {}),
  };
}

export function logLine(fields: Record<string, unknown>): void {
  console.log('[keepa-svc]', JSON.stringify(fields));
}
