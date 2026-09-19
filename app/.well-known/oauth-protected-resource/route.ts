/**
 * The same Protected Resource Metadata at the root well-known path, which
 * older MCP clients probe before (or instead of) the path-aware one.
 */
import { metadataOptionsResponse, protectedResourceResponse } from '@/lib/mcp/discovery';

export const runtime = 'nodejs';

export function GET(): Response {
  return protectedResourceResponse();
}

export function OPTIONS(): Response {
  return metadataOptionsResponse();
}
