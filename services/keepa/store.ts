// services/keepa/store.ts
import type { Lane, Tier } from '@/lib/keepa/lanes';
import type { ProductFacts } from '@/lib/keepa/productFacts';

export interface ClaimedRow {
  asin: string;
  tier: Tier;
  lane: Lane;
  lastFetchedAt: Date | null;
  consecutiveErrors: number;
}

export interface TokenInfo {
  tokensLeft: number | null;
  refillRate: number | null;
}

/** Everything the loop needs from Postgres, so the loop can be tested with an in-memory fake. */
export interface KeepaStore {
  recordBoot(bootId: string, tailEnabled: boolean): Promise<void>;
  releaseStaleClaims(olderThanMs: number): Promise<number>;
  claimBatch(args: { limit: number; tailEnabled: boolean; bootId: string }): Promise<ClaimedRow[]>;
  writeBatch(args: { rows: ClaimedRow[]; facts: Map<string, ProductFacts>; lane: Lane; tokens: TokenInfo; now: Date }): Promise<void>;
  markBatchErrored(args: { rows: ClaimedRow[]; errorCode: string; now: Date }): Promise<void>;
  heartbeat(tokens: TokenInfo): Promise<void>;
  recordError(code: string): Promise<void>;
  markNewLaneDrained(): Promise<void>;
}
