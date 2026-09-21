import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '@/lib/env';
import { searchRequestSchema } from './contracts';
import type { SearchRequest, TotalMatches } from './contracts';
import { ResearchError } from './errors';

/**
 * Stateless continuation (amendment §5.3): the cursor carries everything a
 * later page needs, signed so it cannot be altered. Nothing is stored.
 */
export interface CursorPayload {
  v: 1;
  /** The validated new-search request; continuation re-derives presets, scope and SQL from it. */
  req: SearchRequest;
  /** snapshotVersion the first page ran against; a weekly refresh invalidates the cursor. */
  snap: string;
  /** OFFSET of the next page. */
  off: number;
  /** Page size fixed on the first page. */
  ps: number;
  /** Expiry, unix seconds. */
  exp: number;
  /** Owner (local user id) and channel. */
  uid: string;
  ch: 'mcp';
  /** Count computed on the first page, carried so later pages do not recount. */
  tm: TotalMatches;
}

export const MAX_CURSOR_LENGTH = 8192;

const TOTAL_MATCHES_KINDS: ReadonlyArray<TotalMatches['kind']> = ['exact', 'at_least', 'unknown'];

/**
 * The key signCursor/verifyCursor sign under. RESEARCH_CURSOR_SECRET (Task 5) wins when set;
 * otherwise a stable key is derived from CLERK_SECRET_KEY (always present in server env — see
 * lib/env.ts) so cursors work with no dedicated secret configured. Deliberately not memoized:
 * HMAC is deterministic, so recomputing is cheap and always agrees with itself for as long as
 * the underlying env value doesn't change.
 */
export function cursorSecret(): string {
  if (env.RESEARCH_CURSOR_SECRET) return env.RESEARCH_CURSOR_SECRET;
  return createHmac('sha256', env.CLERK_SECRET_KEY).update('keywordquarry-research-cursor-v1').digest('hex');
}

/** Signs `payload` into a `body.mac` token (both base64url); throws RESPONSE_TOO_LARGE past MAX_CURSOR_LENGTH. */
export function signCursor(payload: CursorPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const mac = createHmac('sha256', secret).update(body).digest('base64url');
  const token = `${body}.${mac}`;
  if (token.length > MAX_CURSOR_LENGTH) {
    throw new ResearchError('RESPONSE_TOO_LARGE', 'The search criteria are too large to page through; choose fewer category selections.');
  }
  return token;
}

/**
 * Verifies `token`'s MAC under `secret`, then its shape, then its expiry against `nowSeconds` —
 * in that order, so a structurally-broken-or-forged cursor is always INVALID_CURSOR even if it
 * also happens to carry a stale `exp`, and only a well-formed, correctly-signed cursor can ever
 * report the more specific SEARCH_EXPIRED.
 *
 * Beyond checking each top-level field's type, `req` is re-validated against
 * searchRequestSchema (the service re-applies presets from it, so it must be a valid request —
 * cheap insurance beyond the MAC alone, e.g. against a schema that has moved on since the
 * cursor was signed) and `tm.kind` is checked against the three documented TotalMatches kinds.
 * `off`/`ps` must be non-negative integers.
 */
export function verifyCursor(token: string, secret: string, nowSeconds: number): CursorPayload {
  const invalid = () => new ResearchError('INVALID_CURSOR', 'The cursor is not valid. Start a new search.');
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_CURSOR_LENGTH) throw invalid();
  const dot = token.lastIndexOf('.');
  if (dot <= 0) throw invalid();
  const body = token.slice(0, dot);
  const expected = createHmac('sha256', secret).update(body).digest();
  const given = Buffer.from(token.slice(dot + 1), 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw invalid();

  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  if (!raw || typeof raw !== 'object') throw invalid();
  const payload = raw as Record<string, unknown>;

  const off = payload.off;
  const ps = payload.ps;
  const tm = payload.tm;
  const offOk = typeof off === 'number' && Number.isInteger(off) && off >= 0;
  const psOk = typeof ps === 'number' && Number.isInteger(ps) && ps >= 0;
  const tmOk = typeof tm === 'object' && tm !== null && TOTAL_MATCHES_KINDS.includes((tm as Record<string, unknown>).kind as TotalMatches['kind']);

  if (
    payload.v !== 1 ||
    !offOk ||
    !psOk ||
    typeof payload.exp !== 'number' ||
    typeof payload.uid !== 'string' ||
    typeof payload.snap !== 'string' ||
    payload.ch !== 'mcp' ||
    typeof payload.req !== 'object' ||
    payload.req === null ||
    !tmOk
  ) {
    throw invalid();
  }

  const parsedReq = searchRequestSchema.safeParse(payload.req);
  if (!parsedReq.success) throw invalid();

  if ((payload.exp as number) <= nowSeconds) {
    throw new ResearchError('SEARCH_EXPIRED', 'This search has expired. Start a new search.');
  }

  return {
    v: 1,
    req: parsedReq.data,
    snap: payload.snap as string,
    off: off as number,
    ps: ps as number,
    exp: payload.exp as number,
    uid: payload.uid as string,
    ch: 'mcp',
    tm: tm as TotalMatches,
  };
}
