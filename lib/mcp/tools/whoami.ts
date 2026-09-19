import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { MCP_SERVER_INFO } from '../config';
import { currentDatasetWeek } from '../datasetWeek';
import { mcpAuthExtra } from '../verifyMcpToken';

/**
 * `whoami` — the spike's single diagnostic tool. Proves the whole path from
 * an external client: OAuth token → verifier → account → a database read
 * (the current dataset week) → structured output.
 */
const outputSchema = z.object({
  ok: z.literal(true),
  account: z.string().describe('Masked email of the KeywordQuarry account this connection is signed in as'),
  datasetWeek: z.string().nullable().describe('Week-end date (YYYY-MM-DD) of the current keyword snapshot'),
  serverVersion: z.string(),
});

export function registerWhoami(server: McpServer): void {
  server.registerTool(
    'whoami',
    {
      title: 'Who am I',
      description: 'Diagnostic: confirms the KeywordQuarry connection works and which account it is signed in as.',
      inputSchema: z.object({}),
      outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (_args, ctx) => {
      const account = maskEmail(mcpAuthExtra(ctx.http?.authInfo)?.account?.email ?? null);
      const datasetWeek = await currentDatasetWeek();
      const structuredContent = { ok: true as const, account, datasetWeek, serverVersion: MCP_SERVER_INFO.version };
      return {
        content: [
          {
            type: 'text' as const,
            text: `Connected to KeywordQuarry as ${account}. Current dataset week: ${datasetWeek ?? 'unknown'}.`,
          },
        ],
        structuredContent,
      };
    },
  );
}

/** `owner@example.com` → `o***@example.com`; enough to recognise, not enough to harvest. */
export function maskEmail(email: string | null): string {
  if (!email) return 'unknown';
  const at = email.indexOf('@');
  if (at < 1) return '***';
  return `${email[0]}***${email.slice(at)}`;
}
