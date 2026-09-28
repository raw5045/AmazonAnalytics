import { isResearchError, type ResearchErrorInfo } from './errors';

/** The only sentence a caller ever sees for a non-ResearchError failure (never `e.message`, which can carry SQL or a connection string). */
export const SAFE_TOOL_FAILURE: Readonly<ResearchErrorInfo> = Object.freeze({
  code: 'DATA_UNAVAILABLE',
  message: 'KeywordQuarry hit an unexpected problem; try again in a minute.',
  retryable: true,
});

/**
 * Shared by the MCP adapter (lib/mcp/tools/toolResult.ts) and the chat adapter
 * (lib/ask/tools.ts, Task 7, not built yet): a ResearchError is already safe and passes through
 * as its info; anything else is logged (`logPrefix`, then a JSON line with the tool, error name,
 * message, code, and the stack on a second line) and replaced by SAFE_TOOL_FAILURE.
 */
export function classifyToolError(e: unknown, tool: string, logPrefix: string): ResearchErrorInfo {
  if (isResearchError(e)) return e.toInfo();
  console.error(
    logPrefix,
    JSON.stringify({
      tool,
      name: (e as { name?: unknown })?.name,
      // A non-Error throw (e.g. `throw 'boom'`) has no `.message`, so
      // `(e as { message?: unknown })?.message` alone would log nothing but `tool` — the thrown
      // value itself would never reach the log. `instanceof Object` still reads the real
      // `.message` off an Error (or any thrown object with one); a primitive throw falls back to
      // String(e) so its value is always captured.
      message: e instanceof Object ? (e as { message?: unknown }).message : String(e),
      code: (e as { code?: unknown })?.code,
    }),
  );
  const stack = (e as { stack?: unknown })?.stack;
  if (typeof stack === 'string') console.error(stack);
  // Always a fresh copy, never the frozen SAFE_TOOL_FAILURE singleton itself, so a caller that
  // mutates its result cannot corrupt the shared constant for every other caller.
  return { ...SAFE_TOOL_FAILURE };
}
