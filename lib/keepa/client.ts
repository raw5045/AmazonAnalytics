/**
 * Thin fetch wrapper for Keepa's /product endpoint + a token-bucket
 * pacer designed for sequential per-ASIN calls.
 *
 * Tier assumption: 250 tokens/min. With `rating=1` we spend 2 tokens
 * per ASIN, so steady-state is ~125 ASINs/min ≈ 2 ASINs/sec.
 *
 * Pacing strategy: when the most recently observed tokensLeft falls
 * below REFILL_FLOOR (50, i.e. fewer than ~25 ASINs of headroom),
 * sleep just long enough for at least REFILL_AMOUNT (100) tokens to
 * refill. That's ~24s of guaranteed buffer per pause — enough for
 * the next ~50 ASINs without another pause.
 *
 * No retries here: callers (Inngest jobs / one-shot scripts) decide
 * what to do with an error per their own policy.
 */
import type { KeepaProductResponse } from './types';

const KEEPA_BASE = 'https://api.keepa.com/product';
const REFILL_RATE_PER_SEC = 250 / 60; // 250 tokens/min tier
const REFILL_FLOOR = 50;
const REFILL_AMOUNT = 100;

export interface KeepaCallOptions {
  /** If true, sets ?rating=1 so reviews/rating come back. Costs +1 token. */
  rating?: boolean;
}

export interface KeepaCallResult {
  data: KeepaProductResponse;
  tokensLeft: number;
}

export async function callKeepa(
  asin: string,
  opts: KeepaCallOptions = {},
  apiKey: string = process.env.KEEPA_API_KEY ?? '',
): Promise<KeepaCallResult> {
  if (!apiKey) throw new Error('KEEPA_API_KEY not set');
  const qs = new URLSearchParams({ key: apiKey, domain: '1', asin });
  if (opts.rating) qs.set('rating', '1');
  const res = await fetch(`${KEEPA_BASE}?${qs.toString()}`);
  if (!res.ok) {
    throw new Error(`Keepa HTTP ${res.status} for ${asin}`);
  }
  const data = (await res.json()) as KeepaProductResponse;
  return { data, tokensLeft: data.tokensLeft ?? 0 };
}

/**
 * Token-bucket pacer. Usage pattern:
 *
 *   const pacer = new KeepaPacer();
 *   for (const asin of asins) {
 *     await pacer.maybeSleep();          // sleep if bucket is low
 *     const r = await callKeepa(asin, { rating: true });
 *     pacer.observe(r.tokensLeft);       // update state
 *     // ...handle r.data
 *   }
 *
 * The pacer is single-purpose: it doesn't track requests-per-second
 * (Keepa doesn't impose that, only tokens-per-minute). Concurrency
 * is bounded by structure of the caller, not by this class.
 */
export class KeepaPacer {
  private lastTokensLeft: number | null = null;

  /** Record the tokensLeft from the most recent response. */
  observe(tokensLeft: number) {
    this.lastTokensLeft = tokensLeft;
  }

  /**
   * Sleep just long enough for the bucket to refill past REFILL_FLOOR.
   * No-op when there's still headroom. Returns whether we slept and
   * for how long — useful for progress logging.
   */
  async maybeSleep(): Promise<{ slept: boolean; ms: number }> {
    if (this.lastTokensLeft === null || this.lastTokensLeft >= REFILL_FLOOR) {
      return { slept: false, ms: 0 };
    }
    const need = REFILL_AMOUNT - this.lastTokensLeft;
    const ms = Math.ceil(need / REFILL_RATE_PER_SEC) * 1000;
    await new Promise((r) => setTimeout(r, ms));
    return { slept: true, ms };
  }
}
