import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  emptyInputSchema, keywordDetailsInputSchema, keywordHistoryInputSchema, resolveCategoriesInputSchema, searchToolInputSchema,
} from '@/lib/research/contracts';
import type { ResearchActor, ResearchService } from '@/lib/research/service';
import { actorFromContext, runTool, type ToolContext } from './toolResult';

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const anyObject = z.looseObject({});

const SEARCH_DESCRIPTION = [
  'Search current Amazon keywords with exact filters. Comparators are exact (gt 10000 excludes 10000); any bound excludes null values.',
  'Resolve category words with resolve_categories first and pass its selection objects in filters.categories.selections (several = OR; all other filters = AND).',
  'New search: { schemaVersion: 1, filters?: { text?: {value, mode?}, estimatedMonthlySearches?: range, averageReviews?: range, rank?: range, wordCount?: range, categories?: {selections?}, broadCategory?, severities?, titleGap?: {slots, quantifier?, mode?}, movement?: {window, metric, prior?, current?, delta?, baseline?} }, presetIds?: [high_demand_v1 | low_review_competition_v1 | growing_4w_v1 | title_gap_loose_any_v1], sort?: {field, direction}, comparisonWindow?, pageSize? (max 100) }.',
  'A range is { gt?, gte?, lt?, lte? }. Sorts: estimatedMonthlySearches (default desc), rank, averageReviews, wordCount, volumeDelta.',
  'Next page: call again with { cursor } only. Pages are live; at most 1,000 rows per search; totals above 10,000 are reported as at_least. Never present a capped page as everything.',
  'estimatedMonthlySearches is an estimate from rank and calibration; averageReviews is the stored average over observed top-three products.',
].join(' ');

export interface RegisterResearchToolsOptions {
  actorFor?: (ctx: ToolContext) => ResearchActor;
}

/**
 * Registers the five MCP research tools on `server`. Each handler is a thin adapter: the SDK
 * validates `args` against the tool's own input schema before the callback ever runs, `actorFor`
 * resolves the caller's identity from the gate-supplied auth context (never from `args`), and
 * `runTool` turns the service call into `okResult`/`errorResult` — a bare 200 with prose is never
 * returned for a failure; every error is an MCP tool error whose text is `{ error: ResearchErrorInfo }`.
 */
export function registerResearchTools(server: McpServer, service: ResearchService, opts: RegisterResearchToolsOptions = {}): void {
  const actorFor = opts.actorFor ?? actorFromContext;

  server.registerTool(
    'get_research_guide',
    {
      title: 'Research guide',
      description: 'Definitions, presets with exact thresholds, sorts, windows, category rules, population rules, limits and error codes for the KeywordQuarry research tools. Call once per conversation before searching.',
      inputSchema: emptyInputSchema,
      outputSchema: anyObject,
      annotations: READ_ONLY,
    },
    async (_args, ctx) => runTool(() => service.guide(actorFor(ctx as ToolContext))),
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
    async (args, ctx) => runTool(() => service.resolveCategories(actorFor(ctx as ToolContext), args)),
  );

  server.registerTool(
    'search_keywords',
    {
      title: 'Search keywords',
      description: SEARCH_DESCRIPTION,
      inputSchema: searchToolInputSchema,
      outputSchema: anyObject,
      annotations: READ_ONLY,
    },
    async (args, ctx) => runTool(() => service.search(actorFor(ctx as ToolContext), args)),
  );

  server.registerTool(
    'get_keyword_details',
    {
      title: 'Keyword details',
      description: 'Current metrics, provenance and the top three clicked products (reviews, rating stars, price cents, click and conversion share) for one keyword id from search results. A dormant keyword returns current=null. Missing values stay null.',
      inputSchema: keywordDetailsInputSchema,
      outputSchema: anyObject,
      annotations: READ_ONLY,
    },
    async (args, ctx) => runTool(() => service.details(actorFor(ctx as ToolContext), args)),
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
    async (args, ctx) => runTool(() => service.history(actorFor(ctx as ToolContext), args)),
  );
}
