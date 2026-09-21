// lib/mcp/tools/toolResult.test.ts
// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';

// toolResult.ts imports verifyMcpToken.ts, which imports @clerk/nextjs/server and @/db/client
// (and, via ./config, @/lib/env). None of those are actually invoked by the cases below (we
// build AuthInfo objects by hand), but the imports execute at module load regardless, so they
// must be stubbed before anything real (env parsing, a live Clerk client) runs. Pattern from
// lib/mcp/verifyMcpToken.test.ts.
vi.mock('@clerk/nextjs/server', () => ({ auth: vi.fn() }));
vi.mock('@/db/client', () => ({ db: {} }));
vi.mock('@/lib/env', () => ({ env: {} }));

import type { AuthInfo } from '@modelcontextprotocol/server';
import { ResearchError } from '@/lib/research/errors';
import { actorFromContext, okResult, errorResult, runTool, type ToolContext } from './toolResult';

const account = { localUserId: 'u1', role: 'admin' as const, email: 'owner@example.com' };

function ctxWith(authInfo?: AuthInfo): ToolContext {
  return { http: authInfo ? { authInfo } : undefined };
}

describe('actorFromContext', () => {
  it('builds a ResearchActor from a verified account on the auth context', () => {
    const authInfo: AuthInfo = { token: 't', clientId: 'client_claude', scopes: [], extra: { clerkUserId: 'user_1', account } };
    expect(actorFromContext(ctxWith(authInfo))).toEqual({
      localUserId: 'u1',
      clerkUserId: 'user_1',
      clientId: 'client_claude',
      channel: 'mcp',
    });
  });

  it('fails closed with a retryable DATA_UNAVAILABLE error when the gate has not attached an account, logging outcome: actor_missing', () => {
    const authInfo: AuthInfo = { token: 't', clientId: 'client_claude', scopes: [], extra: { clerkUserId: 'user_1', account: null } };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      actorFromContext(ctxWith(authInfo));
      expect.unreachable('actorFromContext should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ResearchError);
      expect((e as ResearchError).code).toBe('DATA_UNAVAILABLE');
      expect((e as ResearchError).retryable).toBe(true);
    }
    expect(spy).toHaveBeenCalledWith('[mcp tool]', JSON.stringify({ outcome: 'actor_missing' }));
    spy.mockRestore();
  });

  it('fails closed the same way when authInfo itself is missing from the context, logging the same outcome', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => actorFromContext(ctxWith(undefined))).toThrow(ResearchError);
    expect(spy).toHaveBeenCalledWith('[mcp tool]', JSON.stringify({ outcome: 'actor_missing' }));
    spy.mockRestore();
  });
});

describe('okResult', () => {
  it('wraps a structured object as both JSON text content and structuredContent, with no isError', () => {
    const r = okResult({ a: 1, b: 'two' });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toEqual({ a: 1, b: 'two' });
    expect(r.content).toEqual([{ type: 'text', text: JSON.stringify({ a: 1, b: 'two' }) }]);
  });
});

describe('errorResult', () => {
  it('renders a ResearchError as { error: toInfo() }, including retryAfterSeconds and details when present, without logging', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const e = new ResearchError('RATE_LIMITED', 'Too many requests.', {
      retryable: true,
      retryAfterSeconds: 30,
      details: [{ path: 'rows', message: 'over limit' }],
    });
    const r = errorResult(e, 'search_keywords');
    expect(r.isError).toBe(true);
    expect(JSON.parse((r.content[0] as { text: string }).text)).toEqual({
      error: { code: 'RATE_LIMITED', message: 'Too many requests.', retryable: true, retryAfterSeconds: 30, details: [{ path: 'rows', message: 'over limit' }] },
    });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('maps a plain Error to a generic retryable DATA_UNAVAILABLE, logs tool/name/message/code plus the stack on a second line, and never echoes the real message', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = Object.assign(new Error('super secret db connection string leaked here'), { code: 'ECONNREFUSED' });
    const r = errorResult(err, 'get_keyword_details');
    expect(r.isError).toBe(true);
    const body = JSON.parse((r.content[0] as { text: string }).text) as { error: { code: string; message: string; retryable: boolean } };
    expect(body.error.code).toBe('DATA_UNAVAILABLE');
    expect(body.error.retryable).toBe(true);
    expect(body.error.message).not.toContain('super secret');

    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0][0]).toBe('[mcp tool]');
    expect(JSON.parse(spy.mock.calls[0][1] as string)).toEqual({
      tool: 'get_keyword_details',
      name: 'Error',
      message: 'super secret db connection string leaked here',
      code: 'ECONNREFUSED',
    });
    expect(spy.mock.calls[1]).toEqual([err.stack]);
    spy.mockRestore();
  });

  it('maps a non-Error throw (e.g. a string) the same way, without throwing itself, and logs only the tool (no stack line)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = errorResult('a bare string throw', 'search_keywords');
    expect(r.isError).toBe(true);
    expect(JSON.parse((r.content[0] as { text: string }).text).error.code).toBe('DATA_UNAVAILABLE');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(spy.mock.calls[0][1] as string)).toEqual({ tool: 'search_keywords' });
    spy.mockRestore();
  });
});

describe('runTool', () => {
  it('resolves a successful fn into okResult', async () => {
    const r = await runTool('get_research_guide', async () => ({ x: 1 }));
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toEqual({ x: 1 });
  });

  it('forwards a thrown value and the tool name into errorResult', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await runTool('search_keywords', async () => {
      throw new Error('boom');
    });
    expect(r.isError).toBe(true);
    expect(JSON.parse((spy.mock.calls[0][1] as string))).toMatchObject({ tool: 'search_keywords', message: 'boom' });
    spy.mockRestore();
  });
});
