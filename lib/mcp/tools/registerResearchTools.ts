import { z } from 'zod';
import type { McpServer, ServerContext } from '@modelcontextprotocol/server';
import { researchLimits, type ResearchLimits } from '@/lib/research/limits';
import type { ResearchActor, ResearchService } from '@/lib/research/service';
import { RESEARCH_TOOLS } from '@/lib/research/tools';
import { actorFromContext, runTool } from './toolResult';

const anyObject = z.looseObject({});

export interface RegisterResearchToolsOptions {
  actorFor?: (ctx: ServerContext) => ResearchActor;
  /** Defaults to `researchLimits()` (memoised, env-driven); overridable so tests can pin the numbers the description is built from. */
  limits?: ResearchLimits;
}

/**
 * Registers the five MCP research tools on `server` from the shared definitions in
 * lib/research/tools.ts (spec 2026-09-28 §4: the in-app chat builds from the same list). Each
 * handler is a thin adapter: the SDK validates `args` against the tool's own input schema before
 * the callback ever runs, `actorFor` resolves the caller's identity from the gate-supplied auth
 * context (never from `args`), and `runTool` turns the service call into `okResult`/`errorResult`.
 * Two distinct shapes reach a client on failure, never a bare 200 with prose only: a
 * schema-invalid call never reaches the callback at all — the SDK itself answers with an MCP
 * tool error whose text is its own prose (`Input validation error: …`); everything past that
 * point (a filter the schema itself cannot express, a service failure) is an MCP tool error
 * whose text is the JSON `{ error: ResearchErrorInfo }`.
 */
export function registerResearchTools(server: McpServer, service: ResearchService, opts: RegisterResearchToolsOptions = {}): void {
  const actorFor: (ctx: ServerContext) => ResearchActor = opts.actorFor ?? actorFromContext;
  const limits = opts.limits ?? researchLimits();
  for (const def of RESEARCH_TOOLS) {
    server.registerTool(
      def.name,
      { title: def.title, description: def.description(limits), inputSchema: def.inputSchema, outputSchema: anyObject, annotations: def.annotations },
      async (args, ctx) => runTool(def.name, () => def.run(service, actorFor(ctx), args)),
    );
  }
}
