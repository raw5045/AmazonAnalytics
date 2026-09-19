import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const envMock = vi.hoisted(() => ({ env: {} as Record<string, string | undefined> }));
vi.mock('@/lib/env', () => envMock);

import {
  authorizationServerMetadataResponse,
  metadataOptionsResponse,
  protectedResourceMetadata,
  protectedResourceResponse,
} from './discovery';

const PK = `pk_live_${Buffer.from('clerk.keywordquarry.com$').toString('base64')}`;

describe('protected resource metadata (RFC 9728)', () => {
  beforeEach(() => {
    envMock.env = { APP_PUBLIC_URL: 'https://keywordquarry.com', NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: PK };
  });

  it('names our endpoint, the Clerk issuer, the research scope and header-only bearer tokens', () => {
    expect(protectedResourceMetadata()).toEqual({
      resource: 'https://keywordquarry.com/api/mcp',
      authorization_servers: ['https://clerk.keywordquarry.com'],
      scopes_supported: ['keywordquarry:research:read'],
      bearer_methods_supported: ['header'],
      resource_name: 'KeywordQuarry',
    });
  });

  it('serves it as cacheable public JSON with CORS, built from configuration alone (no request involved)', async () => {
    const res = protectedResourceResponse();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('cache-control')).toContain('max-age');
    expect((await res.json()).resource).toBe('https://keywordquarry.com/api/mcp');
  });

  it('answers CORS preflight for browser-based clients', () => {
    const res = metadataOptionsResponse();
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toContain('GET');
  });
});

describe('authorization server metadata proxy (RFC 8414)', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    envMock.env = { APP_PUBLIC_URL: 'https://keywordquarry.com', NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: PK };
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("fetches Clerk's document and passes the body through unchanged with CORS and a short cache", async () => {
    const doc = { issuer: 'https://clerk.keywordquarry.com', authorization_endpoint: 'https://clerk.keywordquarry.com/oauth/authorize' };
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(doc), { status: 200, headers: { 'content-type': 'application/json' } }));
    const res = await authorizationServerMetadataResponse();
    expect(fetchMock.mock.calls[0][0]).toBe('https://clerk.keywordquarry.com/.well-known/oauth-authorization-server');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('cache-control')).toContain('max-age=300');
    expect(await res.json()).toEqual(doc);
  });

  it('reports an upstream failure as 502 instead of inventing a document', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 500 }));
    const res = await authorizationServerMetadataResponse();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'authorization_server_unavailable' });
  });

  it('reports a network error as 502 as well', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    const res = await authorizationServerMetadataResponse();
    expect(res.status).toBe(502);
  });
});
