import { z } from 'zod';
import { ResearchError } from './errors';

export const SCHEMA_VERSION = 1 as const;
export const WINDOWS = ['1w', '4w', '13w', '26w', '52w'] as const;
export type Window = (typeof WINDOWS)[number];
export const SORT_FIELDS = ['estimatedMonthlySearches', 'rank', 'averageReviews', 'wordCount', 'volumeDelta'] as const;
export type SortField = (typeof SORT_FIELDS)[number];
export const SEVERITIES = ['none', 'warning', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];
export const PRESET_IDS = ['high_demand_v1', 'low_review_competition_v1', 'growing_4w_v1', 'title_gap_loose_any_v1'] as const;
export type PresetId = (typeof PRESET_IDS)[number];

const safeInt = z.int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);

/** gt/gte/lt/lte with at least one bound, at most one per side, and at least one legal integer inside. */
function integerRange(min: number | null) {
  const bound = min === null ? safeInt : safeInt.min(min);
  return z
    .strictObject({ gt: bound.optional(), gte: bound.optional(), lt: bound.optional(), lte: bound.optional() })
    .superRefine((r, ctx) => {
      const lowers = [r.gt, r.gte].filter((v) => v !== undefined).length;
      const uppers = [r.lt, r.lte].filter((v) => v !== undefined).length;
      if (lowers + uppers === 0) ctx.addIssue({ code: 'custom', message: 'a range needs at least one bound (gt, gte, lt, lte); use null for no range' });
      if (lowers > 1) ctx.addIssue({ code: 'custom', message: 'use only one of gt / gte' });
      if (uppers > 1) ctx.addIssue({ code: 'custom', message: 'use only one of lt / lte' });
      const lo = r.gte !== undefined ? r.gte : r.gt !== undefined ? r.gt + 1 : null;
      const hi = r.lte !== undefined ? r.lte : r.lt !== undefined ? r.lt - 1 : null;
      if (lo !== null && hi !== null && lo > hi) ctx.addIssue({ code: 'custom', message: 'the range contains no integer' });
    });
}
export type IntegerRange = { gt?: number; gte?: number; lt?: number; lte?: number };
export const nonNegativeRange = integerRange(0);
export const positiveRange = integerRange(1);
export const anyRange = integerRange(null);

export const textFilterSchema = z.strictObject({
  value: z.string().trim().min(3, 'text needs at least 3 characters').max(200),
  mode: z.enum(['word', 'broad']).default('word'),
});
export const taxonomySelectionSchema = z.strictObject({
  kind: z.literal('taxonomy'),
  path: z.string().trim().min(1).max(256),
  includeDescendants: z.boolean().default(true),
});
export const customSelectionSchema = z.strictObject({ kind: z.literal('custom'), id: z.uuid() });
export const categoriesSchema = z.strictObject({
  selections: z.array(z.discriminatedUnion('kind', [taxonomySelectionSchema, customSelectionSchema])).max(25).default([]),
  leafPaths: z.array(z.string().trim().min(1).max(256)).max(2000).default([]),
});
export const titleGapSchema = z
  .strictObject({
    slots: z.array(z.union([z.literal(1), z.literal(2), z.literal(3)])).min(1).max(3),
    quantifier: z.enum(['any', 'all']).default('any'),
    mode: z.enum(['loose', 'strict']).default('loose'),
  })
  .refine((t) => new Set(t.slots).size === t.slots.length, { message: 'slots must be distinct', path: ['slots'] });
export const movementSchema = z
  .strictObject({
    window: z.enum(WINDOWS),
    metric: z.enum(['volume', 'rank']),
    prior: anyRange.nullable().default(null),
    current: anyRange.nullable().default(null),
    delta: anyRange.nullable().default(null),
    baseline: z.enum(['observed_only', 'include_not_observed']).default('observed_only'),
  })
  .superRefine((m, ctx) => {
    if (!m.prior && !m.current && !m.delta) ctx.addIssue({ code: 'custom', message: 'movement needs at least one of prior, current, delta' });
    if (m.metric === 'rank' && m.delta) ctx.addIssue({ code: 'custom', message: 'delta is supported for metric=volume only', path: ['delta'] });
    if (m.metric === 'rank' && m.baseline === 'include_not_observed') {
      const priorLower = m.prior && (m.prior.gt !== undefined || m.prior.gte !== undefined);
      const priorUpper = m.prior && (m.prior.lt !== undefined || m.prior.lte !== undefined);
      const currentUpper = m.current && (m.current.lt !== undefined || m.current.lte !== undefined);
      if (!priorLower || priorUpper || !currentUpper) {
        ctx.addIssue({ code: 'custom', message: 'include_not_observed with metric=rank needs a prior lower bound, no prior upper bound, and a current upper bound', path: ['baseline'] });
      }
    }
  });

export const filtersSchema = z.strictObject({
  text: textFilterSchema.nullable().default(null),
  estimatedMonthlySearches: nonNegativeRange.nullable().default(null),
  averageReviews: nonNegativeRange.nullable().default(null),
  rank: positiveRange.nullable().default(null),
  wordCount: positiveRange.nullable().default(null),
  categories: categoriesSchema.default({ selections: [], leafPaths: [] }),
  broadCategory: z.string().trim().min(1).max(255).nullable().default(null),
  severities: z
    .array(z.enum(SEVERITIES)).min(1, 'severities cannot be empty; omit it for the default').max(3)
    .refine((s) => new Set(s).size === s.length, 'severities must be distinct')
    .default(['none', 'warning']),
  titleGap: titleGapSchema.nullable().default(null),
  movement: movementSchema.nullable().default(null),
});
export type Filters = z.infer<typeof filtersSchema>;

export const sortSchema = z.strictObject({ field: z.enum(SORT_FIELDS), direction: z.enum(['asc', 'desc']) });
export type Sort = z.infer<typeof sortSchema>;

export const searchRequestSchema = z
  .strictObject({
    schemaVersion: z.literal(SCHEMA_VERSION),
    presetIds: z.array(z.enum(PRESET_IDS)).max(4).default([]),
    filters: filtersSchema.prefault({}),
    sort: sortSchema.default({ field: 'estimatedMonthlySearches', direction: 'desc' }),
    comparisonWindow: z.enum(WINDOWS).optional(),
    pageSize: z.int().min(1).max(100).default(50),
  })
  .superRefine((r, ctx) => {
    if (r.comparisonWindow && r.filters.movement && r.filters.movement.window !== r.comparisonWindow) {
      ctx.addIssue({ code: 'custom', message: 'comparisonWindow must equal movement.window when both are given', path: ['comparisonWindow'] });
    }
  });
export type SearchRequest = z.infer<typeof searchRequestSchema>;

/** The MCP tool input: a bare `{ cursor }` continuation or a new search (declared loose; parseSearchInput enforces the rest). */
export const searchToolInputSchema = z.looseObject({ cursor: z.string().min(16).max(8192).optional() });
export type ParsedSearchInput = { kind: 'continuation'; cursor: string } | { kind: 'new'; request: SearchRequest };

export function parseSearchInput(raw: unknown): ParsedSearchInput {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  if (typeof obj.cursor === 'string') {
    const extra = Object.keys(obj).filter((k) => k !== 'cursor');
    if (extra.length > 0) {
      throw new ResearchError('INVALID_FILTERS', 'A continuation carries only the cursor; a filter or sort change starts a new search.', {
        details: [{ path: 'cursor', message: `unexpected keys with cursor: ${extra.join(', ')}` }],
      });
    }
    const c = z.string().min(16).max(8192).safeParse(obj.cursor);
    if (!c.success) throw invalid(c.error);
    return { kind: 'continuation', cursor: c.data };
  }
  const parsed = searchRequestSchema.safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error);
  return { kind: 'new', request: parsed.data };
}

export function invalid(error: z.ZodError): ResearchError {
  const details = error.issues.map((i) => ({ path: i.path.map(String).join('.') || '(root)', message: i.message }));
  return new ResearchError('INVALID_FILTERS', `Invalid input: ${details.map((d) => `${d.path}: ${d.message}`).join('; ')}`, { details });
}

export const resolveCategoriesInputSchema = z
  .strictObject({
    query: z.string().trim().max(200).default(''),
    source: z.enum(['taxonomy', 'custom', 'all']).default('all'),
    parentPath: z.string().trim().min(1).max(256).nullable().default(null),
    limit: z.int().min(1).max(50).default(20),
    cursor: z.string().min(1).max(512).nullable().default(null),
  })
  .refine((i) => i.query.length > 0 || i.source === 'custom' || i.parentPath !== null, {
    message: 'an empty query is allowed only for browsing a parentPath or listing custom categories',
    path: ['query'],
  });
export type ResolveCategoriesInput = z.infer<typeof resolveCategoriesInputSchema>;
export const keywordDetailsInputSchema = z.strictObject({ searchTermId: z.uuid() });
export const keywordHistoryInputSchema = z.strictObject({ searchTermId: z.uuid(), weeks: z.int().min(1).max(52).default(13) });
export const emptyInputSchema = z.strictObject({});

// ---------------------------------------------------------------------------
// Output shapes (TypeScript only) — the response contracts the MCP research
// tools (search_keywords, resolve_categories, get_keyword_details,
// get_keyword_history, get_research_guide) build and return.
// ---------------------------------------------------------------------------

export interface Provenance {
  datasetWeek: string; // YYYY-MM-DD
  snapshotVersion: string;
  summaryRefreshedAt: string; // ISO 8601 UTC
  resultCapturedAt: string; // ISO 8601 UTC
  volumeFitRunId: string | null;
  calibrationMonthEndDate: string | null;
  volumeIsExtrapolated: boolean;
  guideVersion: number;
  queryVersion: number;
}
export type BaselineStatus = 'observed' | 'not_observed' | 'calibration_unavailable';
export interface SearchRow {
  searchTermId: string;
  keyword: string;
  keywordUrl: string;
  estimatedMonthlySearches: number | null;
  averageReviews: number | null;
  rank: number;
  wordCount: number | null;
  categoryPath: string | null;
  broadCategory: string | null;
  severity: Severity | null;
  lastSeenWeek: string;
  firstSeenWeek: string;
  /** Present when movement or a volumeDelta sort is active. */
  movement?: { window: Window; priorRank: number | null; priorVolume: number | null; volumeDelta: number | null; baselineStatus: BaselineStatus };
  /** Present when a titleGap filter is active. */
  titleFlags?: { mode: 'loose' | 'strict'; slots: [boolean | null, boolean | null, boolean | null] };
}
export interface TotalMatches {
  kind: 'exact' | 'at_least' | 'unknown';
  value: number | null;
}
export interface Pagination {
  pageSize: number;
  returnedCount: number;
  offset: number;
  totalMatches: TotalMatches;
  nextCursor: string | null;
  capped: boolean;
  capReason: 'max_rows' | 'payload' | null;
  expiresAt: string | null;
}
export interface ResolvedScope {
  selections: Filters['categories']['selections'];
  expandedLeafCount: number;
  leafSetHash: string | null;
  previewPaths: string[];
  previewComplete: boolean;
}
export interface PresetApplication {
  presetId: PresetId;
  appliedFields: string[];
  overriddenFields: string[];
}
export interface Warning {
  code: string;
  message: string;
}
export interface SearchResponse {
  schemaVersion: 1;
  requestId: string;
  appliedFilters: Filters;
  effectiveSort: Sort;
  effectiveWindow: Window;
  presetApplications: PresetApplication[];
  resolvedCategoryScope: ResolvedScope;
  provenance: Provenance;
  rows: SearchRow[];
  pagination: Pagination;
  warnings: Warning[];
}
export interface CategoryCandidate {
  kind: 'taxonomy' | 'custom';
  /** Full path for taxonomy; the custom category name for custom. */
  label: string;
  path: string | null;
  id: string | null;
  terminal: boolean;
  descendantLeafCount: number | null;
  keywordCount: number | null;
  /** Ready-to-use selection object for search_keywords. */
  selection: Filters['categories']['selections'][number];
}
export interface ResolveCategoriesResponse {
  query: string;
  source: 'taxonomy' | 'custom' | 'all';
  parentPath: string | null;
  candidates: CategoryCandidate[];
  nextCursor: string | null;
  totalCandidates: number;
  provenance: Pick<Provenance, 'datasetWeek' | 'snapshotVersion'>;
  noMatch: boolean;
}
export interface ProductSlot {
  slot: 1 | 2 | 3;
  asin: string | null;
  title: string | null;
  clickSharePct: number | null;
  conversionSharePct: number | null;
  reviewCount: number | null;
  ratingStars: number | null;
  currentPriceCents: number | null;
  salesRank: number | null;
  enrichmentStatus: string | null;
}
export interface KeywordDetailsResponse {
  searchTermId: string;
  keyword: string;
  keywordUrl: string;
  status: 'active' | 'dormant';
  firstSeenWeek: string;
  lastSeenWeek: string;
  current: {
    datasetWeek: string;
    rank: number;
    priorWeekRank: number | null;
    estimatedMonthlySearches: number | null;
    volumeIsExtrapolated: boolean;
    averageReviews: number | null;
    wordCount: number | null;
    categoryPath: string | null;
    broadCategory: string | null;
    severity: Severity | null;
    titleFlagsLoose: [boolean | null, boolean | null, boolean | null];
  } | null;
  products: ProductSlot[];
  provenance: Pick<Provenance, 'datasetWeek' | 'snapshotVersion' | 'resultCapturedAt'>;
  warnings: Warning[];
}
export interface HistoryPoint {
  weekEndDate: string;
  rank: number;
  estimatedMonthlySearches: number | null;
  volumeIsExtrapolated: boolean;
  severity: Severity | null;
}
export interface KeywordHistoryResponse {
  searchTermId: string;
  keyword: string;
  windowStart: string;
  windowEnd: string;
  requestedWeeks: number;
  points: HistoryPoint[];
  missingWeeks: string[];
  source: 'chart_series';
  seriesUpdatedAt: string | null;
  warnings: Warning[];
}
export interface GuideResponse {
  guideVersion: number;
  schemaVersion: 1;
  catalogVersion: number;
  datasetWeek: string | null;
  audience: 'admin' | 'all';
  metrics: Array<{ name: string; definition: string }>;
  presets: Array<{ id: PresetId; description: string; filters: Partial<Filters>; sort?: Sort }>;
  sorts: readonly SortField[];
  windows: readonly Window[];
  categoryRules: string[];
  populationRules: string[];
  limits: Record<string, number>;
  pagination: string;
  errorCodes: string[];
}
