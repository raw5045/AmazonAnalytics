import type { McpServer } from '@modelcontextprotocol/server';
import { researchLimits } from '@/lib/research/limits';
import type { ResearchService } from '@/lib/research/service';
import { RESEARCH_TOOLS } from '@/lib/research/tools';
import { registerDefinitions, type RegisterToolsOptions } from './registerDefinitions';
import { actorFromContext } from './toolResult';

/**
 * Registers the seven MCP research tools on `server` from the shared definitions in
 * lib/research/tools.ts (spec 2026-09-28 §4: the in-app chat builds from the same list), through
 * the adapter in ./registerDefinitions.ts. The server is built once per process, not per account,
 * so the two admin-only products tools (spec 2026-10-09 §9) are listed to every account and the
 * service refuses a non-admin call with FORBIDDEN. Two distinct shapes reach a client on failure, never
 * a bare 200 with prose only: a schema-invalid call never reaches the callback at all — the SDK
 * itself answers with an MCP tool error whose text is its own prose (`Input validation error: …`);
 * everything past that point (a filter the schema itself cannot express, a service failure) is an
 * MCP tool error whose text is the JSON `{ error: ResearchErrorInfo }`.
 */
export function registerResearchTools(server: McpServer, service: ResearchService, opts: RegisterToolsOptions = {}): void {
  registerDefinitions(server, RESEARCH_TOOLS, service, opts.actorFor ?? actorFromContext, opts.limits ?? researchLimits());
}
