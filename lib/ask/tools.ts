import { tool, type ToolSet } from 'ai';
import { RESEARCH_TOOLS } from '@/lib/research/tools';
import { classifyToolError } from '@/lib/research/toolErrors';
import { researchLimits, type ResearchLimits } from '@/lib/research/limits';
import type { ResearchActor, ResearchService } from '@/lib/research/service';

/**
 * Spec §4: the chat's tools are the shared definitions, bound to one actor. A ResearchError comes
 * back as `{ error }` in the tool RESULT (not a throw) — the same `{ error }` payload the MCP
 * adapter returns (which additionally flags isError) — so the model explains or narrows within
 * the loop bound; anything else becomes the safe sentence.
 */
export function buildAskTools(service: ResearchService, actor: ResearchActor, limits: ResearchLimits = researchLimits()): ToolSet {
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
  return out;
}
