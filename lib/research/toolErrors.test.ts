import { describe, it, expect, vi, afterEach } from 'vitest';
import { DrizzleQueryError } from 'drizzle-orm';
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
  it('maps anything else to the fixed safe sentence and logs the tool with the log-safe fields (name, code, capped detail) — never echoing the message to the caller', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const e = Object.assign(new Error('connection string postgres://secret'), { code: '08006' });
    const info = classifyToolError(e, 'get_keyword_details', '[test]');
    expect(info).toEqual(SAFE_TOOL_FAILURE);
    expect(info).not.toBe(SAFE_TOOL_FAILURE);
    expect(Object.isFrozen(SAFE_TOOL_FAILURE)).toBe(true);
    expect(info.message).not.toContain('postgres://');
    expect(error.mock.calls[0][0]).toBe('[test]');
    expect(JSON.parse(error.mock.calls[0][1] as string)).toEqual({ tool: 'get_keyword_details', error: 'Error', code: '08006', detail: 'connection string postgres://secret' });
  });
  it('logs a DrizzleQueryError by its cause and only the stack frames — never the query text or the bound params', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cause = Object.assign(new Error('duplicate key value violates unique constraint "saved_views_user_name_uniq"'), { code: '23505' });
    const e = new DrizzleQueryError('insert into "saved_views" ("user_id", "name") values ($1, $2)', ['u1', 'SECRET-VIEW-NAME'], cause);
    classifyToolError(e, 'create_saved_view', '[test]');
    const logged = error.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
    expect(logged).not.toContain('SECRET-VIEW-NAME');
    expect(logged).not.toContain('insert into');
    expect(JSON.parse(error.mock.calls[0][1] as string)).toEqual({ tool: 'create_saved_view', error: 'Error', code: '23505', detail: 'duplicate key value violates unique constraint "saved_views_user_name_uniq"' });
    expect(error.mock.calls.length).toBeGreaterThan(1); // the frames line
    for (const line of (error.mock.calls[1][0] as string).split('\n')) expect(line).toMatch(/^\s+at /);
  });
  it('keeps a primitive throw as the detail', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    classifyToolError('boom', 'get_research_guide', '[test]');
    expect(JSON.parse(error.mock.calls[0][1] as string)).toEqual({ tool: 'get_research_guide', error: 'string', detail: 'boom' });
  });
});
