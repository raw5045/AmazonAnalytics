// services/keepa/loop.ts
/**
 * The Keepa service loop (spec 2026-10-05 §5.1, §5.3). One iteration = release stale claims,
 * claim up to a batch, wait for tokens, one Keepa request (with the retry policy), parse,
 * one write transaction. Fully injectable: the store, the Keepa calls, the clock, sleep and
 * exit are dependencies, so the policy is unit-tested without Postgres or Keepa. Also here, for
 * the same reason: the independent heartbeat and the SIGTERM claim release that index.ts runs.
 */
import { BATCH_SIZE, STALE_CLAIM_MS, TOKENS_PER_ASIN, msUntilTokens, type Lane } from '@/lib/keepa/lanes';
import { KeepaHttpError, KeepaReplyError, KeepaTokenError, type KeepaBatchReply } from '@/lib/keepa/batchClient';
import { parseKeepaBatch } from '@/lib/keepa/parseProduct';
import type { ProductFacts } from '@/lib/keepa/productFacts';
import type { ClaimedRow, KeepaStore } from './store';
import { errFields } from './log';

export const IDLE_SLEEP_MS = 60_000;
export const DB_RETRY_SLEEP_MS = 30_000;
export const KEEPA_RETRY_SLEEP_MS = 30_000;
export const KEEPA_RETRY_ATTEMPTS = 3;
export const BAD_REQUEST_SLEEP_MS = 10 * 60_000;
export const MAX_DB_FAILURES = 10;
/** The longest single token wait; the next request reveals the real balance anyway. */
export const MAX_TOKEN_WAIT_MS = 2 * 60_000;
/** Token waits up to this are steady state (40–48 s is normal) and ride on the batch line as tokenWaitMs. */
export const TOKEN_WAIT_LOG_MS = 60_000;
/** An all-error batch this large pauses like an outage; smaller ones (a lane's tail) never do. */
export const ALL_ERROR_PAUSE_MIN_ROWS = 10;
/** 429s since the last good fetch before the status row says the tokens are exhausted. */
export const TOKENS_EXHAUSTED_AFTER = 5;
/**
 * Pause before the next claim after a batch Keepa never answered, a large all-error batch, or a
 * second 400 in a row: one minute, doubling to fifteen, reset by a batch with any success.
 */
export const OUTAGE_PAUSE_START_MS = 60_000;
export const OUTAGE_PAUSE_MAX_MS = 15 * 60_000;
export const HEARTBEAT_INTERVAL_MS = 60_000;
/** SIGTERM: how long the claim release may take before the process exits anyway. */
export const SHUTDOWN_RELEASE_TIMEOUT_MS = 10_000;
/** error_code and last_error_code carry a 64-character CHECK (migration 0050). */
const MAX_CODE_LENGTH = 64;

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
  /** Database failures (and escaped throws) in a row; MAX_DB_FAILURES ends the process. */
  dbFailures: number;
  /** 429s since the last good fetch. */
  consecutive429: number;
  /** The last pause before a claim (see OUTAGE_PAUSE_START_MS); 0 after a batch with any success. */
  outagePauseMs: number;
  /** The code the last batch ended with (a failed or all-error batch); null after a batch with any success. */
  lastBatchCode: string | null;
}

export type IterationResult = 'batch' | 'idle' | 'keepa_error' | 'db_error' | 'threw';

export function initialState(): LoopState {
  return { tokensLeft: null, refillRate: null, lastClaimHadNew: false, dbFailures: 0, consecutive429: 0, outagePauseMs: 0, lastBatchCode: null };
}

/** Pause before the next claim: one minute, doubling to fifteen (the state carries the last pause). */
async function outagePause(deps: LoopDeps, state: LoopState): Promise<void> {
  state.outagePauseMs = state.outagePauseMs === 0 ? OUTAGE_PAUSE_START_MS : Math.min(state.outagePauseMs * 2, OUTAGE_PAUSE_MAX_MS);
  deps.log({ event: 'outage_pause', ms: state.outagePauseMs });
  await deps.sleep(state.outagePauseMs);
}

async function countFailure(deps: LoopDeps, state: LoopState, fields: Record<string, unknown>): Promise<void> {
  state.dbFailures += 1;
  deps.log({ ...fields, failures: state.dbFailures });
  if (state.dbFailures >= MAX_DB_FAILURES) {
    deps.log({ event: 'exit_db_failures', failures: state.dbFailures });
    deps.exit(1);
  }
  await deps.sleep(DB_RETRY_SLEEP_MS);
}

async function dbFailure(deps: LoopDeps, state: LoopState, stage: string, e: unknown): Promise<'db_error'> {
  await countFailure(deps, state, { event: 'db_error', stage, ...errFields(e) });
  return 'db_error';
}

/** The status row's last error, best-effort: a failure to record it is logged, never thrown. */
async function recordErrorQuietly(deps: LoopDeps, code: string): Promise<void> {
  try {
    await deps.store.recordError(code);
  } catch (e) {
    deps.log({ event: 'record_error_failed', ...errFields(e) });
  }
}

/** The stored code for a failed Keepa request: coded and bounded, never a message. */
function keepaErrorCode(e: unknown): string {
  if (e instanceof KeepaHttpError) return `keepa_http_${e.status}`;
  if (e instanceof KeepaReplyError) return 'keepa_bad_reply';
  const o = (e ?? null) as { name?: unknown; cause?: unknown } | null;
  // AbortSignal.timeout() rejects with a DOMException named TimeoutError (AbortError on older paths).
  if (o?.name === 'TimeoutError' || o?.name === 'AbortError') return 'keepa_timeout';
  // fetch wraps a network failure in a TypeError whose cause carries the code (ENOTFOUND, ECONNRESET…).
  const causeCode = ((o?.cause ?? null) as { code?: unknown } | null)?.code;
  if (typeof causeCode === 'string') return `keepa_network_${causeCode}`.slice(0, MAX_CODE_LENGTH);
  return e instanceof Error ? e.name.slice(0, MAX_CODE_LENGTH) : 'keepa_error';
}

/** The most frequent error code in a parsed batch; the first one seen wins a tie. */
function commonErrorCode(facts: Map<string, ProductFacts>): string {
  const seen = new Map<string, number>();
  let best = 'error';
  let bestCount = 0;
  for (const f of facts.values()) {
    if (f.status !== 'error') continue;
    const code = f.errorCode ?? 'error';
    const n = (seen.get(code) ?? 0) + 1;
    seen.set(code, n);
    if (n > bestCount) {
      best = code;
      bestCount = n;
    }
  }
  return best;
}

export async function runIteration(deps: LoopDeps, state: LoopState): Promise<IterationResult> {
  let rows: ClaimedRow[];
  let released = 0;
  try {
    released = await deps.store.releaseStaleClaims(STALE_CLAIM_MS);
    rows = await deps.store.claimBatch({ limit: deps.batchSize ?? BATCH_SIZE, tailEnabled: deps.tailEnabled, bootId: deps.bootId });
  } catch (e) {
    return dbFailure(deps, state, 'claim', e);
  }
  if (released > 0) deps.log({ event: 'stale_claims_released', count: released });

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

  const wait = Math.min(msUntilTokens(state.tokensLeft, state.refillRate, rows.length * TOKENS_PER_ASIN), MAX_TOKEN_WAIT_MS);
  if (wait > 0) {
    // A long wait gets its own line up front; every wait also rides on the batch line as tokenWaitMs.
    if (wait > TOKEN_WAIT_LOG_MS) deps.log({ event: 'token_wait', ms: wait });
    await deps.sleep(wait);
  }

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
        // Not an attempt: Keepa told us exactly how long to wait. Persistent 429s (TOKENS_EXHAUSTED_AFTER
        // since the last good fetch) go on the status row, so the watcher can tell "out of tokens" from "down".
        state.tokensLeft = 0;
        state.consecutive429 += 1;
        if (state.consecutive429 >= TOKENS_EXHAUSTED_AFTER) {
          await recordErrorQuietly(deps, 'keepa_tokens_exhausted');
          deps.log({ event: 'tokens_exhausted', consecutive: state.consecutive429 });
        }
        await deps.sleep(e.refillInMs);
        continue;
      }
      if (e instanceof KeepaHttpError && e.status > 400 && e.status < 500) {
        // Rejected (bad key, plan lapsed, forbidden): nothing to retry quickly. Record it so the
        // watcher alarms, wait ten minutes, try again — indefinitely, the rows stay claimed.
        await recordErrorQuietly(deps, `keepa_http_${e.status}`);
        deps.log({ event: 'keepa_rejected', status: e.status });
        await deps.sleep(BAD_REQUEST_SLEEP_MS);
        continue;
      }
      // An outage (5xx, network, timeout, a reply that is not a product list) or a 400 (this batch's
      // request itself is bad): three attempts 30 s apart, then the batch is marked errored.
      attempts += 1;
      lastCode = keepaErrorCode(e);
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
    // Keepa never answered: pause before the next claim, so a long outage costs one attempt series
    // per pause rather than one per batch. A 400 is about this batch's request, so a single one
    // goes on at once; a second in a row is systematic and pauses too.
    const repeated400 = lastCode === 'keepa_http_400' && state.lastBatchCode === 'keepa_http_400';
    state.lastBatchCode = lastCode;
    if (lastCode !== 'keepa_http_400' || repeated400) await outagePause(deps, state);
    return 'keepa_error';
  }

  // Keepa answered: the 429 count starts over (the outage pause resets only on a batch with any success).
  state.consecutive429 = 0;
  state.tokensLeft = reply.tokensLeft;
  state.refillRate = reply.refillRate ?? state.refillRate;
  const facts = parseKeepaBatch(asins, reply.products);
  const counts = { active: 0, no_price: 0, delisted: 0, error: 0 };
  for (const f of facts.values()) counts[f.status] += 1;
  // Nothing usable came back (every outcome an error): the rows are still written, so their backoff
  // stops repeated spend, but as a failed batch the watcher can see.
  const batchErrorCode = counts.error === facts.size ? commonErrorCode(facts) : undefined;
  const now = deps.now();
  try {
    await deps.store.writeBatch({ rows, facts, lane, tokens: { tokensLeft: reply.tokensLeft, refillRate: reply.refillRate }, now, batchErrorCode });
  } catch (e) {
    return dbFailure(deps, state, 'write', e);
  }
  state.dbFailures = 0;
  if (batchErrorCode !== undefined) {
    deps.log({ event: 'batch_all_errors', lane, requested: rows.length, code: batchErrorCode });
    state.lastBatchCode = batchErrorCode;
    // A systematic parse failure must not chew through the queue: a large all-error batch pauses
    // like an outage. A small one (a lane's tail) never does.
    if (rows.length >= ALL_ERROR_PAUSE_MIN_ROWS) await outagePause(deps, state);
    return 'keepa_error';
  }
  state.outagePauseMs = 0;
  state.lastBatchCode = null;
  deps.onBatch?.(now);
  deps.log({ event: 'batch', lane, requested: rows.length, ...counts, tokensLeft: reply.tokensLeft, tokenWaitMs: wait, ms: Date.now() - t0 });
  return 'batch';
}

/**
 * One iteration that never rejects: anything runIteration lets escape (a throwing logger or
 * callback) is logged and counted like a database failure, so ten in a row still end the process.
 */
export async function safeIteration(deps: LoopDeps, state: LoopState): Promise<IterationResult> {
  try {
    return await runIteration(deps, state);
  } catch (e) {
    await countFailure(deps, state, { event: 'iteration_threw', ...errFields(e) });
    return 'threw';
  }
}

/**
 * The independent heartbeat (index.ts): "process alive and database reachable", whatever the loop
 * is doing — a store transaction can wait ~30 minutes on the enqueue lock, and this status-row
 * UPDATE takes no advisory lock. Null token values leave the stored ones as they are. One beat at a
 * time, so a slow database cannot pile up connections; unref'd, so it never keeps the process up.
 */
export function startHeartbeat(store: Pick<KeepaStore, 'heartbeat'>, log: LoopDeps['log'], intervalMs = HEARTBEAT_INTERVAL_MS): ReturnType<typeof setInterval> {
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    store
      .heartbeat({ tokensLeft: null, refillRate: null })
      .catch((e: unknown) => log({ event: 'heartbeat_failed', ...errFields(e) }))
      .finally(() => {
        inFlight = false;
      });
  }, intervalMs);
  timer.unref();
  return timer;
}

/**
 * SIGTERM (index.ts): free this boot's claims at once instead of after STALE_CLAIM_MS. Bounded by
 * `timeoutMs`, so a hung database cannot block shutdown (the claims then free themselves later).
 * Resolves to the number released, or null when the release failed or timed out.
 */
export async function releaseOwnClaimsOnShutdown(
  store: Pick<KeepaStore, 'releaseOwnClaims'>,
  bootId: string,
  log: LoopDeps['log'],
  timeoutMs = SHUTDOWN_RELEASE_TIMEOUT_MS,
): Promise<number | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  try {
    const r = await Promise.race([store.releaseOwnClaims(bootId), timedOut]);
    if (r === 'timeout') {
      log({ event: 'sigterm', released: null, timedOut: true });
      return null;
    }
    log({ event: 'sigterm', released: r });
    return r;
  } catch (e) {
    log({ event: 'sigterm', released: null, ...errFields(e) });
    return null;
  } finally {
    clearTimeout(timer);
  }
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
    await safeIteration(deps, state);
  }
}
