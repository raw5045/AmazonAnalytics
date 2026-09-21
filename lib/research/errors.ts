/** Stable domain codes (amendment §3.7). Messages are safe to show a person; never SQL, tokens or other accounts. */
export const RESEARCH_ERROR_CODES = [
  'INVALID_FILTERS',
  'UNSUPPORTED_FILTER',
  'CATEGORY_NOT_AVAILABLE',
  'KEYWORD_NOT_FOUND',
  'SEARCH_EXPIRED',
  'INVALID_CURSOR',
  'RESPONSE_TOO_LARGE',
  'RATE_LIMITED',
  'QUERY_TIMEOUT',
  'HISTORY_UNAVAILABLE',
  'DATA_UNAVAILABLE',
] as const;
export type ResearchErrorCode = (typeof RESEARCH_ERROR_CODES)[number];

/** One rejected input field: where it failed and why. Safe to show a person — never SQL, tokens or other accounts. */
export interface ResearchFieldIssue {
  path: string;
  message: string;
}

export interface ResearchErrorInfo {
  code: ResearchErrorCode;
  message: string;
  retryable: boolean;
  retryAfterSeconds?: number;
  details?: ReadonlyArray<ResearchFieldIssue>;
}

export interface ResearchErrorOptions {
  retryable?: boolean;
  retryAfterSeconds?: number;
  details?: ReadonlyArray<ResearchFieldIssue>;
  cause?: unknown;
}

export class ResearchError extends Error {
  readonly code: ResearchErrorCode;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;
  readonly details?: ReadonlyArray<ResearchFieldIssue>;

  constructor(code: ResearchErrorCode, message: string, opts: ResearchErrorOptions = {}) {
    super(message, { cause: opts.cause });
    this.name = 'ResearchError';
    this.code = code;
    this.retryable = opts.retryable ?? false;
    this.retryAfterSeconds = opts.retryAfterSeconds;
    this.details = opts.details;
  }

  toInfo(): ResearchErrorInfo {
    const info: ResearchErrorInfo = { code: this.code, message: this.message, retryable: this.retryable };
    if (this.retryAfterSeconds !== undefined) info.retryAfterSeconds = this.retryAfterSeconds;
    if (this.details !== undefined) info.details = this.details;
    return info;
  }
}

export function isResearchError(e: unknown): e is ResearchError {
  return e instanceof ResearchError;
}

/**
 * The standard INVALID_CURSOR error: cursor.ts's own verifyCursor (MAC, JSON or schema failure —
 * no per-field detail to offer, so `details` is omitted) and contracts.ts's parseSearchInput (a
 * malformed `{ cursor }` continuation, with the zod issue paths as `details`) both throw exactly
 * this, so the code and message live in one place instead of two hand-copied literals.
 */
export function invalidCursorError(details?: ReadonlyArray<ResearchFieldIssue>): ResearchError {
  return new ResearchError('INVALID_CURSOR', 'The cursor is not valid. Start a new search.', { details });
}

/**
 * The standard DATA_UNAVAILABLE error: the snapshot meta row is missing (the kill switch, or
 * a fresh deploy before the first weekly import). search.ts, history.ts and categories.ts all
 * throw exactly this (with its fixed 120s retry — the kill-switch cadence) so the message and
 * retry metadata live in one place instead of hand-copied literals.
 *
 * I2: a distinct cause with its own cadence and wording — a pg-pool connect-queue timeout
 * (`isPoolConnectTimeout` in lib/db/tcpPool.ts), where the pool itself is healthy and the
 * caller just lost the race for a client — gets its own factory, `poolBusyError()` below,
 * rather than an override argument here: "the dataset is being refreshed" would misstate that
 * cause, so service.ts's `guarded()` calls `poolBusyError()` for it instead of this function.
 */
export function dataUnavailableError(): ResearchError {
  return new ResearchError('DATA_UNAVAILABLE', 'The keyword dataset is being refreshed; try again in a few minutes.', { retryable: true, retryAfterSeconds: 120 });
}

/**
 * The standard pool-busy error (I2): service.ts's `guarded()` throws this when
 * `isPoolConnectTimeout` (lib/db/tcpPool.ts) recognizes a pg-pool connect-queue timeout — a
 * plain `Error` with no SQLSTATE, raised when every pooled connection is busy. Distinct from
 * `dataUnavailableError()` above: the dataset itself is fine here, so the message says the
 * service is busy, not that the dataset is refreshing, and the retry is a short 5s (the caller
 * just needs to wait for a connection, not for a weekly import) rather than 120s.
 */
export function poolBusyError(): ResearchError {
  return new ResearchError('DATA_UNAVAILABLE', 'KeywordQuarry is busy right now; try again in a few seconds.', { retryable: true, retryAfterSeconds: 5 });
}

/**
 * The standard QUERY_TIMEOUT error for a statement cancelled by `statement_timeout` (SQLSTATE
 * 57014, surfaced as `'timeout'` by `withReadOnlyTx`). `budgetMs` is the transaction's own
 * deadline, rendered as whole seconds (rounded up, so a sub-second remainder still reads as a
 * full second rather than 0). `opts.guidance` REPLACES the default search-oriented sentence
 * ("Narrow the criteria (a category scope or a tighter range) and try again; this is not an
 * empty result.") rather than appending to it: search.ts and history.ts pass no `guidance` and
 * get that default, but categories.ts passes its own ('Category lookup timed out; try again.')
 * so the category message never carries search-specific advice that doesn't apply to it.
 * `opts.retryAfterSeconds` is left undefined by default — search.ts's and history.ts's
 * timeouts have no fixed retry cadence — but categories.ts passes its own 5-second cadence
 * through explicitly, so its callers keep that distinct advice.
 */
export function queryTimeoutError(budgetMs: number, opts: { guidance?: string; retryAfterSeconds?: number } = {}): ResearchError {
  const guidance = opts.guidance ?? 'Narrow the criteria (a category scope or a tighter range) and try again; this is not an empty result.';
  const message = `The query took longer than its ${Math.ceil(budgetMs / 1000)}-second budget. ${guidance}`;
  return new ResearchError('QUERY_TIMEOUT', message, { retryable: true, retryAfterSeconds: opts.retryAfterSeconds });
}

/**
 * The standard KEYWORD_NOT_FOUND error: history.ts and details.ts both throw exactly this for
 * a `searchTermId` with no matching `search_terms` row, so the code and message live in one
 * place instead of two hand-copied literals.
 */
export function keywordNotFoundError(): ResearchError {
  return new ResearchError('KEYWORD_NOT_FOUND', 'No keyword exists with that id.');
}

/**
 * The standard SEARCH_EXPIRED error, for the two distinct reasons a continuation can no longer
 * run: the weekly snapshot moved out from under it (`'snapshot_changed'` — search.ts's
 * runSearch, when the meta it just read no longer matches the cursor's snapshot), or the
 * cursor's own `exp` timestamp has simply passed (`'cursor_expired'` — cursor.ts's
 * verifyCursor). Never retryable as-is; the caller must start a new search.
 */
export function searchExpiredError(reason: 'snapshot_changed' | 'cursor_expired'): ResearchError {
  const message = reason === 'snapshot_changed'
    ? 'The dataset was refreshed since this search started. Start a new search to see current data.'
    : 'This search has expired. Start a new search.';
  return new ResearchError('SEARCH_EXPIRED', message);
}
