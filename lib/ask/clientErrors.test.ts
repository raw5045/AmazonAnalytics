import { describe, it, expect } from 'vitest';
import { APICallError } from 'ai';
import { describeChatError, GENERIC_ERROR } from './clientErrors';
import { BUSY_LINE, CHAT_GONE_MESSAGE, PROBLEM_LINE } from './messages';

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
  it('a bodyless 404 gets CHAT_GONE_MESSAGE, not the generic sentence (Minor 9) — its copy stays neutral (nit 3, final re-review) since a follow-up chat deleted elsewhere is only one of several routes to a bodyless 404', () => {
    // Mirrors what the AI SDK transport actually throws for an empty response body:
    // createUIApiCallError fills in its own fallback text and sets statusCode from the response.
    const err = new APICallError({
      message: 'Failed to fetch the chat response.', url: '/api/ask/chat', requestBodyValues: {}, statusCode: 404, responseBody: '',
    });
    expect(describeChatError(err)).toBe(CHAT_GONE_MESSAGE);
  });
  it('a 404 that DOES carry a JSON { error } body still wins over the bodyless-404 special case', () => {
    const err = new APICallError({
      message: JSON.stringify({ error: 'Not found for another reason.', code: 'not_eligible' }), url: '/api/ask/chat', requestBodyValues: {}, statusCode: 404,
    });
    expect(describeChatError(err)).toBe('Not found for another reason.');
  });
  it('a non-404 APICallError status is not special-cased and falls back to the generic sentence', () => {
    const err = new APICallError({ message: 'Internal Server Error', url: '/api/ask/chat', requestBodyValues: {}, statusCode: 500 });
    expect(describeChatError(err)).toBe(GENERIC_ERROR);
  });
});
