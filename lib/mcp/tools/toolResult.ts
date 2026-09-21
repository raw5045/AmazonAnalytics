import type { AuthInfo, CallToolResult } from '@modelcontextprotocol/server';
import { isResearchError, ResearchError } from '@/lib/research/errors';
import type { ResearchActor } from '@/lib/research/service';
import { mcpAuthExtra } from '@/lib/mcp/verifyMcpToken';

/** The slice of the SDK's ServerContext the tools read. */
export type ToolContext = { http?: { authInfo?: AuthInfo } };

/** Identity comes from the gate (lib/mcp/handler.ts), never from tool arguments. */
export function actorFromContext(ctx: ToolContext): ResearchActor {
  const info = ctx.http?.authInfo;
  const extra = mcpAuthExtra(info);
  if (!info || !extra || !extra.account) {
    // Unreachable behind the gate; fail closed with a retryable error rather than a crash.
    throw new ResearchError('DATA_UNAVAILABLE', 'No verified KeywordQuarry account is attached to this request.', { retryable: true });
  }
  return { localUserId: extra.account.localUserId, clerkUserId: extra.clerkUserId, clientId: info.clientId, channel: 'mcp' };
}

export function okResult(structured: object): CallToolResult {
  const structuredContent = structured as unknown as Record<string, unknown>;
  return { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent };
}

export function errorResult(e: unknown): CallToolResult {
  if (isResearchError(e)) {
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: e.toInfo() }) }] };
  }
  console.error('[mcp tool]', e instanceof Error ? e.message : String(e));
  const info = { code: 'DATA_UNAVAILABLE', message: 'KeywordQuarry hit an unexpected problem; try again in a minute.', retryable: true };
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: info }) }] };
}

export async function runTool(fn: () => Promise<object>): Promise<CallToolResult> {
  try {
    return okResult(await fn());
  } catch (e) {
    return errorResult(e);
  }
}
