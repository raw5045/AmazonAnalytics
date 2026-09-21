/**
 * /api/mcp — the Model Context Protocol endpoint for external AI clients
 * (claude.ai, ChatGPT). Dark unless MCP_ENABLED=1; everything else lives in
 * lib/mcp. See docs/superpowers/specs/2026-09-19-mcp-spike-design.md and,
 * for the five research tools it now also serves, docs/superpowers/specs/2026-09-19-mcp-arc1-amendment-design.md.
 *
 * Runs under clerkMiddleware (the proxy matcher covers /api) without
 * auth.protect(), so a missing token yields the MCP 401 challenge, never an
 * HTML sign-in redirect.
 */
import { mcpEnabled } from '@/lib/mcp/config';
import { mcpRequestHandler } from '@/lib/mcp/handler';

export const runtime = 'nodejs';
export const maxDuration = 30;

async function serve(req: Request): Promise<Response> {
  if (!mcpEnabled()) return new Response(null, { status: 404 });
  return mcpRequestHandler(req);
}

export { serve as GET, serve as POST };
