import type { Filters, GuideResponse, PresetApplication, PresetId, SearchRequest, Sort, Window } from './contracts';
import { SORT_FIELDS, WINDOWS } from './contracts';
import { ResearchError } from './errors';
import type { ResearchLimits } from './limits';

export const CATALOG_VERSION = 1;
export const GUIDE_VERSION = 1;
export const QUERY_VERSION = 1;

interface PresetDefinition {
  description: string;
  filters: Partial<Filters>;
  sort?: Sort;
  comparisonWindow?: Window;
}

/** Beta catalog defaults (parent §7). Each application records the exact fields it set, so a later catalog change cannot reinterpret an old search. */
export const PRESETS: Record<PresetId, PresetDefinition> = {
  high_demand_v1: { description: 'At least 10,000 estimated monthly searches.', filters: { estimatedMonthlySearches: { gte: 10000 } } },
  low_review_competition_v1: { description: 'Fewer than 500 average reviews across the top three clicked products — a limited proxy for competition.', filters: { averageReviews: { lt: 500 } } },
  growing_4w_v1: {
    description: 'Estimated volume grew over the last 4 weeks (observed baseline only), sorted by absolute volume change.',
    filters: { movement: { window: '4w', metric: 'volume', prior: null, current: null, delta: { gt: 0 }, baseline: 'observed_only' } },
    sort: { field: 'volumeDelta', direction: 'desc' },
    comparisonWindow: '4w',
  },
  title_gap_loose_any_v1: { description: 'Any of the top three clicked product titles lacks the keyword (loose matching).', filters: { titleGap: { slots: [1, 2, 3], quantifier: 'any', mode: 'loose' } } },
};

const FILTER_DEFAULTS: Record<string, unknown> = {
  text: null, estimatedMonthlySearches: null, averageReviews: null, rank: null, wordCount: null,
  categories: { selections: [], leafPaths: [] }, broadCategory: null, severities: ['none', 'warning'], titleGap: null, movement: null,
};
const SORT_DEFAULT: Sort = { field: 'estimatedMonthlySearches', direction: 'desc' };

function isExplicit(filters: Filters, field: keyof Filters): boolean {
  return JSON.stringify(filters[field]) !== JSON.stringify(FILTER_DEFAULTS[field]);
}

/** Expand declared presets, let explicit values win, reject conflicts (parent §8.2). */
export function applyPresets(request: SearchRequest): { filters: Filters; sort: Sort; comparisonWindow: Window; applications: PresetApplication[] } {
  const filters: Filters = { ...request.filters };
  let sort: Sort = request.sort;
  const explicitSort = JSON.stringify(request.sort) !== JSON.stringify(SORT_DEFAULT);
  let comparisonWindow: Window | undefined = request.comparisonWindow ?? undefined;
  const applications: PresetApplication[] = [];
  for (const presetId of request.presetIds) {
    const def = PRESETS[presetId];
    const app: PresetApplication = { presetId, appliedFields: [], overriddenFields: [] };
    for (const [field, value] of Object.entries(def.filters) as Array<[keyof Filters, Filters[keyof Filters]]>) {
      if (isExplicit(request.filters, field)) {
        if (field === 'movement' && request.filters.movement && def.filters.movement && request.filters.movement.window !== def.filters.movement.window) {
          throw new ResearchError('INVALID_FILTERS', `Preset ${presetId} uses the ${def.filters.movement.window} window but the explicit movement filter uses ${request.filters.movement.window}. Drop the preset or align the window.`, { details: [{ path: 'presetIds', message: 'conflicts with filters.movement.window' }] });
        }
        app.overriddenFields.push(field);
      } else {
        // structuredClone: def.filters values live on the shared PRESETS constant, reused by
        // every call for this preset. Without cloning, `filters` (and the response built from
        // it) would alias that shared object graph, so a downstream mutation on one request's
        // result could leak into every other request that ever applies this preset again. See
        // contracts.test.ts's "gives each parse its own categories arrays, not a shared
        // default" for the same concern applied to schema defaults.
        (filters as Record<string, unknown>)[field] = structuredClone(value);
        app.appliedFields.push(field);
      }
    }
    if (def.sort && !explicitSort) sort = { ...def.sort };
    if (def.comparisonWindow && !comparisonWindow) comparisonWindow = def.comparisonWindow;
    applications.push(app);
  }
  const effectiveWindow: Window = comparisonWindow ?? filters.movement?.window ?? '4w';
  if (filters.movement && filters.movement.window !== effectiveWindow) {
    throw new ResearchError('INVALID_FILTERS', 'comparisonWindow must equal movement.window.', { details: [{ path: 'comparisonWindow', message: 'window mismatch' }] });
  }
  return { filters, sort, comparisonWindow: effectiveWindow, applications };
}

export const METRIC_DEFINITIONS: Array<{ name: string; definition: string }> = [
  { name: 'estimatedMonthlySearches', definition: 'Estimated monthly Amazon searches derived from the search-frequency rank and a calibration fit; an estimate, not a measured count. Null when no fit existed at refresh.' },
  { name: 'rank', definition: 'Amazon search-frequency rank for the current dataset week; lower is better. Not a product position.' },
  { name: 'averageReviews', definition: 'Stored integer average of review counts over the observed top three clicked products; null when unobserved. Unknown never means zero.' },
  { name: 'wordCount', definition: 'Words in the normalized keyword (hyphenated terms count once).' },
  { name: 'volumeDelta', definition: 'estimatedMonthlySearches minus the prior-window estimate; a missing prior rank uses a zero baseline only when baseline=include_not_observed and is labelled not_observed.' },
  { name: 'categoryPath', definition: 'Full Keepa category path of the most-clicked product: a proxy for the keyword niche, not proof every product is in it.' },
  { name: 'severity', definition: 'Fake-volume indicator: none, warning, critical, or null (never evaluated). Indicators, not proof.' },
];

export function buildGuide(ctx: { datasetWeek: string | null; audience: 'admin' | 'all'; limits: ResearchLimits }): GuideResponse {
  return {
    guideVersion: GUIDE_VERSION,
    schemaVersion: 1,
    catalogVersion: CATALOG_VERSION,
    datasetWeek: ctx.datasetWeek,
    audience: ctx.audience,
    metrics: METRIC_DEFINITIONS,
    presets: (Object.keys(PRESETS) as PresetId[]).map((id) => ({
      id,
      description: PRESETS[id].description,
      filters: PRESETS[id].filters,
      ...(PRESETS[id].sort ? { sort: PRESETS[id].sort } : {}),
    })),
    sorts: SORT_FIELDS,
    windows: WINDOWS,
    categoryRules: [
      'Resolve category words with resolve_categories first; pass the returned selection objects to search_keywords.',
      'Several categories combine with OR; every other filter combines with AND.',
      'Broad words like "lighting" span materially different branches (household lamps, outdoor, seasonal, studio); ask the person which before searching.',
      'Custom categories belong to the connected account and are referenced by id.',
    ],
    populationRules: [
      'Search covers keywords seen within 28 days of the dataset week; "current" does not guarantee observation in the latest week.',
      'Comparators are exact: gt 10000 excludes exactly 10000.',
      'Any bound on a metric excludes rows where that metric is null.',
      'Counts above 10,000 are reported as at_least; never claim a capped result is everything.',
    ],
    limits: {
      pageSizeDefault: ctx.limits.pageSizeDefault,
      pageSizeMax: ctx.limits.pageSizeMax,
      maxRowsPerSearch: ctx.limits.maxRowsPerSearch,
      cursorTtlSeconds: ctx.limits.cursorTtlSeconds,
      categoryCandidatesMax: ctx.limits.categoryCandidatesMax,
      maxExpandedLeaves: ctx.limits.maxExpandedLeaves,
      historyWeeksMax: ctx.limits.historyWeeksMax,
      requestsPerMinute: ctx.limits.requestsPerMinute,
    },
    pagination: 'Pages are computed live from a signed cursor: continue with {cursor} only. A weekly data refresh expires cursors (SEARCH_EXPIRED); a mid-week product sync can shift a review-sorted page by a few rows.',
    errorCodes: ['INVALID_FILTERS', 'UNSUPPORTED_FILTER', 'CATEGORY_NOT_AVAILABLE', 'KEYWORD_NOT_FOUND', 'SEARCH_EXPIRED', 'INVALID_CURSOR', 'RESPONSE_TOO_LARGE', 'RATE_LIMITED', 'QUERY_TIMEOUT', 'HISTORY_UNAVAILABLE', 'DATA_UNAVAILABLE'],
  };
}
