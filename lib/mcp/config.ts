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

/**
 * Set once mcpAudience() has warned about a misconfigured MCP_AUDIENCE, so
 * it logs at most once per process rather than on every call — layout.tsx
 * now calls mcpAudience() on every authenticated page load, and a bad value
 * would otherwise warn on every single request.
 */
let warnedAudience = false;

/** Who may use MCP: admins only (default, beta) or every active account. */
export function mcpAudience(): McpAudience {
  const raw = env.MCP_AUDIENCE;
  if (raw === undefined || raw === 'admin') return 'admin';
  if (raw === 'all') return 'all';
  if (!warnedAudience) {
    warnedAudience = true;
    console.warn(`[mcp config] MCP_AUDIENCE=${JSON.stringify(raw)} is not "admin" or "all" — treating it as admin`);
  }
  return 'admin';
}

/** Test-only: clears the per-process "already warned" flags so a test can observe a warning fire again. */
export function resetMcpConfigWarningsForTests(): void {
  warnedAudience = false;
}

/** Clerk OAuth client ids allowed to present tokens; empty = any client of our instance. */
export function mcpAllowedClientIds(): string[] {
  return (env.MCP_ALLOWED_CLIENT_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

/** The two Clerk OAuth client ids we've pinned so far; ids are public OAuth identifiers, not secrets. */
const CLAUDE_CLIENT_ID = '16oat62Xksi7U2Ri';
const CHATGPT_CLIENT_ID = 'WzrKBzjxqjhn2pUR';

const CLIENT_LABELS: Record<string, string> = {
  [CLAUDE_CLIENT_ID]: 'Claude',
  [CHATGPT_CLIENT_ID]: 'ChatGPT',
};

export interface McpClientCredentials {
  label: 'Claude' | 'ChatGPT';
  clientId: string;
  /** null when the env var is unset or blank; the page then says to ask for it. */
  clientSecret: string | null;
}

/**
 * The OAuth client credentials the Connect AI page shows to signed-in,
 * eligible accounts. Each pair identifies the client APPLICATION (claude.ai,
 * ChatGPT), not the user: every member pastes the same pair into their client
 * and then signs in as themselves, so the token is theirs and the account is
 * the real gate. Showing the pairs to members is a deliberate owner decision
 * (2026-09-24) that removes the "ask us for the secret" step. The secrets
 * come from env so they can be rotated in Clerk + Vercel without a code
 * change; an unset secret falls back to the ask-us line for that client.
 */
export function mcpClientCredentials(): McpClientCredentials[] {
  const secret = (v: string | undefined) => (v && v.trim().length > 0 ? v.trim() : null);
  return [
    { label: 'Claude', clientId: CLAUDE_CLIENT_ID, clientSecret: secret(env.MCP_CLIENT_SECRET_CLAUDE) },
    { label: 'ChatGPT', clientId: CHATGPT_CLIENT_ID, clientSecret: secret(env.MCP_CLIENT_SECRET_CHATGPT) },
  ];
}

/** Human-readable name for a client id shown on the Connect AI page; falls back to the raw id, or "unknown client" for null. */
export function mcpClientLabel(clientId: string | null): string {
  if (clientId === null) return 'unknown client';
  return CLIENT_LABELS[clientId] ?? clientId;
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
