// lib/mcp/listingContext.ts
import { AsyncLocalStorage } from 'node:async_hooks';

/** Whom the current MCP request's tool list is for: the gate's account, decided before the server is built. */
export interface McpListing {
  isAdmin: boolean;
}

/**
 * Spec 2026-10-09 §9: the admin-only tools are listed to admins only. mcp-handler (2.2.0, over the
 * SDK's stateless mode) builds a fresh server for every request, so the gate in ./handler.ts runs
 * the handler inside `listing.run({ isAdmin }, …)` and ./tools/registerDefinitions.ts reads the
 * store while it registers. No store (a caller outside the gate) lists no admin-only tool.
 */
export const listing = new AsyncLocalStorage<McpListing>();
