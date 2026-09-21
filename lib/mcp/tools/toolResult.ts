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
    console.error('[mcp tool]', JSON.stringify({ outcome: 'actor_missing' }));
    throw new ResearchError('DATA_UNAVAILABLE', 'No verified KeywordQuarry account is attached to this request.', { retryable: true });
  }
  return { localUserId: extra.account.localUserId, clerkUserId: extra.clerkUserId, clientId: info.clientId, channel: 'mcp' };
}

/**
 * Both a JSON `text` copy of `structured` and `structuredContent` carry the same payload: a
 * client that ignores `structuredContent` (not every MCP client reads it) still gets the result
 * from `content[0].text`. The duplication means the wire payload is ~2x `structured`'s own size
 * against `maxPayloadBytes`, wherever that limit is enforced.
 */
export function okResult(structured: object): CallToolResult {
  const structuredContent = structured as unknown as Record<string, unknown>;
  return { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent };
}

/** `tool` is the MCP tool name (registerResearchTools.ts's runTool caller), logged for a non-ResearchError so an unexpected failure can be traced back to which tool raised it. */
export function errorResult(e: unknown, tool: string): CallToolResult {
  if (isResearchError(e)) {
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: e.toInfo() }) }] };
  }
  console.error(
    '[mcp tool]',
    JSON.stringify({
      tool,
      name: (e as { name?: unknown })?.name,
      message: (e as { message?: unknown })?.message,
      code: (e as { code?: unknown })?.code,
    }),
  );
  const stack = (e as { stack?: unknown })?.stack;
  if (typeof stack === 'string') console.error(stack);
  // The client only ever sees this fixed, safe sentence — never `e`'s own message, which can
  // carry SQL, a connection string, or other internals.
  const info = { code: 'DATA_UNAVAILABLE', message: 'KeywordQuarry hit an unexpected problem; try again in a minute.', retryable: true };
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: info }) }] };
}

export async function runTool(tool: string, fn: () => Promise<object>): Promise<CallToolResult> {
  try {
    return okResult(await fn());
  } catch (e) {
    return errorResult(e, tool);
  }
}
