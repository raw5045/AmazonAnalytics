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
  /**
   * `batchErrorCode`: every outcome in the batch was an error. The rows are written as usual (their
   * backoff stops repeated spend), but the status row records the code as its last error instead
   * of a batch.
   */
  writeBatch(args: { rows: ClaimedRow[]; facts: Map<string, ProductFacts>; lane: Lane; tokens: TokenInfo; now: Date; batchErrorCode?: string }): Promise<void>;
  markBatchErrored(args: { rows: ClaimedRow[]; errorCode: string; now: Date }): Promise<void>;
  heartbeat(tokens: TokenInfo): Promise<void>;
  recordError(code: string): Promise<void>;
  markNewLaneDrained(): Promise<void>;
  /** SIGTERM: free every claim this boot holds at once. Resolves to the number released. */
  releaseOwnClaims(bootId: string): Promise<number>;
  /**
   * The old import-time enrichment job (worker/keepaJobs.ts) is mid-run: a keepa_enrichment_runs row
   * has a heartbeat from the last ten minutes, whatever its status (a detached run past its poll
   * budget is marked 'orphaned' but keeps heartbeating). It shares the Keepa token bucket and has no
   * 429 handling, so the service yields while it runs. Goes away with the old job in phase 3.
   */
  oldJobRunning(): Promise<boolean>;
}
