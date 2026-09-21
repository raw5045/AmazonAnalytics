import { z } from 'zod';
import type { McpServer, ServerContext } from '@modelcontextprotocol/server';
import {
  emptyInputSchema, keywordDetailsInputSchema, keywordHistoryInputSchema, PAGE_SIZE_MAX, resolveCategoriesInputSchema, searchToolInputSchema,
} from '@/lib/research/contracts';
import { COUNT_CAP } from '@/lib/explorer/buildQuery';
import { researchLimits, type ResearchLimits } from '@/lib/research/limits';
import type { ResearchActor, ResearchService } from '@/lib/research/service';
import { actorFromContext, runTool } from './toolResult';

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const anyObject = z.looseObject({});

/**
 * `search_keywords`'s description, built from the operating constants rather than hand-copied
 * numerals so it can never drift from the schema/service it describes: `PAGE_SIZE_MAX`
 * (contracts.ts — the literal cap `searchToolInputSchema.pageSize` itself enforces), `COUNT_CAP`
 * (lib/explorer/buildQuery.ts — the totals-reporting threshold `lib/research/search.ts`'s count
 * query shares with the Explorer), and `limits.maxRowsPerSearch` (lib/research/limits.ts — the
 * cursor's own reachable-rows ceiling, env-overridable). `searchToolInputSchema` itself now
 * carries the field-by-field shape with its own per-field descriptions, so this text no longer
 * repeats it as a `{ ... }` sketch.
 */
function searchDescription(limits: Pick<ResearchLimits, 'maxRowsPerSearch'>): string {
  return [
    'Search current Amazon keywords with exact filters. Comparators are exact (gt 10000 excludes 10000); any bound excludes null values.',
    'Resolve category words with resolve_categories first and pass its selection objects in filters.categories.selections (several = OR; all other filters = AND).',
    'A range is { gt?, gte?, lt?, lte? }. Sorts: estimatedMonthlySearches (default desc), rank, averageReviews, wordCount, volumeDelta.',
    `Next page: call again with { cursor } only. Pages return up to ${PAGE_SIZE_MAX} rows each (default 50) and are live; at most ${limits.maxRowsPerSearch.toLocaleString('en-US')} rows are reachable per search; totals above ${COUNT_CAP.toLocaleString('en-US')} are reported as at_least. Never present a capped page as everything.`,
    'A follow-up (tighten a bound, drop a filter) is a new search with the complete filter set; the server keeps no conversation state. Zero rows is a true empty result: report it, do not widen the criteria unasked. There is no cost, PPC or profitability data.',
    'estimatedMonthlySearches is an estimate from rank and calibration; averageReviews is the stored average over observed top-three products.',
  ].join(' ');
}

export interface RegisterResearchToolsOptions {
  actorFor?: (ctx: ServerContext) => ResearchActor;
  /** Defaults to `researchLimits()` (memoised, env-driven); overridable so tests can pin the numbers the description is built from. */
  limits?: ResearchLimits;
}

/**
 * Registers the five MCP research tools on `server`. Each handler is a thin adapter: the SDK
 * validates `args` against the tool's own input schema before the callback ever runs, `actorFor`
 * resolves the caller's identity from the gate-supplied auth context (never from `args`), and
 * `runTool` turns the service call into `okResult`/`errorResult`. Two distinct shapes reach a
 * client on failure, never a bare 200 with prose only: a schema-invalid call never reaches the
 * callback at all — the SDK itself answers with an MCP tool error whose text is its own prose
 * (`Input validation error: …`); everything past that point (a filter the schema itself cannot
 * express, a service failure) is an MCP tool error whose text is the JSON
 * `{ error: ResearchErrorInfo }`.
 */
export function registerResearchTools(server: McpServer, service: ResearchService, opts: RegisterResearchToolsOptions = {}): void {
  const actorFor: (ctx: ServerContext) => ResearchActor = opts.actorFor ?? actorFromContext;
  const limits = opts.limits ?? researchLimits();

  server.registerTool(
    'get_research_guide',
    {
      title: 'Research guide',
      description: 'Definitions, presets with exact thresholds, sorts, windows, category rules, population rules, limits and error codes for the KeywordQuarry research tools. Call once per conversation before searching.',
      inputSchema: emptyInputSchema,
      outputSchema: anyObject,
      annotations: READ_ONLY,
    },
    async (_args, ctx) => runTool('get_research_guide', () => service.guide(actorFor(ctx))),
  );

  server.registerTool(
    'resolve_categories',
    {
      title: 'Resolve categories',
      description: "Find Amazon category paths (and this account's custom categories) matching words like \"lighting\"; returns ready-to-use selection objects for search_keywords. Broad words span several branches: ask the person which before searching. Browse with parentPath and an empty query; page with cursor.",
      inputSchema: resolveCategoriesInputSchema,
      outputSchema: anyObject,
      annotations: READ_ONLY,
    },
    async (args, ctx) => runTool('resolve_categories', () => service.resolveCategories(actorFor(ctx), args)),
  );

  server.registerTool(
    'search_keywords',
    {
      title: 'Search keywords',
      description: searchDescription(limits),
      inputSchema: searchToolInputSchema,
      outputSchema: anyObject,
      annotations: READ_ONLY,
    },
    async (args, ctx) => runTool('search_keywords', () => service.search(actorFor(ctx), args)),
  );

  server.registerTool(
    'get_keyword_details',
    {
      title: 'Keyword details',
      description: 'Current metrics, provenance and the top three clicked products (reviews, rating stars, price cents, click and conversion share percentages) for one keyword id from search results. A dormant keyword returns current=null. Missing values stay null.',
      inputSchema: keywordDetailsInputSchema,
      outputSchema: anyObject,
      annotations: READ_ONLY,
    },
    async (args, ctx) => runTool('get_keyword_details', () => service.details(actorFor(ctx), args)),
  );

  server.registerTool(
    'get_keyword_history',
    {
      title: 'Keyword history',
      description: 'Weekly rank and estimated-volume points for one keyword over the last N calendar weeks (default 13, max 52) ending at the dataset week. Weeks without an observation are listed in missingWeeks, never filled with zeros.',
      inputSchema: keywordHistoryInputSchema,
      outputSchema: anyObject,
      annotations: READ_ONLY,
    },
    async (args, ctx) => runTool('get_keyword_history', () => service.history(actorFor(ctx), args)),
  );
}
