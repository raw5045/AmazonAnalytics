import type { z } from 'zod';
import {
  emptyInputSchema, keywordDetailsInputSchema, keywordHistoryInputSchema, PAGE_SIZE_MAX, resolveCategoriesInputSchema, searchToolInputSchema,
} from './contracts';
import { COUNT_CAP } from '@/lib/explorer/buildQuery';
import type { ResearchLimits } from './limits';
import type { ResearchActor, ResearchService } from './service';

export const RESEARCH_TOOL_NAMES = ['get_research_guide', 'resolve_categories', 'search_keywords', 'get_keyword_details', 'get_keyword_history'] as const;
export type ResearchToolName = (typeof RESEARCH_TOOL_NAMES)[number];

export const READ_ONLY_ANNOTATIONS = Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const);

/** MCP tool annotations as each definition sets them (spec 2026-09-30 §3): the four booleans clients read to decide whether to prompt. */
export interface ToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

/**
 * The shape every tool list shares — the research tools below and the workspace tools in
 * lib/workspace/tools.ts — so one registration adapter (lib/mcp/tools/registerDefinitions.ts)
 * serves both. Provider-neutral (spec 2026-09-28 §4): the MCP registration and the in-app chat
 * both build from these lists, so names, descriptions, schemas and behaviour cannot drift.
 * `requiresConfirmation` is true for a tool that changes data: the in-app chat is to ask before
 * running it (a later arc); MCP clients decide from `annotations` instead.
 */
export interface ToolDefinition<TService, TName extends string = string> {
  readonly name: TName;
  readonly title: string;
  readonly description: (limits: ResearchLimits) => string;
  /** Always a `z.strictObject(...)` — a plain `ZodObject`, narrower than `z.ZodType`, so `registerTool`'s JSON-Schema conversion always sees an object shape. */
  readonly inputSchema: z.ZodObject<z.ZodRawShape>;
  readonly run: (service: TService, actor: ResearchActor, args: unknown) => Promise<object>;
  readonly annotations: ToolAnnotations;
  readonly requiresConfirmation: boolean;
}

/**
 * One research tool. Every field is `readonly` and every entry in `RESEARCH_TOOLS` below is
 * individually `Object.freeze`d (in addition to the array itself), so no caller can mutate a
 * shared definition out from under another. All five are read-only and need no confirmation.
 */
export interface ResearchToolDefinition extends ToolDefinition<ResearchService, ResearchToolName> {
  readonly annotations: typeof READ_ONLY_ANNOTATIONS;
  readonly requiresConfirmation: false;
}

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
    `filters.excludeTerms drops keywords containing any of up to five whole words or phrases (3+ characters each) — use it for "lamps but not floor lamps"; it works with or without filters.text. Matching is exact whole words ('lamp' does not drop 'lamps'; list each form).`,
    'A range is { gt?, gte?, lt?, lte? }. Sorts: estimatedMonthlySearches (default desc), rank, averageReviews, wordCount, volumeDelta. A volumeDelta sort without a movement filter includes never-observed keywords at a zero baseline (labelled not_observed); add movement with baseline observed_only to exclude them.',
    `Next page: call again with { cursor } only. Pages return up to ${PAGE_SIZE_MAX} rows each (default 50) and are live; at most ${limits.maxRowsPerSearch.toLocaleString('en-US')} rows are reachable per search; totals above ${COUNT_CAP.toLocaleString('en-US')} are reported as at_least. Never present a capped page as everything.`,
    'A follow-up (tighten a bound, drop a filter) is a new search with the complete filter set; the server keeps no conversation state. Zero rows is a true empty result: report it, do not widen the criteria unasked. There is no cost, PPC or profitability data.',
    'estimatedMonthlySearches is an estimate from rank and calibration; averageReviews is the stored average over observed top-three products.',
  ].join(' ');
}

/**
 * Freezes one shared definition. `Object.freeze({...})` called directly on the object literal
 * would lose `ResearchToolDefinition`'s contextual type for that literal (`Object.freeze<T>`
 * infers `T` from its argument instead of receiving it), so each `run` callback's
 * `service`/`actor`/`args` parameters would become implicit `any` (TS7006 under strict) —
 * routing through this explicitly-typed helper keeps the contextual type and the parameter
 * types it supplies.
 */
function frozenTool(def: ResearchToolDefinition): ResearchToolDefinition {
  return Object.freeze(def);
}

export const RESEARCH_TOOLS: ReadonlyArray<ResearchToolDefinition> = Object.freeze([
  frozenTool({
    name: 'get_research_guide',
    title: 'Research guide',
    description: () => 'Definitions, presets with exact thresholds, sorts, windows, category rules, population rules, limits and error codes for the KeywordQuarry research tools. Call once per conversation before searching.',
    inputSchema: emptyInputSchema,
    run: (service, actor) => service.guide(actor),
    annotations: READ_ONLY_ANNOTATIONS,
    requiresConfirmation: false,
  }),
  frozenTool({
    name: 'resolve_categories',
    title: 'Resolve categories',
    description: () => "Find Amazon category paths (and this account's custom categories) matching words like \"lighting\"; returns ready-to-use selection objects for search_keywords. Broad words span several branches: ask the person which before searching. Browse with parentPath and an empty query; page with cursor.",
    inputSchema: resolveCategoriesInputSchema,
    run: (service, actor, args) => service.resolveCategories(actor, args),
    annotations: READ_ONLY_ANNOTATIONS,
    requiresConfirmation: false,
  }),
  frozenTool({
    name: 'search_keywords',
    title: 'Search keywords',
    description: searchDescription,
    inputSchema: searchToolInputSchema,
    run: (service, actor, args) => service.search(actor, args),
    annotations: READ_ONLY_ANNOTATIONS,
    requiresConfirmation: false,
  }),
  frozenTool({
    name: 'get_keyword_details',
    title: 'Keyword details',
    description: () => 'Current metrics, provenance and the top three clicked products (reviews, rating stars, price cents, click and conversion share percentages) for one keyword id from search results. A dormant keyword returns current=null. Missing values stay null.',
    inputSchema: keywordDetailsInputSchema,
    run: (service, actor, args) => service.details(actor, args),
    annotations: READ_ONLY_ANNOTATIONS,
    requiresConfirmation: false,
  }),
  frozenTool({
    name: 'get_keyword_history',
    title: 'Keyword history',
    description: () => 'Weekly rank and estimated-volume points for one keyword over the last N calendar weeks (default 13, max 52) ending at the dataset week. Weeks without an observation are listed in missingWeeks, never filled with zeros.',
    inputSchema: keywordHistoryInputSchema,
    run: (service, actor, args) => service.history(actor, args),
    annotations: READ_ONLY_ANNOTATIONS,
    requiresConfirmation: false,
  }),
]);

export function researchToolByName(name: ResearchToolName): ResearchToolDefinition {
  const t = RESEARCH_TOOLS.find((d) => d.name === name);
  if (!t) throw new Error(`unknown research tool ${name}`);
  return t;
}
