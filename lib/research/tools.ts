import type { z } from 'zod';
import {
  emptyInputSchema, keywordDetailsInputSchema, keywordHistoryInputSchema, PAGE_SIZE_MAX, productDetailsInputSchema, productSearchInputSchema,
  resolveCategoriesInputSchema, searchToolInputSchema,
} from './contracts';
import { COUNT_CAP } from '@/lib/explorer/buildQuery';
import { PRODUCT_MAX_PAGE, PRODUCT_PAGE_SIZE } from '@/lib/products/filters';
import { PRODUCT_HISTORY_CAP } from '@/lib/products/loadProductHistory';
import { PRODUCT_COUNT_CAP } from '@/lib/products/searchProducts';
import type { ResearchLimits } from './limits';
// Not ./products (it loads lib/env): this module must stay importable without it (lib/workspace/tools.ts, the Ask approval code).
import { PRODUCT_TOOL_HISTORY_POINTS, PRODUCT_TOOL_KEYWORDS_CAP } from './productCaps';
import type { ResearchActor, ResearchService } from './service';

export const RESEARCH_TOOL_NAMES = [
  'get_research_guide', 'resolve_categories', 'search_keywords', 'get_keyword_details', 'get_keyword_history', 'search_products', 'get_product_details',
] as const;
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
 * serves both. Provider-neutral (spec 2026-09-28 §4): the MCP registers both lists (the
 * workspace one only while MCP_WRITE_ENABLED is "1"); Ask AI (lib/ask/tools.ts) builds its tool
 * map from RESEARCH_TOOLS, plus WORKSPACE_TOOLS while ASK_AI_WRITES_ENABLED is "1", so a tool's
 * name, description, schema and behaviour cannot drift between the two.
 * `requiresConfirmation` is true for a tool that changes data: the in-app chat asks through an
 * approval card before running it unless the member has allowed that kind of write (spec
 * 2026-10-01 §3; lib/ask/writeKinds.ts classifies each write as a change or a delete, and a write
 * it does not classify always asks); MCP clients decide from `annotations` instead.
 */
export interface ToolDefinition<TService, TName extends string = string> {
  readonly name: TName;
  readonly title: string;
  readonly description: (limits: ResearchLimits) => string;
  /**
   * Must be a `z.strictObject` (the TypeScript type cannot tell strict from strip; each list's
   * tools.test.ts pins it with an unknown-key rejection loop). Typed as a plain `ZodObject`,
   * narrower than `z.ZodType`, so `registerTool`'s JSON-Schema conversion always sees an object shape.
   */
  readonly inputSchema: z.ZodObject<z.ZodRawShape>;
  /**
   * Resolves to the tool's JSON answer. An expected failure throws a ResearchError, which reaches
   * the caller as its info; anything else is logged log-safely and replaced by SAFE_TOOL_FAILURE
   * (classifyToolError in ./toolErrors.ts, used by both the MCP and the Ask AI adapter). A
   * property, not a method, so strictFunctionTypes checks it contravariantly: no `run` can narrow
   * `args` below `unknown`.
   */
  readonly run: (service: TService, actor: ResearchActor, args: unknown) => Promise<object>;
  readonly annotations: ToolAnnotations;
  readonly requiresConfirmation: boolean;
  /**
   * True for a tool only admin accounts may use (spec 2026-10-09 §9, §10: the two products tools);
   * absent means false. Every consumer offers such a tool to an admin only (`isOfferedTo` below):
   * Ask AI builds its tool map per request (lib/ask/tools.ts), and the MCP builds a server per
   * request, registering it for an admin request only (lib/mcp/tools/registerDefinitions.ts,
   * lib/mcp/listingContext.ts). The service itself also refuses a non-admin call with FORBIDDEN,
   * as a backstop.
   */
  readonly adminOnly?: boolean;
}

/** Whether a definition is offered to an account: an `adminOnly` one to an admin only, every other one to everyone. */
export function isOfferedTo(def: { readonly adminOnly?: boolean }, isAdmin: boolean): boolean {
  return def.adminOnly !== true || isAdmin;
}

/**
 * One research tool. Every field is `readonly` and every entry in `RESEARCH_TOOLS` below is
 * individually `Object.freeze`d (in addition to the array itself), so no caller can mutate a
 * shared definition out from under another. All seven are read-only and need no confirmation;
 * the two products tools are also `adminOnly`.
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
 * `search_products`' description (spec 2026-10-09 §9), built from the Products page's constants
 * like searchDescription: PRODUCT_PAGE_SIZE and PRODUCT_MAX_PAGE (lib/products/filters.ts — the
 * page size, and the last page `productSearchInputSchema.page` accepts) and PRODUCT_COUNT_CAP
 * (lib/products/searchProducts.ts — where the count stops being exact). Each filter's own units
 * are in the schema; the guide's products section (catalog.ts) repeats the semantics.
 */
function searchProductsDescription(): string {
  return [
    'Search the product catalog (Amazon ASINs with Keepa data) by listing age, monthly sold, reviews, rating, price, best sellers rank (BSR), BSR against its 30-day average, category, FBA offers and whether Amazon sells it; every filter is optional and they combine with AND.',
    'Units: filters take ratings in stars (0–5, one decimal) and prices in US dollars; answers carry averageRatingX10 (stars × 10: 45 = 4.5 stars) and currentPriceCents (cents).',
    "monthlySold is Amazon's 'bought in past month' floor: 1000 means 1,000+.",
    'bsrRatioMax: current BSR ÷ 30-day average × 100; 70 = at least 30 % better (rankRatioX100 in answers: under 100 = better than its 30-day average).',
    'keywordCount = the current keywords the product is a top-3 clicked product for.',
    `Pages hold ${PRODUCT_PAGE_SIZE} products, page 1 to ${PRODUCT_MAX_PAGE}; totals are exact below ${PRODUCT_COUNT_CAP.toLocaleString('en-US')}, then at_least. Zero products is a true empty result. Each product carries url (its page in the app); pass its asin to get_product_details.`,
    'Admin accounts only for now.',
  ].join(' ');
}

/**
 * `get_product_details`' description, built from the caps it answers under: PRODUCT_TOOL_HISTORY_POINTS
 * and PRODUCT_TOOL_KEYWORDS_CAP (./productCaps.ts, applied in ./products.ts), and the loader's
 * PRODUCT_HISTORY_CAP (lib/products/loadProductHistory.ts — the window first, last and pointsTotal cover).
 */
function productDetailsDescription(): string {
  return [
    "One product by its ASIN (from search_products, or a keyword's top clicked products): the catalog facts, its Keepa snapshot history and the current keywords it is a top-3 clicked product for.",
    "Units: averageRatingX10 = stars × 10 (45 = 4.5 stars); prices are in cents; monthlySold is Amazon's 'bought in past month' floor: 1000 means 1,000+; rankRatioX100 = current BSR ÷ 30-day average × 100 (under 100 = better than its 30-day average).",
    `history.points holds the newest ${PRODUCT_TOOL_HISTORY_POINTS} snapshots, oldest first; first and last are the oldest and newest of the loaded window, for a then-and-now, and pointsTotal counts that window (at most ${PRODUCT_HISTORY_CAP} snapshots).`,
    `keywords: up to ${PRODUCT_TOOL_KEYWORDS_CAP}, best keyword rank first, each with its slot, click and conversion share percentages, weeksInTop3 and keywordUrl; keywordsTotal counts every keyword, past the cap too.`,
    'weeks in top 3 = consecutive imported weeks the ASIN has been a top-3 clicked product for that keyword (any slot); streakStartedWeek is the first week of that run.',
    'product.inCatalog false: keywords known, no product facts (the title may still come from the keyword side; usually the category is excluded from enrichment) and no history. product.fetched false: in the catalog but not fetched yet, so no product facts or history yet either. NOT_FOUND: no data for that ASIN.',
    'Admin accounts only for now.',
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
  frozenTool({
    name: 'search_products',
    title: 'Search products',
    description: searchProductsDescription,
    inputSchema: productSearchInputSchema,
    run: (service, actor, args) => service.searchProducts(actor, args),
    annotations: READ_ONLY_ANNOTATIONS,
    requiresConfirmation: false,
    adminOnly: true,
  }),
  frozenTool({
    name: 'get_product_details',
    title: 'Product details',
    description: productDetailsDescription,
    inputSchema: productDetailsInputSchema,
    run: (service, actor, args) => service.productDetails(actor, args),
    annotations: READ_ONLY_ANNOTATIONS,
    requiresConfirmation: false,
    adminOnly: true,
  }),
]);

export function researchToolByName(name: ResearchToolName): ResearchToolDefinition {
  const t = RESEARCH_TOOLS.find((d) => d.name === name);
  if (!t) throw new Error(`unknown research tool ${name}`);
  return t;
}
