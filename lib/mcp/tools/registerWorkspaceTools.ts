import type { McpServer, ServerContext } from '@modelcontextprotocol/server';
import { researchLimits, type ResearchLimits } from '@/lib/research/limits';
import type { ResearchActor } from '@/lib/research/service';
import type { WorkspaceService } from '@/lib/workspace/contracts';
import { WORKSPACE_TOOLS } from '@/lib/workspace/tools';
import { registerDefinitions } from './registerDefinitions';
import { actorFromContext } from './toolResult';

export interface RegisterWorkspaceToolsOptions {
  actorFor?: (ctx: ServerContext) => ResearchActor;
  limits?: ResearchLimits;
}

/**
 * Registers the eleven workspace tools (lib/workspace/tools.ts) on `server` through the same
 * adapter as the research tools. lib/mcp/handler.ts calls this only while MCP_WRITE_ENABLED is
 * "1" (spec 2026-09-30 §2); Ask AI never does.
 */
export function registerWorkspaceTools(server: McpServer, service: WorkspaceService, opts: RegisterWorkspaceToolsOptions = {}): void {
  registerDefinitions(server, WORKSPACE_TOOLS, service, opts.actorFor ?? actorFromContext, opts.limits ?? researchLimits());
}
