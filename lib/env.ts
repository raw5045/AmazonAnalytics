import { z } from 'zod';

const serverSchema = z.object({
  DATABASE_URL: z.string().url(),
  CLERK_SECRET_KEY: z.string().min(1),
  CLERK_WEBHOOK_SIGNING_SECRET: z.string().min(1),
  R2_ACCOUNT_ID: z.string().min(1),
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
  R2_BUCKET_NAME: z.string().min(1),
  INNGEST_EVENT_KEY: z.string().min(1).optional(),
  INNGEST_SIGNING_KEY: z.string().min(1).optional(),
  INITIAL_ADMIN_EMAIL: z.string().email().optional(),
  RESEND_API_KEY: z.string().min(1).optional(),
  RESEND_FROM: z.string().min(1).optional(),
  /** Resend Segment new members join (and leave on deletion); unset = contact sync off. See lib/notifications/resendContacts.ts */
  RESEND_SEGMENT_ID: z.string().min(1).optional(),
  APP_PUBLIC_URL: z.string().url(),
  // MCP endpoint (/api/mcp) for external AI clients. All optional and dark by
  // default; interpreted (with safe fallbacks) by lib/mcp/config.ts.
  MCP_ENABLED: z.string().optional(),
  MCP_AUDIENCE: z.string().optional(),
  MCP_ALLOWED_CLIENT_IDS: z.string().optional(),
  MCP_RESOURCE_URL: z.string().optional(),
  /** Shown on the Connect AI page to signed-in, eligible accounts (see mcpClientCredentials). */
  MCP_CLIENT_SECRET_CLAUDE: z.string().optional(),
  MCP_CLIENT_SECRET_CHATGPT: z.string().optional(),
  /** Workspace (write) tools on /api/mcp (arc 3, docs/superpowers/specs/2026-09-30-mcp-write-access-design.md §2): "1" registers them. */
  MCP_WRITE_ENABLED: z.string().optional(),
  // Research service (arc 1): cursor signing key and validated limit overrides.
  RESEARCH_CURSOR_SECRET: z.string().optional(),
  RESEARCH_LIMITS_JSON: z.string().optional(),
  // Ask AI (arc 2, docs/superpowers/specs/2026-09-28-in-app-chat-design.md §10). All optional and
  // dark by default; the dials are interpreted with safe fallbacks by lib/ask/config.ts, and
  // ASK_AI_PRICES_JSON by lib/ask/pricing.ts.
  ASK_AI_ENABLED: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  ASK_AI_DAILY_MESSAGE_LIMIT: z.string().optional(),
  ASK_AI_GLOBAL_MONTHLY_CEILING_USD: z.string().optional(),
  ASK_AI_PRICES_JSON: z.string().optional(),
  ASK_AI_DEFAULT_ALLOWANCE_USD: z.string().optional(),
  // Write tools inside the chat (spec 2026-10-01 §2); independent of MCP_WRITE_ENABLED.
  ASK_AI_WRITES_ENABLED: z.string().optional(),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

const clientSchema = z.object({
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().min(1),
  NEXT_PUBLIC_APP_URL: z.string().url(),
});

/**
 * Converts empty-string env values to undefined so that zod's `.optional()`
 * treats unset-but-declared env vars correctly. Without this, a `.env` file
 * line like `INNGEST_EVENT_KEY=` produces `""` which fails `.min(1)`.
 */
function emptyToUndefined(source: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(source)) {
    out[k] = v === '' ? undefined : v;
  }
  return out;
}

type ServerEnv = z.infer<typeof serverSchema> & z.infer<typeof clientSchema>;

function parseEnv(): ServerEnv {
  const source = emptyToUndefined(process.env);
  const isServer = typeof window === 'undefined';
  const client = clientSchema.parse({
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: source.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
    NEXT_PUBLIC_APP_URL: source.NEXT_PUBLIC_APP_URL,
  });
  if (!isServer) {
    // Browser bundle: only NEXT_PUBLIC_* exist at runtime. Cast is safe because
    // server-only fields will be undefined, and client code must not access them.
    return client as ServerEnv;
  }
  const server = serverSchema.parse(source);
  return { ...client, ...server };
}

export const env = parseEnv();
export type Env = ServerEnv;
