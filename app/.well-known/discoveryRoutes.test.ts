// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const envMock = vi.hoisted(() => ({
  env: {
    APP_PUBLIC_URL: 'https://keywordquarry.com',
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: `pk_live_${Buffer.from('clerk.keywordquarry.com$').toString('base64')}`,
  } as Record<string, string | undefined>,
}));
vi.mock('@/lib/env', () => envMock);
// These routes sit outside clerkMiddleware (the proxy matcher skips dotted
// paths), so importing Clerk here would break at runtime: make it fail loudly.
vi.mock('@clerk/nextjs/server', () => {
  throw new Error('discovery routes must not import @clerk/nextjs/server');
});

import * as prmAtEndpoint from './oauth-protected-resource/api/mcp/route';
import * as prmAtRoot from './oauth-protected-resource/route';
import * as asMetadata from './oauth-authorization-server/route';

describe('discovery routes', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ['path-aware', prmAtEndpoint],
    ['root', prmAtRoot],
  ])('serves the protected resource metadata at the %s path with CORS preflight', async (_label, mod) => {
    const res = await mod.GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      resource: 'https://keywordquarry.com/api/mcp',
      authorization_servers: ['https://clerk.keywordquarry.com'],
      scopes_supported: ['keywordquarry:research:read'],
    });
    expect(mod.OPTIONS().status).toBe(204);
  });

  it("proxies Clerk's authorization server metadata with CORS preflight", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ issuer: 'https://clerk.keywordquarry.com' }), { status: 200 }));
    const res = await asMetadata.GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ issuer: 'https://clerk.keywordquarry.com' });
    expect(fetchMock.mock.calls[0][0]).toBe('https://clerk.keywordquarry.com/.well-known/oauth-authorization-server');
    expect(asMetadata.OPTIONS().status).toBe(204);
  });

  it('exposes exactly GET, OPTIONS and runtime from each route module', () => {
    for (const mod of [prmAtEndpoint, prmAtRoot, asMetadata]) {
      expect(Object.keys(mod).sort()).toEqual(['GET', 'OPTIONS', 'runtime']);
    }
  });
});
