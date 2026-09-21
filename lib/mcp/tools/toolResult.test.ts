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
import { actorFromContext, okResult, errorResult, type ToolContext } from './toolResult';

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

  it('fails closed with a retryable DATA_UNAVAILABLE error when the gate has not attached an account', () => {
    const authInfo: AuthInfo = { token: 't', clientId: 'client_claude', scopes: [], extra: { clerkUserId: 'user_1', account: null } };
    expect(() => actorFromContext(ctxWith(authInfo))).toThrow(ResearchError);
    try {
      actorFromContext(ctxWith(authInfo));
      expect.unreachable('actorFromContext should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ResearchError);
      expect((e as ResearchError).code).toBe('DATA_UNAVAILABLE');
      expect((e as ResearchError).retryable).toBe(true);
    }
  });

  it('fails closed the same way when authInfo itself is missing from the context', () => {
    expect(() => actorFromContext(ctxWith(undefined))).toThrow(ResearchError);
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
  it('renders a ResearchError as { error: toInfo() }, including retryAfterSeconds and details when present', () => {
    const e = new ResearchError('RATE_LIMITED', 'Too many requests.', {
      retryable: true,
      retryAfterSeconds: 30,
      details: [{ path: 'rows', message: 'over limit' }],
    });
    const r = errorResult(e);
    expect(r.isError).toBe(true);
    expect(JSON.parse((r.content[0] as { text: string }).text)).toEqual({
      error: { code: 'RATE_LIMITED', message: 'Too many requests.', retryable: true, retryAfterSeconds: 30, details: [{ path: 'rows', message: 'over limit' }] },
    });
  });

  it('maps a plain Error to a generic retryable DATA_UNAVAILABLE, logs via console.error, and never echoes the real message', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = errorResult(new Error('super secret db connection string leaked here'));
    expect(r.isError).toBe(true);
    const body = JSON.parse((r.content[0] as { text: string }).text) as { error: { code: string; message: string; retryable: boolean } };
    expect(body.error.code).toBe('DATA_UNAVAILABLE');
    expect(body.error.retryable).toBe(true);
    expect(body.error.message).not.toContain('super secret');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('maps a non-Error throw (e.g. a string) the same way, without throwing itself', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = errorResult('a bare string throw');
    expect(r.isError).toBe(true);
    expect(JSON.parse((r.content[0] as { text: string }).text).error.code).toBe('DATA_UNAVAILABLE');
    spy.mockRestore();
  });
});
