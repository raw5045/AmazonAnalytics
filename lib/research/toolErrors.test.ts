import { describe, it, expect, vi, afterEach } from 'vitest';
import { ResearchError } from './errors';
import { classifyToolError, SAFE_TOOL_FAILURE } from './toolErrors';

describe('classifyToolError', () => {
  afterEach(() => vi.restoreAllMocks());
  it('passes a ResearchError through as its info, without logging', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const info = classifyToolError(new ResearchError('RATE_LIMITED', 'slow down', { retryable: true, retryAfterSeconds: 7 }), 'search_keywords', '[test]');
    expect(info).toEqual({ code: 'RATE_LIMITED', message: 'slow down', retryable: true, retryAfterSeconds: 7 });
    expect(error).not.toHaveBeenCalled();
  });
  it('maps anything else to the fixed safe sentence and logs the tool, name, message and code — never echoing the message to the caller', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const e = Object.assign(new Error('connection string postgres://secret'), { code: '08006' });
    const info = classifyToolError(e, 'get_keyword_details', '[test]');
    expect(info).toEqual(SAFE_TOOL_FAILURE);
    expect(info.message).not.toContain('postgres://');
    expect(error.mock.calls[0][0]).toBe('[test]');
    expect(JSON.parse(error.mock.calls[0][1] as string)).toMatchObject({ tool: 'get_keyword_details', name: 'Error', message: 'connection string postgres://secret', code: '08006' });
  });
  it('captures a primitive throw via String()', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    classifyToolError('boom', 'get_research_guide', '[test]');
    expect(JSON.parse(error.mock.calls[0][1] as string)).toMatchObject({ tool: 'get_research_guide', message: 'boom' });
  });
});
