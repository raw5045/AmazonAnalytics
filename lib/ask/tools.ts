import { tool, type ToolSet } from 'ai';
import type { ResearchErrorInfo } from '@/lib/research/errors';
import { RESEARCH_TOOLS } from '@/lib/research/tools';
import { classifyToolError } from '@/lib/research/toolErrors';
import { researchLimits, type ResearchLimits } from '@/lib/research/limits';
import type { ResearchActor, ResearchService } from '@/lib/research/service';
import type { WorkspaceService, WorkspaceToolName } from '@/lib/workspace/contracts';
import { WORKSPACE_TOOLS, type WorkspaceToolDefinition } from '@/lib/workspace/tools';
import { writeKind } from './writeKinds';

/** Non-throwing lookup (workspaceToolByName throws on an unknown name; a stored message's tool name is untrusted input here). */
const WORKSPACE_BY_NAME: ReadonlyMap<string, WorkspaceToolDefinition> = new Map(WORKSPACE_TOOLS.map((d) => [d.name, d]));

export interface WriteSettings { allowChanges: boolean; allowDeletes: boolean }

/**
 * Spec 2026-10-01 §6: the streamText `toolApproval` map for this turn — only the tools that must
 * show a card. Fails closed: a tool that requires confirmation but that writeKinds.ts does not
 * classify yet (a new write) always gets a card, whatever the allowances. `defs` is for tests.
 */
export function toolApprovalFor(
  writes: WriteSettings | null,
  defs: ReadonlyArray<{ readonly name: string; readonly requiresConfirmation: boolean }> = WORKSPACE_TOOLS,
): Record<string, 'user-approval'> {
  const out: Record<string, 'user-approval'> = {};
  if (!writes) return out;
  for (const def of defs) {
    const kind = writeKind(def.name);
    const asks = kind === 'change' ? !writes.allowChanges : kind === 'delete' ? !writes.allowDeletes : def.requiresConfirmation;
    if (asks) out[def.name] = 'user-approval';
  }
  return out;
}

/**
 * A tool's answer, or `{ error }` for any failure — a ResearchError's info, else the safe sentence,
 * logged log-safely by classifyToolError — never a throw. The chat's counterpart of the MCP
 * adapter's runTool (lib/mcp/tools/toolResult.ts).
 */
async function settle<T>(toolName: string, run: () => Promise<T>): Promise<T | { error: ResearchErrorInfo }> {
  try {
    return await run();
  } catch (e) {
    return { error: classifyToolError(e, toolName, '[ask tool]') };
  }
}

/**
 * runWorkspaceTool's refusal: one coded log line (never the input; the tool's name only when it is
 * a known workspace tool) and an `{ error }` result. Typed as ResearchErrorInfo so the code stays
 * one of RESEARCH_ERROR_CODES; a fresh object per call (as classifyToolError returns) so a caller
 * that mutates one cannot corrupt the next.
 */
function refused(toolName: WorkspaceToolName | 'unknown', reason: 'not_a_write' | 'invalid_input'): { error: ResearchErrorInfo } {
  console.warn('[ask tool]', JSON.stringify({ outcome: 'resume_refused', tool: toolName, reason }));
  return { error: { code: 'INVALID_FILTERS', message: 'The approved action could not be run: its details were invalid.', retryable: false } };
}

/**
 * Runs one approved workspace write from its stored input (the approval resume path, spec §6).
 * The stored input is the SDK's parsed output, but it is re-validated against the tool's own
 * schema before it runs: it is read back from storage on a later request (possibly under a newer
 * deploy's schema), this path skips the SDK's own approval re-validation, and every schema's parse
 * is idempotent (lib/workspace/contracts.ts), so re-parsing parsed input is safe. Only writes
 * (never a list tool or a research tool) run this way. Never throws: every failure is an
 * `{ error }` result — a logged refusal, a ResearchError's info or the safe sentence — the same
 * shape as the live tools' results below.
 */
export async function runWorkspaceTool(workspace: WorkspaceService, actor: ResearchActor, name: string, input: unknown): Promise<unknown> {
  const def = WORKSPACE_BY_NAME.get(name);
  if (!def || writeKind(def.name) === null) return refused(def ? def.name : 'unknown', 'not_a_write');
  return settle(def.name, async () => {
    const parsed = def.inputSchema.safeParse(input);
    if (!parsed.success) return refused(def.name, 'invalid_input');
    return def.run(workspace, actor, parsed.data);
  });
}

/**
 * Spec §4 (arc 2): the chat's tools are the shared definitions, bound to one actor. A ResearchError
 * comes back as `{ error }` in the tool RESULT (not a throw) — the same `{ error }` payload the MCP
 * adapter returns (which additionally flags isError) — so the model explains or narrows within the
 * loop bound; anything else becomes the safe sentence. With `workspace` (ASK_AI_WRITES_ENABLED,
 * spec 2026-10-01 §3) the eleven workspace tools follow the five research tools; without it the
 * set is exactly today's.
 */
export function buildAskTools(service: ResearchService, actor: ResearchActor, limits: ResearchLimits = researchLimits(), workspace: WorkspaceService | null = null): ToolSet {
  const out: ToolSet = {};
  for (const def of RESEARCH_TOOLS) {
    out[def.name] = tool({
      description: def.description(limits),
      inputSchema: def.inputSchema,
      execute: (args) => settle(def.name, () => def.run(service, actor, args)),
    });
  }
  if (workspace) {
    for (const def of WORKSPACE_TOOLS) {
      out[def.name] = tool({
        description: def.description(limits),
        inputSchema: def.inputSchema,
        execute: (args) => settle(def.name, () => def.run(workspace, actor, args)),
      });
    }
  }
  return out;
}
