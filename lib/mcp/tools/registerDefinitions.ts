import { z } from 'zod';
import type { McpServer, ServerContext } from '@modelcontextprotocol/server';
import type { ResearchLimits } from '@/lib/research/limits';
import type { ResearchActor } from '@/lib/research/service';
import type { ToolDefinition } from '@/lib/research/tools';
import { runTool } from './toolResult';

const anyObject = z.looseObject({});

/** Options for registerResearchTools and registerWorkspaceTools. */
export interface RegisterToolsOptions {
  /** Defaults to actorFromContext (./toolResult.ts): the identity the gate put on the auth context. */
  actorFor?: (ctx: ServerContext) => ResearchActor;
  /** Defaults to `researchLimits()` (memoised, env-driven); overridable so tests can pin the numbers the descriptions are built from. */
  limits?: ResearchLimits;
}

/**
 * Registers one frozen definition list on `server`. Each handler is a thin adapter: the SDK
 * validates `args` against the tool's own input schema before the callback ever runs,
 * `actorFor` resolves the caller's identity from the gate-supplied auth context (never from
 * `args`), and `runTool` turns the service call into `okResult`/`errorResult`. Shared by
 * registerResearchTools.ts and registerWorkspaceTools.ts (spec 2026-09-30 §4).
 */
export function registerDefinitions<TService>(
  server: McpServer,
  defs: ReadonlyArray<ToolDefinition<TService, string>>,
  service: TService,
  actorFor: (ctx: ServerContext) => ResearchActor,
  limits: ResearchLimits,
): void {
  for (const def of defs) {
    server.registerTool(
      def.name,
      { title: def.title, description: def.description(limits), inputSchema: def.inputSchema, outputSchema: anyObject, annotations: def.annotations },
      async (args, ctx) => runTool(def.name, () => def.run(service, actorFor(ctx), args)),
    );
  }
}
