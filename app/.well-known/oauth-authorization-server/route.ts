/**
 * RFC 8414 Authorization Server Metadata, proxied from Clerk for MCP clients
 * that probe the resource origin instead of following `authorization_servers`
 * in the protected resource metadata. Public JSON, cached briefly.
 */
import { authorizationServerMetadataResponse, metadataOptionsResponse } from '@/lib/mcp/discovery';

export const runtime = 'nodejs';

export function GET(): Promise<Response> {
  return authorizationServerMetadataResponse();
}

export function OPTIONS(): Response {
  return metadataOptionsResponse();
}
