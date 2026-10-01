import { errFields } from '@/lib/ask/logSafe';
import { isResearchError, type ResearchErrorInfo } from './errors';

/** The only sentence a caller ever sees for a non-ResearchError failure (never `e.message`, which can carry SQL or a connection string). */
export const SAFE_TOOL_FAILURE: Readonly<ResearchErrorInfo> = Object.freeze({
  code: 'DATA_UNAVAILABLE',
  message: 'KeywordQuarry hit an unexpected problem; try again in a minute.',
  retryable: true,
});

/**
 * Shared by the MCP adapter (lib/mcp/tools/toolResult.ts) and the chat adapter
 * (lib/ask/tools.ts): a ResearchError is already safe and passes through as its info; anything
 * else is logged (`logPrefix`, then a JSON line with the tool and the log-safe fields from
 * lib/ask/logSafe.ts — error name, SQLSTATE and a capped detail read off a DrizzleQueryError's
 * `.cause`, never its own message, which embeds the bound params — then only the `    at …`
 * frames of the stack on a second line, since a stack's leading lines repeat that message) and
 * replaced by SAFE_TOOL_FAILURE.
 */
export function classifyToolError(e: unknown, tool: string, logPrefix: string): ResearchErrorInfo {
  if (isResearchError(e)) return e.toInfo();
  // A primitive throw (`throw 'boom'`) has no fields of its own; keep its value as the detail so
  // it still reaches the log.
  const detail = e instanceof Object ? {} : { detail: String(e).slice(0, 200) };
  console.error(logPrefix, JSON.stringify({ tool, ...errFields(e), ...detail }));
  const stack = (e as { stack?: unknown })?.stack;
  if (typeof stack === 'string') {
    const frames = stack.split('\n').filter((line) => /^\s+at /.test(line));
    if (frames.length > 0) console.error(frames.join('\n'));
  }
  // Always a fresh copy, never the frozen SAFE_TOOL_FAILURE singleton itself, so a caller that
  // mutates its result cannot corrupt the shared constant for every other caller.
  return { ...SAFE_TOOL_FAILURE };
}
