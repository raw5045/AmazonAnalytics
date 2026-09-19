import { env } from '@/lib/env';

/**
 * MCP (Model Context Protocol) configuration for the external AI-client
 * endpoint at /api/mcp. Everything here is read from the environment, so
 * the owner can flip the switches in Vercel without a code change. See
 * docs/superpowers/specs/2026-09-19-mcp-spike-design.md §4.
 *
 * Bad values never throw at boot (the app must keep serving the browser
 * product even if an MCP switch is mistyped): they fall back to the safe
 * default and log a warning.
 */

/** The custom OAuth scope our Clerk authorization server issues for research access. */
export const MCP_SCOPE = 'keywordquarry:research:read';

/** Name and version reported to MCP clients during initialization. */
export const MCP_SERVER_INFO = { name: 'keywordquarry', version: '0.1.0' } as const;

export type McpAudience = 'admin' | 'all';

/** The endpoint serves requests only when MCP_ENABLED is exactly "1". */
export function mcpEnabled(): boolean {
  return env.MCP_ENABLED === '1';
}

/** Who may use MCP: admins only (default, beta) or every active account. */
export function mcpAudience(): McpAudience {
  const raw = env.MCP_AUDIENCE;
  if (raw === undefined || raw === 'admin') return 'admin';
  if (raw === 'all') return 'all';
  console.warn(`[mcp config] MCP_AUDIENCE=${JSON.stringify(raw)} is not "admin" or "all" — treating it as admin`);
  return 'admin';
}

/** Clerk OAuth client ids allowed to present tokens; empty = any client of our instance. */
export function mcpAllowedClientIds(): string[] {
  return (env.MCP_ALLOWED_CLIENT_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

/**
 * The canonical resource identifier (RFC 9728 `resource`) of the MCP
 * endpoint. Derived from configuration, never from a request's Host
 * header, so a spoofed header cannot redirect discovery. An override must
 * keep the `/api/mcp` path (only the origin may differ): the discovery
 * documents are served at that path alone.
 */
export function mcpResourceUrl(): string {
  const override = env.MCP_RESOURCE_URL;
  if (override) {
    if (isResourceOverride(override)) return override;
    console.warn(
      `[mcp config] MCP_RESOURCE_URL=${JSON.stringify(override)} must be an absolute http(s) URL with the path ${MCP_RESOURCE_PATH} and nothing after it — using the default`,
    );
  }
  return new URL(MCP_RESOURCE_PATH, env.APP_PUBLIC_URL).toString();
}

/** Where the endpoint and its discovery documents are mounted; an override may only change the origin. */
const MCP_RESOURCE_PATH = '/api/mcp';

/**
 * The Clerk frontend-API origin, which is also the OAuth issuer
 * (`https://clerk.keywordquarry.com` in production). Clerk publishable keys
 * are `pk_<live|test>_` + base64 of the frontend-API host followed by `$`,
 * so no extra environment variable is needed.
 */
export function clerkFrontendApiUrl(): string {
  const key = env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? '';
  const match = /^pk_(?:live|test)_([A-Za-z0-9+/=]+)$/.exec(key);
  const host = match ? Buffer.from(match[1], 'base64').toString('utf8').replace(/\$$/, '') : '';
  if (!/^[A-Za-z0-9.-]+$/.test(host)) {
    throw new Error('Clerk publishable key (NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) does not decode to a frontend-API host');
  }
  return `https://${host}`;
}

function isResourceOverride(value: string): boolean {
  try {
    const url = new URL(value);
    const http = url.protocol === 'https:' || url.protocol === 'http:';
    return http && url.pathname === MCP_RESOURCE_PATH && url.search === '' && url.hash === '';
  } catch {
    return false;
  }
}
