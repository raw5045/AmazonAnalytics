import { describe, it, expect } from 'vitest';
import { ResearchError, isResearchError, invalidCursorError } from './errors';

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
