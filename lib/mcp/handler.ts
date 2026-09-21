import { createMcpHandler, withMcpAuth } from 'mcp-handler';
import type { AuthInfo } from '@modelcontextprotocol/server';
import { MCP_SCOPE, MCP_SERVER_INFO, mcpAllowedClientIds, mcpAudience, mcpResourceUrl } from './config';
import { getMcpConnection, touchMcpConnection, type McpConnectionState } from './connections';
import { registerWhoami } from './tools/whoami';
import {
  authorizeMcpAccount,
  authorizeMcpClient,
  logAuth,
  mcpAuthExtra,
  resolveMcpAccount,
  verifyMcpToken,
  type McpAccessDenial,
  type McpAuthExtra,
} from './verifyMcpToken';

/**
 * The composed MCP request handler behind /api/mcp:
 *
 *   withMcpAuth(verifyMcpToken) → gate → MCP server (tools)
 *
 * `withMcpAuth` turns a missing/invalid token into a 401 challenge that
 * points at our protected-resource metadata, and a token without MCP_SCOPE
 * into a 403 insufficient_scope. The gate then applies policy to the valid
 * token — client allowlist, account lookup, beta audience, and the
 * app-level connection record (amendment §3.4: a disconnected account is
 * refused until it reconnects from /connect-ai) — and answers a plain 403
 * (or a 503 when a lookup itself fails) so a client never discards a good
 * token. Only then does the MCP server see the request, with the account
 * on `ctx.http.authInfo.extra`. An admitted request also stamps a
 * fire-and-forget last-seen touch for the Connect AI page.
 */
const PROTECTED_RESOURCE_METADATA_PREFIX = '/.well-known/oauth-protected-resource';

const mcp = createMcpHandler(
  (server) => {
    registerWhoami(server);
  },
  {
    serverInfo: MCP_SERVER_INFO,
    instructions: 'KeywordQuarry beta: this spike exposes a single diagnostic tool, whoami.',
  },
);

async function gated(req: Request): Promise<Response> {
  const authInfo = req.auth;
  const extra = mcpAuthExtra(authInfo);
  if (!authInfo || !extra) {
    // Unreachable behind withMcpAuth({ required: true }): an invariant
    // break, not something the caller can fix, so say so and fail closed.
    console.error('[mcp auth]', JSON.stringify({ outcome: 'auth_state_missing' }));
    return Response.json({ error: 'server_error', error_description: 'Authentication state missing.' }, { status: 500 });
  }
  const ids = { clientId: authInfo.clientId, clerkUserId: extra.clerkUserId };

  const clientDenial = authorizeMcpClient(authInfo.clientId, mcpAllowedClientIds());
  if (clientDenial) return accessDenied(clientDenial, ids);

  let account: McpAuthExtra['account'];
  try {
    account = await resolveMcpAccount(extra.clerkUserId);
  } catch (e) {
    console.error('[mcp auth]', JSON.stringify({ outcome: 'account_lookup_failed', ...ids, error: e instanceof Error ? e.message : String(e) }));
    return unavailable();
  }

  const accountDenial = authorizeMcpAccount(account, mcpAudience());
  if (accountDenial) return accessDenied(accountDenial, ids);

  let connection: McpConnectionState | null;
  try {
    connection = await getMcpConnection(account!.localUserId);
  } catch (e) {
    console.error('[mcp auth]', JSON.stringify({ outcome: 'connection_lookup_failed', ...ids, error: e instanceof Error ? e.message : String(e) }));
    return unavailable();
  }
  if (connection?.status === 'disconnected') {
    return accessDenied(
      {
        reason: 'disconnected',
        message: `MCP access for this account is disconnected. Reconnect from ${new URL(mcpResourceUrl()).origin}/connect-ai, then try again.`,
      },
      ids,
    );
  }
  touchMcpConnection(account!.localUserId, authInfo.clientId);

  logAuth({ outcome: 'admitted', ...ids, localUserId: account!.localUserId, role: account!.role });
  const enriched: AuthInfo = { ...authInfo, extra: { clerkUserId: extra.clerkUserId, account } };
  req.auth = enriched;
  return mcp(req);
}

/**
 * A plain 403 without a WWW-Authenticate challenge: the token is valid, the
 * caller simply is not entitled, so the client must not loop through
 * re-authorization. The body explains why in words a client can show.
 */
function accessDenied(denial: McpAccessDenial, ids: Record<string, unknown>): Response {
  logAuth({ outcome: 'denied', reason: denial.reason, ...ids });
  return Response.json(
    { error: 'access_denied', reason: denial.reason, error_description: denial.message },
    { status: 403 },
  );
}

/**
 * A transient-failure response for either database lookup in `gated`
 * (account or connection): 503, not 401/403, so a client keeps its good
 * token and retries instead of re-running OAuth or giving up.
 */
function unavailable(): Response {
  return Response.json(
    { error: 'temporarily_unavailable', error_description: 'KeywordQuarry could not check your account just now. Please try again in a minute.' },
    { status: 503, headers: { 'retry-after': '30' } },
  );
}

const resource = new URL(mcpResourceUrl());

export const mcpRequestHandler: (req: Request) => Promise<Response> = withMcpAuth(gated, verifyMcpToken, {
  required: true,
  requiredScopes: [MCP_SCOPE],
  // The challenge's resource_metadata URL = this origin + this path, both from
  // configuration (never the request's forwarded headers), and path-aware per
  // RFC 9728 so it tracks MCP_RESOURCE_URL.
  resourceMetadataPath: PROTECTED_RESOURCE_METADATA_PREFIX + resource.pathname,
  resourceUrl: resource.origin,
});
