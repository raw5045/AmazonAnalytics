// services/keepa/loop.ts
/**
 * The Keepa service loop (spec 2026-10-05 §5.1, §5.3). One iteration = release stale claims,
 * claim up to a batch, wait for tokens, one Keepa request (with the retry policy), parse,
 * one write transaction. Fully injectable: the store, the Keepa calls, the clock, sleep and
 * exit are dependencies, so the policy is unit-tested without Postgres or Keepa.
 */
import { BATCH_SIZE, STALE_CLAIM_MS, TOKENS_PER_ASIN, msUntilTokens, type Lane } from '@/lib/keepa/lanes';
import { KeepaHttpError, KeepaReplyError, KeepaTokenError, type KeepaBatchReply } from '@/lib/keepa/batchClient';
import { parseKeepaBatch } from '@/lib/keepa/parseProduct';
import type { ClaimedRow, KeepaStore } from './store';
import { errFields } from './log';

export const IDLE_SLEEP_MS = 60_000;
export const DB_RETRY_SLEEP_MS = 30_000;
export const KEEPA_RETRY_SLEEP_MS = 30_000;
export const KEEPA_RETRY_ATTEMPTS = 3;
export const BAD_REQUEST_SLEEP_MS = 10 * 60_000;
export const MAX_DB_FAILURES = 10;

export interface KeepaApi {
  fetchBatch(asins: string[]): Promise<KeepaBatchReply>;
  tokenStatus(): Promise<{ tokensLeft: number | null; refillRate: number | null }>;
}

export interface LoopDeps {
  store: KeepaStore;
  keepa: KeepaApi;
  sleep(ms: number): Promise<void>;
  now(): Date;
  log(fields: Record<string, unknown>): void;
  exit(code: number): void;
  bootId: string;
  tailEnabled: boolean;
  batchSize?: number;
  onBatch?(at: Date): void;
}

export interface LoopState {
  tokensLeft: number | null;
  refillRate: number | null;
  lastClaimHadNew: boolean;
  dbFailures: number;
}

export type IterationResult = 'batch' | 'idle' | 'keepa_error' | 'db_error';

export function initialState(): LoopState {
  return { tokensLeft: null, refillRate: null, lastClaimHadNew: false, dbFailures: 0 };
}

async function dbFailure(deps: LoopDeps, state: LoopState, stage: string, e: unknown): Promise<'db_error'> {
  state.dbFailures += 1;
  deps.log({ event: 'db_error', stage, failures: state.dbFailures, ...errFields(e) });
  if (state.dbFailures >= MAX_DB_FAILURES) {
    deps.log({ event: 'exit_db_failures', failures: state.dbFailures });
    deps.exit(1);
  }
  await deps.sleep(DB_RETRY_SLEEP_MS);
  return 'db_error';
}

export async function runIteration(deps: LoopDeps, state: LoopState): Promise<IterationResult> {
  let rows: ClaimedRow[];
  try {
    await deps.store.releaseStaleClaims(STALE_CLAIM_MS);
    rows = await deps.store.claimBatch({ limit: deps.batchSize ?? BATCH_SIZE, tailEnabled: deps.tailEnabled, bootId: deps.bootId });
  } catch (e) {
    return dbFailure(deps, state, 'claim', e);
  }

  // The never-fetched lane just drained: the signal the watcher turns into an explorer sync.
  const hasNew = rows.some((r) => r.lane === 'new');
  if (state.lastClaimHadNew && !hasNew) {
    try {
      await deps.store.markNewLaneDrained();
    } catch (e) {
      deps.log({ event: 'drained_stamp_failed', ...errFields(e) });
    }
  }
  state.lastClaimHadNew = hasNew;

  if (rows.length === 0) {
    try {
      await deps.store.heartbeat({ tokensLeft: state.tokensLeft, refillRate: state.refillRate });
    } catch (e) {
      return dbFailure(deps, state, 'heartbeat', e);
    }
    state.dbFailures = 0;
    await deps.sleep(IDLE_SLEEP_MS);
    return 'idle';
  }

  const wait = msUntilTokens(state.tokensLeft, state.refillRate, rows.length * TOKENS_PER_ASIN);
  if (wait > 0) await deps.sleep(wait);

  const asins = rows.map((r) => r.asin);
  const lane: Lane = rows[0].lane;
  let reply: KeepaBatchReply | null = null;
  let attempts = 0;
  let lastCode = 'keepa_unreachable';
  const t0 = Date.now();
  while (reply === null && attempts < KEEPA_RETRY_ATTEMPTS) {
    try {
      reply = await deps.keepa.fetchBatch(asins);
    } catch (e) {
      if (e instanceof KeepaTokenError) {
        // Not an attempt: Keepa told us exactly how long to wait.
        state.tokensLeft = 0;
        await deps.sleep(e.refillInMs);
        continue;
      }
      if (e instanceof KeepaHttpError && e.status >= 400 && e.status < 500) {
        // Rejected request (bad key, bad parameters): nothing to retry quickly. Record it so the
        // watcher alarms, wait ten minutes, try again — indefinitely, the rows stay claimed.
        try {
          await deps.store.recordError(`keepa_http_${e.status}`);
        } catch (dbErr) {
          deps.log({ event: 'record_error_failed', ...errFields(dbErr) });
        }
        deps.log({ event: 'keepa_rejected', status: e.status });
        await deps.sleep(BAD_REQUEST_SLEEP_MS);
        continue;
      }
      attempts += 1;
      lastCode =
        e instanceof KeepaHttpError ? `keepa_http_${e.status}` : e instanceof KeepaReplyError ? 'keepa_bad_reply' : e instanceof Error ? e.name : 'keepa_error';
      deps.log({ event: 'keepa_retry', attempt: attempts, ...errFields(e) });
      if (attempts < KEEPA_RETRY_ATTEMPTS) await deps.sleep(KEEPA_RETRY_SLEEP_MS);
    }
  }

  if (reply === null) {
    try {
      await deps.store.markBatchErrored({ rows, errorCode: lastCode, now: deps.now() });
    } catch (e) {
      return dbFailure(deps, state, 'mark_errored', e);
    }
    state.dbFailures = 0;
    deps.log({ event: 'batch_errored', lane, requested: rows.length, code: lastCode });
    return 'keepa_error';
  }

  state.tokensLeft = reply.tokensLeft;
  state.refillRate = reply.refillRate ?? state.refillRate;
  const facts = parseKeepaBatch(asins, reply.products);
  const now = deps.now();
  try {
    await deps.store.writeBatch({ rows, facts, lane, tokens: { tokensLeft: reply.tokensLeft, refillRate: reply.refillRate }, now });
  } catch (e) {
    return dbFailure(deps, state, 'write', e);
  }
  state.dbFailures = 0;
  deps.onBatch?.(now);
  const counts = { active: 0, no_price: 0, delisted: 0, error: 0 };
  for (const f of facts.values()) counts[f.status] += 1;
  deps.log({ event: 'batch', lane, requested: rows.length, ...counts, tokensLeft: reply.tokensLeft, ms: Date.now() - t0 });
  return 'batch';
}

/** Never returns on its own; `deps.exit` ends the process after MAX_DB_FAILURES in a row. */
export async function runForever(deps: LoopDeps): Promise<void> {
  const state = initialState();
  try {
    const t = await deps.keepa.tokenStatus();
    state.tokensLeft = t.tokensLeft;
    state.refillRate = t.refillRate;
    deps.log({ event: 'token_status', ...t });
  } catch (e) {
    deps.log({ event: 'token_status_failed', ...errFields(e) });
  }
  for (;;) {
    await runIteration(deps, state);
  }
}
