import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { env } from '@/lib/env';
import { searchRequestSchema, MAX_CURSOR_LENGTH, PAGE_SIZE_MAX, TOTAL_MATCHES_KINDS } from './contracts';
import type { SearchRequest, TotalMatches } from './contracts';
import { ResearchError, invalidCursorError } from './errors';

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

/** Single source is contracts.ts; re-exported here so cursor.ts's public API is unchanged. */
export { MAX_CURSOR_LENGTH };

/**
 * The exact runtime shape of a decoded cursor body. Mirrors CursorPayload field-for-field, but as
 * a zod schema so a single safeParse rejects a structurally-off or numerically-abusive payload —
 * ps: 0, a non-safe-integer off (e.g. 1e300), an infinite/non-integer exp, an unknown tm.kind, or
 * a stray extra key anywhere (z.strictObject, including on tm) — instead of the hand-rolled
 * per-field checks this replaces. `req` re-validates against searchRequestSchema itself (the
 * service re-applies presets from it, so it must be valid — cheap insurance beyond the MAC
 * alone).
 */
const cursorPayloadSchema = z.strictObject({
  v: z.literal(1),
  req: searchRequestSchema,
  snap: z.string().min(1),
  off: z.int().min(0),
  ps: z.int().min(1).max(PAGE_SIZE_MAX),
  exp: z.int().positive(),
  uid: z.string().min(1),
  ch: z.literal('mcp'),
  tm: z.strictObject({ kind: z.enum(TOTAL_MATCHES_KINDS), value: z.int().min(0).nullable() }),
});

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
 * The MAC check compares the *encoded* base64url strings in constant time — the same convention
 * lib/notifications/digest/unsubToken.ts uses — rather than base64url-decoding the given
 * signature first: a lenient decoder can treat a subtly different encoded string (e.g. one with
 * extra padding) as the same bytes, which would let a corrupted signature slip past a
 * decode-then-compare check.
 *
 * The shape check is cursorPayloadSchema (see its doc comment) in one safeParse; any failure —
 * including `req` failing searchRequestSchema — is INVALID_CURSOR.
 */
export function verifyCursor(token: string, secret: string, nowSeconds: number): CursorPayload {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_CURSOR_LENGTH) throw invalidCursorError();
  const dot = token.lastIndexOf('.');
  if (dot <= 0) throw invalidCursorError();
  const body = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(createHmac('sha256', secret).update(body).digest('base64url'));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw invalidCursorError();

  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursorError();
  }

  const parsed = cursorPayloadSchema.safeParse(raw);
  if (!parsed.success) throw invalidCursorError();

  if (parsed.data.exp <= nowSeconds) {
    throw new ResearchError('SEARCH_EXPIRED', 'This search has expired. Start a new search.');
  }

  return parsed.data;
}
