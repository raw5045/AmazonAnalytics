import type { McpServer } from '@modelcontextprotocol/server';
import { researchLimits } from '@/lib/research/limits';
import type { WorkspaceService } from '@/lib/workspace/contracts';
import { WORKSPACE_TOOLS } from '@/lib/workspace/tools';
import { registerDefinitions, type RegisterToolsOptions } from './registerDefinitions';
import { actorFromContext } from './toolResult';

/**
 * Registers the eleven workspace tools (lib/workspace/tools.ts) on `server` through the same
 * adapter as the research tools. lib/mcp/handler.ts calls this only while MCP_WRITE_ENABLED is
 * "1" (spec 2026-09-30 §2); the in-app chat binds the same definitions itself (lib/ask/tools.ts,
 * while ASK_AI_WRITES_ENABLED is "1").
 */
export function registerWorkspaceTools(server: McpServer, service: WorkspaceService, opts: RegisterToolsOptions = {}): void {
  registerDefinitions(server, WORKSPACE_TOOLS, service, opts.actorFor ?? actorFromContext, opts.limits ?? researchLimits());
}
