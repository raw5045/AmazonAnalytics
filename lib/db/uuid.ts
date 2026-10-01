/**
 * A well-formed UUID, in either case. Postgres returns uuids lowercase, so a caller that compares
 * ids in JS lowercases first (the workspace zod schemas already do, via z.uuid().toLowerCase()).
 */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
