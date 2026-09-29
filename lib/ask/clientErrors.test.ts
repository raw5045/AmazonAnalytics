import { describe, it, expect } from 'vitest';
import { describeChatError, GENERIC_ERROR } from './clientErrors';
import { BUSY_LINE, PROBLEM_LINE } from './messages';

describe('describeChatError', () => {
  it('surfaces the server error line from a JSON body, otherwise the generic sentence', () => {
    expect(describeChatError(new Error(JSON.stringify({ error: 'Wait for the current answer to finish.', code: 'busy' })))).toBe('Wait for the current answer to finish.');
    expect(describeChatError(new Error('Failed to fetch'))).toBe(GENERIC_ERROR);
    expect(describeChatError(undefined)).toBe(GENERIC_ERROR);
    expect(describeChatError(new Error(PROBLEM_LINE))).toBe(PROBLEM_LINE);
  });
  it('matches BUSY_LINE by exact text only, not a prefix or a substring', () => {
    expect(describeChatError(new Error(BUSY_LINE))).toBe(BUSY_LINE);
    expect(describeChatError(new Error(`${PROBLEM_LINE} extra`))).toBe(GENERIC_ERROR);
    expect(describeChatError(new Error(BUSY_LINE.slice(0, 10)))).toBe(GENERIC_ERROR);
  });
});
