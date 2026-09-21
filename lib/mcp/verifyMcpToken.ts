import { auth } from '@clerk/nextjs/server';
import { eq } from 'drizzle-orm';
import type { AuthInfo } from '@modelcontextprotocol/server';
import { db } from '@/db/client';
import { users } from '@/db/schema';
import { MCP_SCOPE, type McpAudience } from './config';

/**
 * The auth seam every MCP tool sits behind
 * (docs/superpowers/specs/2026-09-19-mcp-spike-design.md §2), in two layers:
 *
 * 1. `verifyMcpToken` — token facts only. Plugged into mcp-handler's
 *    `withMcpAuth`, which turns `undefined` into a `401` challenge and a
 *    token without MCP_SCOPE into `403 insufficient_scope`. Clerk is the
 *    authorization server: `auth({ acceptsToken: 'oauth_token' })` returns
 *    the machine-token object the middleware already verified and stashed on
 *    the request, and never throws for a bad token. Nothing here touches the
 *    database on purpose: the wrapper answers any throw with `401
 *    invalid_token`, which would make a client discard a perfectly good
 *    token and re-run OAuth over a transient Neon hiccup.
 * 2. The gate (`lib/mcp/handler.ts`) — policy on top of a valid token:
 *    `authorizeMcpClient` (MCP_ALLOWED_CLIENT_IDS), `resolveMcpAccount`
 *    (the users row; a failure there is a `503`, not a `401`),
 *    `authorizeMcpAccount` (a KeywordQuarry account exists; MCP_AUDIENCE) and
 *    `getMcpConnection` (lib/mcp/connections.ts; `disconnected` → 403
 *    `disconnected`, lookup failure → 503).
 *
 * Audience binding = our issuer (Clerk verifies), our custom scope (the
 * wrapper's `requiredScopes`) and, once pinned, our own OAuth client ids.
 */

/** A KeywordQuarry account, as attached to the request by the gate. */
export interface McpAccount {
  localUserId: string;
  role: 'admin' | 'standard_user';
  email: string;
}

/** `AuthInfo.extra` as this module writes it: `account` is null until the gate resolves it. */
export interface McpAuthExtra {
  clerkUserId: string;
  account: McpAccount | null;
}

export type McpAccessDenial = {
  reason: 'client_not_allowed' | 'no_account' | 'admin_only' | 'disconnected';
  /** Plain words a client can show the person. */
  message: string;
};

export async function verifyMcpToken(_req: Request, bearerToken?: string): Promise<AuthInfo | undefined> {
  if (!bearerToken) {
    logAuth({ outcome: 'no_token' });
    return undefined;
  }

  const a = await auth({ acceptsToken: 'oauth_token' });
  if (!a.isAuthenticated || a.tokenType !== 'oauth_token') {
    logAuth({ outcome: 'token_rejected', tokenType: a.tokenType });
    return undefined;
  }

  const base: AuthInfo = { token: bearerToken, clientId: a.clientId, scopes: a.scopes };
  if (!a.scopes.includes(MCP_SCOPE)) {
    // The wrapper answers 403 insufficient_scope with a scope= challenge.
    logAuth({ outcome: 'missing_scope', clientId: a.clientId, clerkUserId: a.userId, scopes: a.scopes });
    return base;
  }

  logAuth({ outcome: 'ok', clientId: a.clientId, clerkUserId: a.userId });
  const extra: McpAuthExtra = { clerkUserId: a.userId, account: null };
  return { ...base, extra: { ...extra } };
}

/** The users row for a Clerk user, or null when the login never reached the app. Throws on a database failure. */
export async function resolveMcpAccount(clerkUserId: string): Promise<McpAccount | null> {
  const user = await db.query.users.findFirst({ where: eq(users.clerkUserId, clerkUserId) });
  return user ? { localUserId: user.id, role: user.role, email: user.email } : null;
}

/** Reads the block back off an AuthInfo; null when absent or not ours. */
export function mcpAuthExtra(authInfo: AuthInfo | undefined): McpAuthExtra | null {
  const e = authInfo?.extra;
  if (!e || typeof e.clerkUserId !== 'string') return null;
  return { clerkUserId: e.clerkUserId, account: readAccount(e.account) };
}

function readAccount(value: unknown): McpAccount | null {
  if (!value || typeof value !== 'object') return null;
  const a = value as Record<string, unknown>;
  if (typeof a.localUserId !== 'string' || typeof a.email !== 'string') return null;
  if (a.role !== 'admin' && a.role !== 'standard_user') return null;
  return { localUserId: a.localUserId, role: a.role, email: a.email };
}

/** Once the owner pins MCP_ALLOWED_CLIENT_IDS, only those OAuth clients may present tokens. */
export function authorizeMcpClient(clientId: string, allowedClientIds: string[]): McpAccessDenial | null {
  if (allowedClientIds.length === 0 || allowedClientIds.includes(clientId)) return null;
  return {
    reason: 'client_not_allowed',
    message: 'This OAuth client is not allowed to use KeywordQuarry MCP.',
  };
}

/**
 * The beta gate: the login must have a KeywordQuarry account, and while
 * MCP_AUDIENCE is `admin` that account must be an admin.
 */
export function authorizeMcpAccount(account: McpAccount | null, audience: McpAudience): McpAccessDenial | null {
  if (!account) {
    return {
      reason: 'no_account',
      message: 'This login has no KeywordQuarry account yet. Sign in at keywordquarry.com first, then reconnect.',
    };
  }
  if (audience === 'admin' && account.role !== 'admin') {
    return {
      reason: 'admin_only',
      message: 'KeywordQuarry MCP access is limited to admin accounts during the beta.',
    };
  }
  return null;
}

/** One structured line per verification; ids only, never the token. */
export function logAuth(fields: Record<string, unknown>): void {
  console.log('[mcp auth]', JSON.stringify(fields));
}
