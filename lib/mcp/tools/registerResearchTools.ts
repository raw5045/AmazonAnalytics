import type { McpServer } from '@modelcontextprotocol/server';
import { researchLimits } from '@/lib/research/limits';
import type { ResearchService } from '@/lib/research/service';
import { RESEARCH_TOOLS } from '@/lib/research/tools';
import { registerDefinitions, type RegisterToolsOptions } from './registerDefinitions';
import { actorFromContext } from './toolResult';

/**
 * Registers the MCP research tools on `server` from the shared definitions in lib/research/tools.ts
 * (spec 2026-09-28 §4: the in-app chat builds from the same list), through the adapter in
 * ./registerDefinitions.ts: all seven for every account, the two products tools included (spec
 * 2026-10-23 §3; the server is still built per request, inside the gate's listing context, so an
 * `adminOnly` definition would be listed to an admin request only). Two distinct shapes reach a
 * client on failure, never a bare 200 with prose only: a schema-invalid call never reaches the
 * callback at all — the SDK itself answers with an MCP tool error whose text is its own prose
 * (`Input validation error: …`);
 * everything past that point (a filter the schema itself cannot express, a service failure) is an
 * MCP tool error whose text is the JSON `{ error: ResearchErrorInfo }`.
 */
export function registerResearchTools(server: McpServer, service: ResearchService, opts: RegisterToolsOptions = {}): void {
  registerDefinitions(server, RESEARCH_TOOLS, service, opts.actorFor ?? actorFromContext, opts.limits ?? researchLimits());
}
