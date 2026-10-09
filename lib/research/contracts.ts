import { z } from 'zod';
import { MAX_EXCLUDE_TERM_LENGTH, MAX_EXCLUDE_TERMS, MIN_EXCLUDE_TERM_LENGTH } from '@/lib/explorer/parseFilters';
import {
  MAX_CATEGORY_PATH_LENGTH, PRODUCT_AGES, PRODUCT_DEFAULTS, PRODUCT_MAX_PAGE, PRODUCT_PAGE_SIZE, PRODUCT_SORTS, type ProductFilters,
} from '@/lib/products/filters';
import type { ProductFacts as CatalogProductFacts } from '@/lib/products/loadProduct';
import type { HistoryPoint as SnapshotHistoryPoint } from '@/lib/products/loadProductHistory';
import type { ProductKeywordRow } from '@/lib/products/loadProductKeywords';
import type { ProductSummaryRow } from '@/lib/products/searchProducts';
import { ResearchError, invalidCursorError } from './errors';
import type { ResearchLimits } from './limits';

export const SCHEMA_VERSION = 1 as const;
export const WINDOWS = ['1w', '4w', '13w', '26w', '52w'] as const;
export type Window = (typeof WINDOWS)[number];
export const SORT_FIELDS = ['estimatedMonthlySearches', 'rank', 'averageReviews', 'wordCount', 'volumeDelta'] as const;
export type SortField = (typeof SORT_FIELDS)[number];
export const SEVERITIES = ['none', 'warning', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];
export const PRESET_IDS = ['high_demand_v1', 'low_review_competition_v1', 'growing_4w_v1', 'title_gap_loose_any_v1'] as const;
export type PresetId = (typeof PRESET_IDS)[number];
export const TOTAL_MATCHES_KINDS = ['exact', 'at_least', 'unknown'] as const;
export type TotalMatchesKind = (typeof TOTAL_MATCHES_KINDS)[number];
export const RESEARCH_CHANNELS = ['mcp', 'chat'] as const;
export type ResearchChannel = (typeof RESEARCH_CHANNELS)[number];
/** Ceiling shared by searchRequestSchema.pageSize and cursor.ts's cursorPayloadSchema.ps — a cursor's page size can never exceed what a request could ever specify. */
export const PAGE_SIZE_MAX = 100;

const safeInt = z.int();

/**
 * The floor/ceiling-vs-implied-range emptiness message for one gt/gte/lt/lte range, given a
 * domain floor and ceiling (either or both null for none), or null when the range isn't
 * empty. `floor` seeds the implicit lower bound when neither gt nor gte is given, and
 * symmetrically `ceiling` seeds the implicit upper bound when neither lt nor lte is given —
 * so e.g. `{ lt: 1 }` against floor 1 is recognized as empty, and so is `{ gt: ceiling }`
 * against that same ceiling (an explicit lower bound sitting exactly at the ceiling leaves no
 * integer strictly above it). Shared by integerRange (its own field-level min/max) and
 * movementSchema's superRefine (the metric-scoped floor/ceiling for prior/current, which
 * anyRange can't know statically — but movementSchema calls this only when at least one side
 * is left for floor/ceiling to seed; when both an explicit lower AND an explicit upper bound
 * are given, anyRange has already checked them against each other and reported any emptiness
 * itself, so calling this again there would double-report the same issue). Bound-COUNT issues
 * (missing / duplicate bounds) are deliberately NOT part of this: they live in integerRange
 * alone, since anyRange's own superRefine already runs them for prior/current before
 * movementSchema's domain check ever sees the parsed value — rerunning them there would
 * double-report the same issue.
 */
function emptyRangeIssue(range: { gt?: number; gte?: number; lt?: number; lte?: number }, floor: number | null, ceiling: number | null): string | null {
  const lo = range.gte !== undefined ? range.gte : range.gt !== undefined ? range.gt + 1 : floor;
  const hi = range.lte !== undefined ? range.lte : range.lt !== undefined ? range.lt - 1 : ceiling;
  if (lo !== null && hi !== null && lo > hi) return 'the range contains no integer';
  return null;
}

/**
 * gt/gte/lt/lte with at least one bound, at most one per side, and at least one legal integer
 * inside. `max`, when given, additionally caps every bound — for a filter field bound to a
 * fixed-width Postgres column (see INT4_MAX/SMALLINT_MAX below); omitted, a bound is limited
 * only by z.int()'s own safe-integer ceiling, for the bigint-column fields.
 */
function integerRange(min: number | null, max?: number) {
  let bound = min === null ? safeInt : safeInt.min(min);
  if (max !== undefined) bound = bound.max(max);
  return z
    .strictObject({ gt: bound.optional(), gte: bound.optional(), lt: bound.optional(), lte: bound.optional() })
    .superRefine((r, ctx) => {
      const lowers = [r.gt, r.gte].filter((v) => v !== undefined).length;
      const uppers = [r.lt, r.lte].filter((v) => v !== undefined).length;
      if (lowers + uppers === 0) ctx.addIssue({ code: 'custom', message: 'a range needs at least one bound (gt, gte, lt, lte); use null for no range' });
      if (lowers > 1) ctx.addIssue({ code: 'custom', message: 'use only one of gt / gte' });
      if (uppers > 1) ctx.addIssue({ code: 'custom', message: 'use only one of lt / lte' });
      const empty = emptyRangeIssue(r, min, max ?? null);
      if (empty) ctx.addIssue({ code: 'custom', message: empty });
    })
    .describe('Exact comparators: gt 10000 excludes 10000; one lower and/or one upper bound; a bound excludes null rows.');
}
export const nonNegativeRange = integerRange(0);
export const anyRange = integerRange(null);
export type IntegerRange = z.infer<typeof anyRange>;

/**
 * Postgres column ceilings for the filter fields bound directly to a fixed-width column
 * (lib/research/query.ts, over lib/explorer/buildQuery.ts's WHERE fragments): current_rank /
 * rank_*_ago / avg_reviews are int4, word_count is int2. z.int() alone accepts any safe
 * integer (up to 2^53-1), but Postgres infers each bind param's type from its column, so a
 * bound above the column's own range raises SQLSTATE 22003 at query time instead of this
 * schema's own INVALID_FILTERS. lib/explorer/parseFilters.ts enforces the same two ceilings,
 * under the same names, for the Explorer's URL-param bounds — but doesn't export them, so
 * they're redefined here rather than reaching into that module for this fix.
 */
const INT4_MAX = 2_147_483_647;
const SMALLINT_MAX = 32_767;

export const textFilterSchema = z
  .strictObject({
    value: z.string().trim().min(3, 'text needs at least 3 characters').max(200),
    mode: z.enum(['word', 'broad']).default('word'),
  })
  .describe('mode word = whole-word match (default), broad = substring');
export const taxonomySelectionSchema = z.strictObject({
  kind: z.literal('taxonomy'),
  path: z.string().trim().min(1).max(256),
  includeDescendants: z.boolean().default(true),
});
// Lowercased: clients may send uppercase, Postgres returns lowercase, and resolveScope matches ids in JavaScript (spec 2026-09-30 §3).
export const customSelectionSchema = z.strictObject({ kind: z.literal('custom'), id: z.uuid().toLowerCase() });
export const categoriesSchema = z
  .strictObject({
    selections: z.array(z.discriminatedUnion('kind', [taxonomySelectionSchema, customSelectionSchema])).max(25).default([]),
    leafPaths: z.array(z.string().trim().min(1).max(256)).max(2000).default([]),
  })
  .describe('selections from resolve_categories (several = OR); leafPaths = exact terminal paths');
export const titleGapSchema = z
  .strictObject({
    slots: z.array(z.literal([1, 2, 3])).min(1).max(3),
    quantifier: z.enum(['any', 'all']).default('any'),
    mode: z.enum(['loose', 'strict']).default('loose'),
  })
  .refine((t) => new Set(t.slots).size === t.slots.length, { message: 'slots must be distinct', path: ['slots'] })
  .describe('slots 1..3 = top clicked products; quantifier any|all; mode loose|strict');
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
    // Domain floor (parent design §8.1): volume ranges are >= 0, rank ranges are >= 1;
    // only delta may be negative. anyRange can't enforce this statically since the floor
    // depends on the sibling `metric` field, so the out-of-domain check always runs here
    // with the metric-scoped floor. Emptiness is NOT always safe to re-run, though: when
    // BOTH an explicit lower bound (gt/gte) AND an explicit upper bound (lt/lte) are given,
    // anyRange's own superRefine has already checked them against each other and reported
    // any emptiness itself — redoing that here would double-report the same issue. Only
    // when exactly one side is explicit — so `floor` or `ceiling` is the one supplying the
    // other side, information anyRange couldn't have had — is this new, so that's the only
    // case this re-checks (checkDomain's `!hasLower || !hasUpper`). The bound-count checks
    // are NOT repeated here either — anyRange's own superRefine already ran them for this
    // same parsed value, so redoing them would report each one twice. A rank-metric ceiling
    // (INT4_MAX — prior/current bind to int4 columns) is checked two ways here, since
    // anyRange has no column-type information either: aboveCeiling below catches an explicit
    // bound literally past it, and emptyRangeIssue's ceiling-seeded `hi` catches an explicit
    // lower bound sitting exactly at it (e.g. `{ gt: INT4_MAX }`, which isn't "above" the
    // ceiling but leaves no integer strictly above it either) — the same way its floor-seeded
    // `lo` already catches `{ lt: floor }`. delta and every volume-metric bound stay uncapped
    // (bigint columns), matching filtersSchema's own int4-vs-bigint split.
    const floor = m.metric === 'volume' ? 0 : 1;
    const ceiling = m.metric === 'rank' ? INT4_MAX : null;
    const checkDomain = (key: 'prior' | 'current', range: typeof m.prior) => {
      if (!range) return;
      const bounds = [range.gt, range.gte, range.lt, range.lte];
      const outOfDomain = bounds.some((b) => b !== undefined && b < floor);
      const aboveCeiling = ceiling !== null && bounds.some((b) => b !== undefined && b > ceiling);
      const hasLower = range.gt !== undefined || range.gte !== undefined;
      const hasUpper = range.lt !== undefined || range.lte !== undefined;
      if (outOfDomain) {
        ctx.addIssue({ code: 'custom', message: `${key} bounds must be >= ${floor} for metric=${m.metric}`, path: [key] });
      } else if (aboveCeiling) {
        ctx.addIssue({ code: 'custom', message: `${key} bounds must be <= ${ceiling} for metric=${m.metric}`, path: [key] });
      } else if (!hasLower || !hasUpper) {
        const empty = emptyRangeIssue(range, floor, ceiling);
        if (empty) ctx.addIssue({ code: 'custom', message: empty, path: [key] });
      }
    };
    checkDomain('prior', m.prior);
    checkDomain('current', m.current);
  })
  .describe('delta only for metric=volume; at least one of prior/current/delta; include_not_observed counts a missing prior as zero volume');

export const filtersSchema = z.strictObject({
  text: textFilterSchema.nullable().default(null),
  excludeTerms: z
    .array(z.string().trim().min(MIN_EXCLUDE_TERM_LENGTH, `each exclude term needs at least ${MIN_EXCLUDE_TERM_LENGTH} characters`).max(MAX_EXCLUDE_TERM_LENGTH))
    .max(MAX_EXCLUDE_TERMS, `excludeTerms allows at most ${MAX_EXCLUDE_TERMS} terms`)
    .refine((t) => new Set(t.map((s) => s.toLowerCase())).size === t.length, 'excludeTerms must be distinct (case-insensitive)')
    .default([])
    .describe(
      `Whole words or phrases a keyword must NOT contain (up to ${MAX_EXCLUDE_TERMS}, ${MIN_EXCLUDE_TERM_LENGTH}+ characters each); a keyword is dropped if it contains any of them. Works with or without text and combines with every other filter (AND). Exact whole words: 'lamp' does not drop 'lamps'; list each form you want excluded.`,
    ),
  estimatedMonthlySearches: nonNegativeRange.nullable().default(null),
  averageReviews: integerRange(0, INT4_MAX).nullable().default(null),
  rank: integerRange(1, INT4_MAX).nullable().default(null),
  wordCount: integerRange(1, SMALLINT_MAX).nullable().default(null),
  categories: categoriesSchema.prefault({}),
  broadCategory: z.string().trim().min(1).max(255).nullable().default(null),
  severities: z
    .array(z.enum(SEVERITIES)).min(1, 'severities cannot be empty; omit it for the default').max(3)
    .refine((s) => new Set(s).size === s.length, 'severities must be distinct')
    .default(['none', 'warning'])
    .describe("default ['none','warning']; add 'critical' to include flagged keywords"),
  titleGap: titleGapSchema.nullable().default(null),
  movement: movementSchema.nullable().default(null),
});
export type Filters = z.infer<typeof filtersSchema>;

export const sortSchema = z.strictObject({ field: z.enum(SORT_FIELDS), direction: z.enum(['asc', 'desc']) });
export type Sort = z.infer<typeof sortSchema>;
/**
 * The catalog's documented default sort, used by lib/research/catalog.ts when neither the
 * request nor an applied preset supplies one. Frozen: it is a process-wide singleton, so a
 * caller mutating a `sort`/`effectiveSort` it was handed must never be able to corrupt the
 * fallback every other request relies on.
 */
export const DEFAULT_SORT: Sort = Object.freeze({ field: 'estimatedMonthlySearches', direction: 'desc' });

export const searchRequestSchema = z
  .strictObject({
    schemaVersion: z.literal(SCHEMA_VERSION),
    presetIds: z
      .array(z.enum(PRESET_IDS))
      .max(4)
      .refine((p) => new Set(p).size === p.length, 'presetIds must be distinct')
      .default([]),
    filters: filtersSchema.prefault({}),
    // Optional, not defaulted: presence is how the catalog tells an explicit sort apart from
    // one it must fill in itself (from an applied preset, else DEFAULT_SORT — see catalog.ts).
    sort: sortSchema.optional(),
    comparisonWindow: z.enum(WINDOWS).nullable().default(null),
    pageSize: z.int().min(1).max(PAGE_SIZE_MAX).default(50),
  })
  .superRefine((r, ctx) => {
    if (r.comparisonWindow && r.filters.movement && r.filters.movement.window !== r.comparisonWindow) {
      ctx.addIssue({ code: 'custom', message: 'comparisonWindow must equal movement.window when both are given', path: ['comparisonWindow'] });
    }
  });
export type SearchRequest = z.infer<typeof searchRequestSchema>;

/** Max length of an encoded cursor token (`body.mac`, both base64url) — also cursor.ts's own ceiling for signCursor/verifyCursor. */
export const MAX_CURSOR_LENGTH = 8192;

/**
 * True for a `.default(v)`/`.prefault(v)`-wrapped schema — `ZodDefault`/`ZodPrefault` are
 * unwrapped to the plain inner schema before `.optional()`, so the published tool schema never
 * carries a wire-level default (searchToolInputSchema below: the SDK hands the tool callback its
 * own PARSED output, so a defaulted sibling field would turn a bare `{ cursor }` continuation
 * into `parseSearchInput`'s "unexpected keys with cursor" rejection once the SDK fills it in).
 */
const optionalWithoutDefault = (s: z.ZodType) =>
  (s instanceof z.ZodDefault || s instanceof z.ZodPrefault ? (s.unwrap() as z.ZodType) : s).optional();
const shape = searchRequestSchema.shape;
/**
 * The MCP tool's published input: every `SearchRequest` field, individually optional and never
 * defaulted at this top level (see `optionalWithoutDefault` above), so `tools/list` advertises
 * the real shape — field names, types, per-field descriptions — instead of a bare `{ cursor }`
 * with `additionalProperties: {}`, and the SDK rejects an unrecognized/hallucinated key before
 * the tool ever runs. `parseSearchInput` below does its own independent strict validation
 * (cursor-only continuation vs. `searchRequestSchema`) regardless of what this schema already
 * checked; it does not read from this schema at all.
 */
export const searchToolInputSchema = z.strictObject({
  cursor: z
    .string()
    .min(16)
    .max(MAX_CURSOR_LENGTH)
    .optional()
    .describe(
      "Continuation token from the previous page's pagination.nextCursor. Send it ALONE; any other key with it is rejected. Expires at the search's pagination.expiresAt or at the weekly refresh (SEARCH_EXPIRED: start a new search).",
    ),
  schemaVersion: shape.schemaVersion.optional().describe('Required for a new search; always 1.'),
  presetIds: optionalWithoutDefault(shape.presetIds).describe(
    'Catalog presets (get_research_guide lists exact thresholds). An explicit filter on the same field replaces the preset value.',
  ),
  filters: optionalWithoutDefault(shape.filters),
  sort: shape.sort.describe('Default estimatedMonthlySearches desc. volumeDelta sorts by change over comparisonWindow.'),
  comparisonWindow: optionalWithoutDefault(shape.comparisonWindow).describe(
    'Lookback for movement columns; must equal filters.movement.window when both are given; default 4w.',
  ),
  pageSize: optionalWithoutDefault(shape.pageSize).describe('1-100, default 50.'),
});
export type ParsedSearchInput = { kind: 'continuation'; cursor: string } | { kind: 'new'; request: SearchRequest };

export function parseSearchInput(raw: unknown): ParsedSearchInput {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const hasCursorKey = Object.prototype.hasOwnProperty.call(obj, 'cursor');
  if (hasCursorKey && obj.cursor !== undefined) {
    const extra = Object.keys(obj).filter((k) => k !== 'cursor');
    if (extra.length > 0) {
      throw new ResearchError('INVALID_FILTERS', 'A continuation carries only the cursor; a filter or sort change starts a new search.', {
        details: [{ path: 'cursor', message: `unexpected keys with cursor: ${extra.join(', ')}` }],
      });
    }
    const c = z.strictObject({ cursor: z.string().min(16).max(MAX_CURSOR_LENGTH) }).safeParse({ cursor: obj.cursor });
    if (!c.success) {
      const details = c.error.issues.map((i) => ({ path: i.path.map(String).join('.') || '(root)', message: i.message }));
      throw invalidCursorError(details);
    }
    return { kind: 'continuation', cursor: c.data.cursor };
  }
  // A `cursor` key present with an undefined value (e.g. `{ cursor: undefined, ... }`)
  // isn't a continuation attempt; strip it so it doesn't trip the strict-object
  // unrecognized-key check below (an own key survives even when its value is undefined).
  const searchInput = hasCursorKey ? Object.fromEntries(Object.entries(obj).filter(([k]) => k !== 'cursor')) : raw;
  const parsed = searchRequestSchema.safeParse(searchInput);
  if (!parsed.success) throw invalid(parsed.error);
  return { kind: 'new', request: parsed.data };
}

export function invalid(error: z.ZodError): ResearchError {
  const details = error.issues.map((i) => ({ path: i.path.map(String).join('.') || '(root)', message: i.message }));
  const rendered = details.map((d) => (d.path === '(root)' ? d.message : `${d.path}: ${d.message}`));
  return new ResearchError('INVALID_FILTERS', `Invalid input: ${rendered.join('; ')}`, { details });
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
// Products tools (spec 2026-10-09 §8, §9; admin-only). The search input is the Products page's
// filter set (lib/products/filters.ts) in a caller's units — US dollars and stars — under names a
// reader expects; toProductFilters maps it onto ProductFilters (cents, stars × 10, the page's own
// field names). Nothing is defaulted or transformed beyond a trim: the SDK hands the tool its own
// parsed output and the service parses that again, so a parse must be idempotent, and the defaults
// (PRODUCT_DEFAULTS) are the mapper's job.
// ---------------------------------------------------------------------------

/** The top price bound in dollars: its cents must still fit the int4 current_price_cents column (INT4_MAX above). */
export const PRODUCT_PRICE_DOLLARS_MAX = INT4_MAX / 100;
/** An ASIN as the catalog stores it: ten capital letters or digits. */
const ASIN_PATTERN = /^[A-Z0-9]{10}$/;
/** The search's min/max pairs: a minimum above its maximum is refused, never answered with an empty page. */
const PRODUCT_RANGE_PAIRS = [['ratingMin', 'ratingMax'], ['priceMin', 'priceMax'], ['bsrMin', 'bsrMax']] as const;

/**
 * At most `places` decimals, as a refine rather than multipleOf: a refine stays out of the published
 * JSON Schema, where a validator that checks multipleOf by division rejects 19.99 (19.99 / 0.01 is
 * 1998.9999999999998). The tolerance absorbs that floating-point error, up to the price ceiling.
 */
const atMostDecimals = (places: number) => (v: number) => {
  const scaled = v * 10 ** places;
  return Math.abs(scaled - Math.round(scaled)) < 1e-6;
};
const productStars = z.number().min(0).max(5).refine(atMostDecimals(1), 'at most one decimal');
const productDollars = z.number().min(0).max(PRODUCT_PRICE_DOLLARS_MAX).refine(atMostDecimals(2), 'at most two decimals');
const productBsr = z.int().min(1).max(INT4_MAX);

const productSearchFiltersSchema = z
  .strictObject({
    listedWithinDays: z.literal(PRODUCT_AGES).optional().describe(`Listed on Amazon within the last N days: one of ${PRODUCT_AGES.join(', ')}.`),
    monthlySoldMin: z.int().min(1).max(INT4_MAX).optional().describe(
      "Monthly sold at least N, from Amazon's 'bought in past month' badge. The badge is a floor: 1000 means 1,000+ (buckets run from 50 to 100000). Products without the badge are excluded.",
    ),
    reviewsMax: z.int().min(0).max(INT4_MAX).optional().describe('Review count at most N; products without a review count are excluded.'),
    ratingMin: productStars.optional().describe('Average rating at least N stars (0 to 5, one decimal: 4.5); unrated products are excluded.'),
    ratingMax: productStars.optional().describe('Average rating at most N stars (0 to 5, one decimal); unrated products are excluded.'),
    priceMin: productDollars.optional().describe(
      'Current price at least N US dollars (up to two decimals: 19.99). Only active listings carry a price, so any price bound leaves the others out.',
    ),
    priceMax: productDollars.optional().describe('Current price at most N US dollars (up to two decimals).'),
    bsrMin: productBsr.optional().describe('Best sellers rank in its main category at least N (1 = the best seller); products without a rank are excluded.'),
    bsrMax: productBsr.optional().describe('Best sellers rank in its main category at most N; products without a rank are excluded.'),
    bsrRatioMax: z.int().min(1).max(1000).optional().describe(
      'Current BSR ÷ its 30-day average BSR × 100, at most N: 70 = ranked at least 30 % better than its 30-day average; under 100 = better than average.',
    ),
    categoryPath: z.string().trim().min(1).max(MAX_CATEGORY_PATH_LENGTH).optional().describe(
      "A category path with ' › ' between levels (as resolve_categories returns it), or a department alone ('Health & Household'): matches that path and every path under it.",
    ),
    fba: z.enum(['yes', 'no']).optional().describe('yes = at least one FBA offer; no = Keepa reported zero FBA offers (a product with no reported count matches neither).'),
    amazonSelling: z.enum(['yes', 'no']).optional().describe('yes = Amazon itself has an offer (in any availability state); no = no Amazon offer, or none reported.'),
  })
  .superRefine((f, ctx) => {
    for (const [lo, hi] of PRODUCT_RANGE_PAIRS) {
      const min = f[lo];
      const max = f[hi];
      if (min !== undefined && max !== undefined && min > max) ctx.addIssue({ code: 'custom', message: `${lo} is above ${hi}, so no product could match`, path: [lo] });
    }
  });

/** search_products' input: every field optional and undefaulted (see the section note above). */
export const productSearchInputSchema = z.strictObject({
  filters: productSearchFiltersSchema.optional().describe(
    'All optional, combined with AND. Every search covers the in-scope catalog products with an active or no-price listing.',
  ),
  sort: z.enum(PRODUCT_SORTS).optional().describe(
    `One of ${PRODUCT_SORTS.join(', ')}; default sold (the monthly sold badge). listed = listing date, bsr = best sellers rank (asc = best first), ratio = BSR against its 30-day average, keywords = current keywords the product is a top-3 clicked product for. Every sort but keywords leaves out products missing that value.`,
  ),
  dir: z.enum(['asc', 'desc']).optional().describe('asc or desc; default desc.'),
  page: z.int().min(1).max(PRODUCT_MAX_PAGE).optional().describe(`1-based page of ${PRODUCT_PAGE_SIZE} products; default 1, at most ${PRODUCT_MAX_PAGE}.`),
});
export type ProductSearchInput = z.infer<typeof productSearchInputSchema>;

/** Dollars (two decimals) to whole cents, rounded: 19.99 × 100 is 1998.9999999999998 in floating point. */
const dollarsToCents = (dollars: number | undefined): number | null => (dollars === undefined ? null : Math.round(dollars * 100));
/** Stars (one decimal) to the catalog's stars × 10 integer, rounded for the same reason. */
const starsToX10 = (stars: number | undefined): number | null => (stars === undefined ? null : Math.round(stars * 10));

/**
 * A parsed search_products input as the Products page's ProductFilters: the page's field names,
 * cents and stars × 10, and PRODUCT_DEFAULTS for every field left out. The schema's bounds are the
 * page schema's bounds in the caller's units, so the result always passes productFiltersSchema.
 */
export function toProductFilters(input: ProductSearchInput): ProductFilters {
  const f: NonNullable<ProductSearchInput['filters']> = input.filters ?? {};
  return {
    age: f.listedWithinDays ?? PRODUCT_DEFAULTS.age,
    soldMin: f.monthlySoldMin ?? PRODUCT_DEFAULTS.soldMin,
    reviewsMax: f.reviewsMax ?? PRODUCT_DEFAULTS.reviewsMax,
    ratingMin: starsToX10(f.ratingMin) ?? PRODUCT_DEFAULTS.ratingMin,
    ratingMax: starsToX10(f.ratingMax) ?? PRODUCT_DEFAULTS.ratingMax,
    priceMinCents: dollarsToCents(f.priceMin) ?? PRODUCT_DEFAULTS.priceMinCents,
    priceMaxCents: dollarsToCents(f.priceMax) ?? PRODUCT_DEFAULTS.priceMaxCents,
    bsrMin: f.bsrMin ?? PRODUCT_DEFAULTS.bsrMin,
    bsrMax: f.bsrMax ?? PRODUCT_DEFAULTS.bsrMax,
    ratioMax: f.bsrRatioMax ?? PRODUCT_DEFAULTS.ratioMax,
    cat: f.categoryPath ?? PRODUCT_DEFAULTS.cat,
    fba: f.fba ?? PRODUCT_DEFAULTS.fba,
    amazon: f.amazonSelling ?? PRODUCT_DEFAULTS.amazon,
    sort: input.sort ?? PRODUCT_DEFAULTS.sort,
    dir: input.dir ?? PRODUCT_DEFAULTS.dir,
    page: input.page ?? PRODUCT_DEFAULTS.page,
  };
}

/** get_product_details' input: one ASIN, exactly as the catalog stores it. */
export const productDetailsInputSchema = z.strictObject({
  asin: z.string().regex(ASIN_PATTERN, 'an ASIN is 10 capital letters or digits').describe("The product's 10-character ASIN in capitals (B0…), as search_products returns it."),
});
export type ProductDetailsInput = z.infer<typeof productDetailsInputSchema>;

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
  kind: TotalMatchesKind;
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
  appliedFields: Array<keyof Filters | 'sort' | 'comparisonWindow'>;
  overriddenFields: Array<keyof Filters | 'sort' | 'comparisonWindow'>;
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
  /** The Explorer opened with this search's filters, sort and window (spec 2026-09-30 §3.2, §5), or null when the link would exceed the URL cap (§5.6). */
  explorerUrl: string | null;
  /** What the link could not carry, or why it is null; empty when the link is exact. */
  explorerNotes: string[];
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
  /**
   * Mirrors `EnrichedProduct['enrichmentStatus']` (lib/explorer/fetchKeywordDetail.ts),
   * inlined rather than imported so this pure output-contracts module stays free of a
   * dependency on that page-data-fetching module; null when the slot has no ASIN or the ASIN
   * was never enriched (details.ts's `toProductSlots`).
   */
  enrichmentStatus: 'active' | 'no_price' | 'delisted' | 'error' | null;
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
  presets: Array<{ id: PresetId; description: string; filters: Partial<Filters>; sort?: Sort; comparisonWindow?: Window }>;
  sorts: readonly SortField[];
  windows: readonly Window[];
  /** The sort the catalog applies when neither the request nor an applied preset supplies one (lib/research/catalog.ts). A fresh copy, never the frozen DEFAULT_SORT singleton. */
  defaultSort: Sort;
  categoryRules: string[];
  populationRules: string[];
  /** How presets interact with explicit request fields and with each other (parent §8.2). */
  presetRules: string[];
  limits: Pick<
    ResearchLimits,
    | 'pageSizeDefault'
    | 'pageSizeMax'
    | 'maxRowsPerSearch'
    | 'cursorTtlSeconds'
    | 'categoryCandidatesMax'
    | 'maxExpandedLeaves'
    | 'historyWeeksMax'
    | 'requestsPerMinute'
    | 'rowsPerMinute'
    | 'maxPayloadBytes'
  >;
  pagination: string;
  errorCodes: string[];
  /** Present only on a channel with the workspace (write) tools — the MCP with MCP_WRITE_ENABLED (spec 2026-09-30 §9.1). */
  workspace?: {
    rules: string[];
    caps: { savedViews: number; customCategories: number; watchedKeywords: number; leavesPerCategory: number; writesPerDay: number };
  };
}

// ---------------------------------------------------------------------------
// Output shapes of the two admin-only products tools (spec 2026-10-09 §9), search_products and
// get_product_details, built in ./products.ts. They extend the Products page's own loader shapes
// (lib/products/*, type-only imports), so the page and the tools never describe a product
// differently: prices in cents, ratings in stars × 10, dates YYYY-MM-DD, fetch times ISO 8601.
// ---------------------------------------------------------------------------

/** One search_products row: the Products page's result row plus its ASIN page link. */
export type ProductSummary = ProductSummaryRow & { url: string };
export interface ProductSearchResponse {
  schemaVersion: 1;
  products: ProductSummary[];
  /** search_keywords' totalMatches vocabulary: exact up to the page's count cap, then at_least that cap (one count read, so never 'unknown'). */
  total: { kind: Extract<TotalMatchesKind, 'exact' | 'at_least'>; value: number };
  page: number;
  pageSize: number;
  /** Always true while the products tools are admin-only (spec 2026-10-09 §10). */
  adminOnly: true;
}
/** One Keepa snapshot of the product (lib/products/loadProductHistory.ts), named apart from the keyword HistoryPoint above. */
export type ProductHistoryPoint = SnapshotHistoryPoint;
/** One keyword the product is a top-3 clicked product for this week, plus that keyword's Explorer page link. */
export type ProductKeyword = ProductKeywordRow & { keywordUrl: string };
export interface ProductDetailsResponse {
  schemaVersion: 1;
  /** The ASIN page's facts plus its link. inCatalog false: the keyword tables know the ASIN but the catalog has no row, so every fact is null. */
  product: CatalogProductFacts & { url: string };
  /**
   * points: the newest PRODUCT_TOOL_HISTORY_POINTS snapshots (./products.ts), oldest first. first and last: the oldest and newest
   * snapshot of the whole window the loader read (up to PRODUCT_HISTORY_CAP, lib/products/loadProductHistory.ts), for a
   * then-and-now; pointsTotal counts that window. No points, first and last null and pointsTotal 0 when there are none (always
   * for inCatalog false or a product never fetched).
   */
  history: { points: ProductHistoryPoint[]; first: ProductHistoryPoint | null; last: ProductHistoryPoint | null; pointsTotal: number };
  /** Best keyword rank first, capped at PRODUCT_TOOL_KEYWORDS_CAP (./products.ts); keywordsTotal counts every one. */
  keywords: ProductKeyword[];
  keywordsTotal: number;
}
