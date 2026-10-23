/**
 * /api/mcp — the Model Context Protocol endpoint for external AI clients
 * (claude.ai, ChatGPT). Dark unless MCP_ENABLED=1; everything else lives in
 * lib/mcp. See docs/superpowers/specs/2026-09-19-mcp-spike-design.md and,
 * for the research tools it now also serves, docs/superpowers/specs/2026-09-19-mcp-arc1-amendment-design.md.
 *
 * Runs under clerkMiddleware (the proxy matcher covers /api) without
 * auth.protect(), so a missing token yields the MCP 401 challenge, never an
 * HTML sign-in redirect.
 */
import { mcpEnabled } from '@/lib/mcp/config';
import { mcpRequestHandler } from '@/lib/mcp/handler';

export const runtime = 'nodejs';
/**
 * The product tools' reads run under PRODUCT_READ_TIMEOUT_MS (30 s) plus the gate, the reserve and the scope lookups, so a
 * read that hits its cap still answers QUERY_TIMEOUT (and is logged) inside the invocation instead of a 504; the keyword
 * tools budget for 30 s and keep doing so (lib/research/pool.ts). A literal, as Next reads it from the source;
 * routeDeadline.test.ts pins it against PRODUCT_READ_TIMEOUT_MS.
 */
export const maxDuration = 60;

async function serve(req: Request): Promise<Response> {
  if (!mcpEnabled()) return new Response(null, { status: 404 });
  return mcpRequestHandler(req);
}

export { serve as GET, serve as POST };
