import { MCP_SCOPE, clerkFrontendApiUrl, mcpResourceUrl } from './config';

/**
 * OAuth discovery documents for the MCP endpoint (spec §3). Both are public
 * and carry no account data:
 *
 * - Protected Resource Metadata (RFC 9728) tells an MCP client which
 *   authorization server issues tokens for /api/mcp and which scope to ask
 *   for. The `resource` value comes from configuration, never the request,
 *   so a spoofed Host header cannot point clients elsewhere.
 * - The authorization-server document (RFC 8414) is Clerk's own, proxied
 *   for 2025-era clients that probe the resource origin instead of following
 *   `authorization_servers`.
 */

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': '*',
  'access-control-max-age': '86400',
} as const;

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: string[];
  resource_name: string;
}

export function protectedResourceMetadata(): ProtectedResourceMetadata {
  return {
    resource: mcpResourceUrl(),
    authorization_servers: [clerkFrontendApiUrl()],
    scopes_supported: [MCP_SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'KeywordQuarry',
  };
}

export function protectedResourceResponse(): Response {
  return Response.json(protectedResourceMetadata(), {
    status: 200,
    headers: { ...CORS_HEADERS, 'cache-control': 'public, max-age=3600' },
  });
}

/** CORS preflight for browser-based MCP clients reading either document. */
export function metadataOptionsResponse(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function authorizationServerMetadataResponse(): Promise<Response> {
  const upstream = `${clerkFrontendApiUrl()}/.well-known/oauth-authorization-server`;
  let body: string;
  try {
    const res = await fetch(upstream, { headers: { accept: 'application/json' }, next: { revalidate: 300 } });
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    body = await res.text();
  } catch (e) {
    console.warn(`[mcp discovery] could not fetch ${upstream}: ${e instanceof Error ? e.message : String(e)}`);
    return Response.json({ error: 'authorization_server_unavailable' }, { status: 502, headers: CORS_HEADERS });
  }
  return new Response(body, {
    status: 200,
    headers: { ...CORS_HEADERS, 'content-type': 'application/json', 'cache-control': 'public, max-age=300' },
  });
}
