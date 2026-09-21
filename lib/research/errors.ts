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
 * throw exactly this so the message and retry metadata live in one place instead of
 * hand-copied literals.
 */
export function dataUnavailableError(): ResearchError {
  return new ResearchError('DATA_UNAVAILABLE', 'The keyword dataset is being refreshed; try again in a few minutes.', { retryable: true, retryAfterSeconds: 120 });
}

/**
 * The standard QUERY_TIMEOUT error for a statement cancelled by `statement_timeout` (SQLSTATE
 * 57014, surfaced as `'timeout'` by `withReadOnlyTx`). `budgetMs` is the transaction's own
 * deadline, rendered as whole seconds (rounded up, so a sub-second remainder still reads as a
 * full second rather than 0); `hint` appends caller-specific guidance after the generic
 * message. `retryAfterSeconds` is left undefined by default — search.ts's and history.ts's
 * timeouts have no fixed retry cadence — but categories.ts passes its own 5-second cadence
 * through explicitly, so its callers keep that distinct advice.
 */
export function queryTimeoutError(budgetMs: number, hint?: string, retryAfterSeconds?: number): ResearchError {
  const message = `The query took longer than its ${Math.ceil(budgetMs / 1000)}-second budget. Narrow the criteria (a category scope or a tighter range) and try again; this is not an empty result.${hint ? ` ${hint}` : ''}`;
  return new ResearchError('QUERY_TIMEOUT', message, { retryable: true, retryAfterSeconds });
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
