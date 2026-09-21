import { describe, it, expect } from 'vitest';
import { ResearchError, isResearchError } from './errors';

describe('ResearchError', () => {
  it('carries a stable code, a safe message, and retry metadata', () => {
    const e = new ResearchError('RATE_LIMITED', 'Slow down.', { retryable: true, retryAfterSeconds: 17 });
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('RATE_LIMITED');
    expect(e.toInfo()).toEqual({ code: 'RATE_LIMITED', message: 'Slow down.', retryable: true, retryAfterSeconds: 17 });
  });

  it('defaults retryable to false and includes details when given', () => {
    const e = new ResearchError('INVALID_FILTERS', 'Bad input.', { details: [{ path: 'pageSize', message: 'too big' }] });
    expect(e.toInfo()).toEqual({ code: 'INVALID_FILTERS', message: 'Bad input.', retryable: false, details: [{ path: 'pageSize', message: 'too big' }] });
  });

  it('isResearchError narrows', () => {
    expect(isResearchError(new ResearchError('KEYWORD_NOT_FOUND', 'x'))).toBe(true);
    expect(isResearchError(new Error('x'))).toBe(false);
    expect(isResearchError(null)).toBe(false);
  });
});
