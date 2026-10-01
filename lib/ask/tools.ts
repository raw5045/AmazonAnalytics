import { tool, type ToolSet } from 'ai';
import type { ResearchErrorInfo } from '@/lib/research/errors';
import { RESEARCH_TOOLS } from '@/lib/research/tools';
import { classifyToolError } from '@/lib/research/toolErrors';
import { researchLimits, type ResearchLimits } from '@/lib/research/limits';
import type { ResearchActor, ResearchService } from '@/lib/research/service';
import type { WorkspaceService } from '@/lib/workspace/contracts';
import { WORKSPACE_TOOLS, type WorkspaceToolDefinition } from '@/lib/workspace/tools';
import { writeKind } from './writeKinds';

/** Non-throwing lookup (workspaceToolByName throws on an unknown name; a stored message's tool name is untrusted input here). */
const WORKSPACE_BY_NAME: ReadonlyMap<string, WorkspaceToolDefinition> = new Map(WORKSPACE_TOOLS.map((d) => [d.name, d]));

export interface WriteSettings { allowChanges: boolean; allowDeletes: boolean }

/** Spec 2026-10-01 §6: the streamText `toolApproval` map for this turn — only the tools that must show a card. */
export function toolApprovalFor(writes: WriteSettings | null): Record<string, 'user-approval'> {
  const out: Record<string, 'user-approval'> = {};
  if (!writes) return out;
  for (const def of WORKSPACE_TOOLS) {
    const kind = writeKind(def.name);
    if (kind === 'change' && !writes.allowChanges) out[def.name] = 'user-approval';
    if (kind === 'delete' && !writes.allowDeletes) out[def.name] = 'user-approval';
  }
  return out;
}

/**
 * runWorkspaceTool's refusal: a name that is not a workspace write, or stored input its schema
 * rejects. Typed as ResearchErrorInfo so the code stays one of RESEARCH_ERROR_CODES; a fresh
 * object per call (as classifyToolError returns) so a caller that mutates one cannot corrupt the next.
 */
function invalidInput(): { error: ResearchErrorInfo } {
  return { error: { code: 'INVALID_FILTERS', message: 'The approved action could not be run: its details were invalid.', retryable: false } };
}

/**
 * Runs one workspace write from stored input (the approval resume path, spec §6): the input is
 * re-validated against the tool's own schema first, because it comes from a stored message, not
 * from the SDK's parse. Same result shape as the live execute below. Only writes (never a list
 * tool or a research tool) can be run this way.
 */
export async function runWorkspaceTool(workspace: WorkspaceService, actor: ResearchActor, name: string, input: unknown): Promise<unknown> {
  const def = WORKSPACE_BY_NAME.get(name);
  if (!def || writeKind(name) === null) return invalidInput();
  const parsed = def.inputSchema.safeParse(input);
  if (!parsed.success) return invalidInput();
  try {
    return await def.run(workspace, actor, parsed.data);
  } catch (e) {
    return { error: classifyToolError(e, name, '[ask tool]') };
  }
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
      execute: async (args) => {
        try {
          return await def.run(service, actor, args);
        } catch (e) {
          return { error: classifyToolError(e, def.name, '[ask tool]') };
        }
      },
    });
  }
  if (workspace) {
    for (const def of WORKSPACE_TOOLS) {
      out[def.name] = tool({
        description: def.description(limits),
        inputSchema: def.inputSchema,
        execute: async (args) => {
          try {
            return await def.run(workspace, actor, args);
          } catch (e) {
            return { error: classifyToolError(e, def.name, '[ask tool]') };
          }
        },
      });
    }
  }
  return out;
}
