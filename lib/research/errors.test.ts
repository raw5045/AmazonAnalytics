import { describe, it, expect } from 'vitest';
import { ResearchError, isResearchError, invalidCursorError, dataUnavailableError, queryTimeoutError, searchExpiredError } from './errors';

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
  it('builds the standard DATA_UNAVAILABLE error', () => {
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
  it('appends an optional hint after the generic message', () => {
    const e = queryTimeoutError(3_000, 'Category lookup timed out; try again.');
    expect(e.message).toContain('3-second');
    expect(e.message).toContain('Category lookup timed out; try again.');
  });
  it('accepts an explicit retryAfterSeconds for a caller with its own retry cadence', () => {
    const e = queryTimeoutError(3_000, 'Category lookup timed out; try again.', 5);
    expect(e.retryAfterSeconds).toBe(5);
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
