import { describe, it, expect } from 'vitest';
import { ResearchError, isResearchError, invalidCursorError, dataUnavailableError, poolBusyError, queryTimeoutError, searchExpiredError, keywordNotFoundError } from './errors';

describe('ResearchError', () => {
  it('carries a stable code, a safe message, and retry metadata', () => {
    const e = new ResearchError('RATE_LIMITED', 'Slow down.', { retryable: true, retryAfterSeconds: 17 });
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('RATE_LIMITED');
    expect(e.toInfo()).toStrictEqual({ code: 'RATE_LIMITED', message: 'Slow down.', retryable: true, retryAfterSeconds: 17 });
  });

  it('defaults retryable to false and includes details when given', () => {
    const e = new ResearchError('INVALID_FILTERS', 'Bad input.', { details: [{ path: 'pageSize', message: 'too big' }] });
    expect(e.toInfo()).toStrictEqual({ code: 'INVALID_FILTERS', message: 'Bad input.', retryable: false, details: [{ path: 'pageSize', message: 'too big' }] });
  });

  it('keeps cause on the error but leaves it out of toInfo()', () => {
    const cause = new Error('underlying socket failure');
    const e = new ResearchError('DATA_UNAVAILABLE', 'Try again shortly.', { cause });
    expect(e.cause).toBe(cause);
    expect(e.toInfo()).toStrictEqual({ code: 'DATA_UNAVAILABLE', message: 'Try again shortly.', retryable: false });
    expect('cause' in e.toInfo()).toBe(false);
  });

  it('isResearchError narrows', () => {
    expect(isResearchError(new ResearchError('KEYWORD_NOT_FOUND', 'x'))).toBe(true);
    expect(isResearchError(new Error('x'))).toBe(false);
    expect(isResearchError(null)).toBe(false);
  });
});

describe('invalidCursorError', () => {
  it('builds the standard INVALID_CURSOR error, with or without field details', () => {
    const bare = invalidCursorError();
    expect(bare).toBeInstanceOf(ResearchError);
    expect(bare.toInfo()).toStrictEqual({ code: 'INVALID_CURSOR', message: 'The cursor is not valid. Start a new search.', retryable: false });

    const withDetails = invalidCursorError([{ path: 'cursor', message: 'too short' }]);
    expect(withDetails.toInfo()).toStrictEqual({
      code: 'INVALID_CURSOR',
      message: 'The cursor is not valid. Start a new search.',
      retryable: false,
      details: [{ path: 'cursor', message: 'too short' }],
    });
  });
});

describe('dataUnavailableError', () => {
  it('builds the standard DATA_UNAVAILABLE error, with a fixed 120s retry', () => {
    const e = dataUnavailableError();
    expect(e).toBeInstanceOf(ResearchError);
    expect(e.toInfo()).toStrictEqual({
      code: 'DATA_UNAVAILABLE',
      message: 'The keyword dataset is being refreshed; try again in a few minutes.',
      retryable: true,
      retryAfterSeconds: 120,
    });
  });
});

describe('poolBusyError', () => {
  // I2: a pool connect-queue timeout is a distinct cause from a missing snapshot (dataset is
  // fine, every pooled connection is just busy) — its own message and a short 5s retry, never
  // dataUnavailableError's "dataset is being refreshed" wording, which would misstate the cause.
  it('builds a DATA_UNAVAILABLE error with its own pool-busy message and a 5s retry', () => {
    const e = poolBusyError();
    expect(e).toBeInstanceOf(ResearchError);
    expect(e.toInfo()).toStrictEqual({
      code: 'DATA_UNAVAILABLE',
      message: 'KeywordQuarry is busy right now; try again in a few seconds.',
      retryable: true,
      retryAfterSeconds: 5,
    });
  });
  it('never shares dataUnavailableError\'s message, so the two causes stay distinguishable', () => {
    expect(poolBusyError().message).not.toBe(dataUnavailableError().message);
  });
});

describe('queryTimeoutError', () => {
  it('states the budget in whole seconds, rounded up', () => {
    const e = queryTimeoutError(10_000);
    expect(e).toBeInstanceOf(ResearchError);
    expect(e.code).toBe('QUERY_TIMEOUT');
    expect(e.retryable).toBe(true);
    expect(e.message).toContain('10-second');
    expect(e.retryAfterSeconds).toBeUndefined();
  });
  it('rounds a sub-second remainder up to a full second', () => {
    expect(queryTimeoutError(3_001).message).toContain('4-second');
  });
  it('uses the default search-guidance sentence when no guidance is given', () => {
    const e = queryTimeoutError(10_000);
    expect(e.message).toContain('Narrow the criteria (a category scope or a tighter range) and try again; this is not an empty result.');
  });
  it('replaces the default guidance with a caller-specific one, instead of appending to it', () => {
    const e = queryTimeoutError(3_000, { guidance: 'Category lookup timed out; try again.' });
    expect(e.message).toContain('3-second');
    expect(e.message).toContain('Category lookup timed out; try again.');
    expect(e.message).not.toContain('Narrow the criteria');
  });
  it('accepts an explicit retryAfterSeconds for a caller with its own retry cadence', () => {
    const e = queryTimeoutError(3_000, { guidance: 'Category lookup timed out; try again.', retryAfterSeconds: 5 });
    expect(e.retryAfterSeconds).toBe(5);
  });
});

describe('keywordNotFoundError', () => {
  it('builds the standard KEYWORD_NOT_FOUND error', () => {
    const e = keywordNotFoundError();
    expect(e).toBeInstanceOf(ResearchError);
    expect(e.toInfo()).toStrictEqual({ code: 'KEYWORD_NOT_FOUND', message: 'No keyword exists with that id.', retryable: false });
  });
});

describe('searchExpiredError', () => {
  it('distinguishes a moved snapshot from a plain cursor expiry, both as SEARCH_EXPIRED', () => {
    const moved = searchExpiredError('snapshot_changed');
    expect(moved.code).toBe('SEARCH_EXPIRED');
    expect(moved.retryable).toBe(false);
    expect(moved.message).toBe('The dataset was refreshed since this search started. Start a new search to see current data.');

    const expired = searchExpiredError('cursor_expired');
    expect(expired.code).toBe('SEARCH_EXPIRED');
    expect(expired.message).toBe('This search has expired. Start a new search.');
  });
});
