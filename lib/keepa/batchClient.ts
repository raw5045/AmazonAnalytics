// lib/keepa/batchClient.ts
/**
 * Keepa multi-ASIN product request + the free token-status call (spec 2026-10-05 §5.1 step 4).
 *
 * No retries and no pacing here: services/keepa/loop.ts owns both. Errors are typed so the
 * loop can tell "tokens exhausted" (sleep refillIn) from "Keepa rejected the request" (4xx)
 * from "Keepa is down" (5xx / network). Error messages never carry the key.
 */
import { BATCH_SIZE } from './lanes';

export const KEEPA_PRODUCT_URL = 'https://api.keepa.com/product';
export const KEEPA_TOKEN_URL = 'https://api.keepa.com/token';
/** Keepa computes weighted averages over this window; avg30/90/180/365 come regardless. */
export const STATS_DAYS = '90';
/**
 * Task 4's capture decision: `history=0` drops every history array (small replies) when
 * stats.current carries the offer-count indices 34/35; otherwise `days=7` keeps a week of csv
 * and the parser reads the last csv value instead.
 */
export const HISTORY_PARAMS: Readonly<Record<string, string>> = { history: '0' };

export interface KeepaBatchReply {
  products: unknown[];
  tokensLeft: number | null;
  refillIn: number | null;
  refillRate: number | null;
  tokensConsumed: number | null;
}

export interface KeepaClientDeps {
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class KeepaHttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`keepa_http_${status}`);
    this.name = 'KeepaHttpError';
    this.status = status;
  }
}

export class KeepaTokenError extends Error {
  readonly refillInMs: number;
  constructor(refillInMs: number) {
    super('keepa_tokens_exhausted');
    this.name = 'KeepaTokenError';
    this.refillInMs = refillInMs;
  }
}

/** A 200 reply without a `products` array: retried like an outage, never read as "every ASIN delisted". */
export class KeepaReplyError extends Error {
  constructor() {
    super('keepa_bad_reply');
    this.name = 'KeepaReplyError';
  }
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function buildProductUrl(asins: readonly string[], apiKey: string): string {
  const qs = new URLSearchParams({ key: apiKey, domain: '1', asin: asins.join(','), rating: '1', stats: STATS_DAYS, ...HISTORY_PARAMS });
  return `${KEEPA_PRODUCT_URL}?${qs.toString()}`;
}

export async function fetchKeepaBatch(asins: readonly string[], deps: KeepaClientDeps): Promise<KeepaBatchReply> {
  if (asins.length === 0 || asins.length > BATCH_SIZE) throw new Error(`batch size ${asins.length} out of range 1..${BATCH_SIZE}`);
  const f = deps.fetchImpl ?? fetch;
  const res = await f(buildProductUrl(asins, deps.apiKey), { signal: AbortSignal.timeout(deps.timeoutMs ?? 60_000) });
  if (res.status === 429) {
    const body = (await res.json().catch(() => ({}))) as { refillIn?: unknown };
    throw new KeepaTokenError(num(body.refillIn) ?? 60_000);
  }
  if (!res.ok) throw new KeepaHttpError(res.status);
  const body = (await res.json()) as Record<string, unknown>;
  if (!Array.isArray(body.products)) throw new KeepaReplyError();
  return {
    products: body.products,
    tokensLeft: num(body.tokensLeft),
    refillIn: num(body.refillIn),
    refillRate: num(body.refillRate),
    tokensConsumed: num(body.tokensConsumed),
  };
}

/** Free: no tokens consumed. */
export async function fetchTokenStatus(deps: KeepaClientDeps): Promise<{ tokensLeft: number | null; refillRate: number | null; refillIn: number | null }> {
  const f = deps.fetchImpl ?? fetch;
  const qs = new URLSearchParams({ key: deps.apiKey });
  const res = await f(`${KEEPA_TOKEN_URL}?${qs.toString()}`, { signal: AbortSignal.timeout(deps.timeoutMs ?? 20_000) });
  if (!res.ok) throw new KeepaHttpError(res.status);
  const body = (await res.json()) as Record<string, unknown>;
  return { tokensLeft: num(body.tokensLeft), refillRate: num(body.refillRate), refillIn: num(body.refillIn) };
}
