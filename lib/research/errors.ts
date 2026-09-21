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
