/**
 * RFC 9728 Protected Resource Metadata for /api/mcp, at the path-aware
 * well-known URL the endpoint's 401 challenge names. Public JSON; outside
 * clerkMiddleware (the proxy matcher skips dotted paths).
 */
import { metadataOptionsResponse, protectedResourceResponse } from '@/lib/mcp/discovery';

export const runtime = 'nodejs';

export function GET(): Response {
  return protectedResourceResponse();
}

export function OPTIONS(): Response {
  return metadataOptionsResponse();
}
