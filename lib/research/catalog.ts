import { isDeepStrictEqual } from 'node:util';
import { COUNT_CAP } from '@/lib/explorer/buildQuery';
import type { Filters, GuideResponse, PresetApplication, PresetId, SearchRequest, Sort, Window } from './contracts';
import { DEFAULT_SORT, filtersSchema, SCHEMA_VERSION, SORT_FIELDS, WINDOWS } from './contracts';
import { RESEARCH_ERROR_CODES, ResearchError } from './errors';
import type { ResearchLimits } from './limits';

export const CATALOG_VERSION = 1;
export const GUIDE_VERSION = 1;
export const QUERY_VERSION = 1;

export interface PresetDefinition {
  description: string;
  filters: Partial<Filters>;
  sort?: Sort;
  comparisonWindow?: Window;
}

/**
 * Recursively freezes an object graph. Used once, at module load, on PRESETS: the catalog is a
 * process-wide singleton reused by every request, so nothing reached through it may ever be
 * mutated in place. applyPresetDefinitions never hands out a frozen value, though — it
 * structuredClone's every filter value and shallow-copies every sort it lifts out of a preset,
 * so the per-request result is ordinary, mutable data (deepFreeze protects the shared catalog,
 * not the response).
 */
function deepFreeze<T>(value: T): T {
  if (value !== null && (typeof value === 'object' || typeof value === 'function') && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const prop of Object.values(value as Record<string, unknown>)) deepFreeze(prop);
  }
  return value;
}

/** Beta catalog defaults (parent §7). Each application records the exact fields it set, so a later catalog change cannot reinterpret an old search. Frozen at load (see deepFreeze) since PRESETS is shared across every request this process ever handles. */
export const PRESETS: Record<PresetId, PresetDefinition> = deepFreeze({
  high_demand_v1: { description: 'At least 10,000 estimated monthly searches.', filters: { estimatedMonthlySearches: { gte: 10000 } } },
  low_review_competition_v1: { description: 'Fewer than 500 average reviews across the top three clicked products — a limited proxy for competition.', filters: { averageReviews: { lt: 500 } } },
  growing_4w_v1: {
    description: 'Estimated volume grew over the last 4 weeks (observed baseline only), sorted by absolute volume change.',
    filters: { movement: { window: '4w', metric: 'volume', prior: null, current: null, delta: { gt: 0 }, baseline: 'observed_only' } },
    sort: { field: 'volumeDelta', direction: 'desc' },
    comparisonWindow: '4w',
  },
  title_gap_loose_any_v1: { description: 'Any of the top three clicked product titles lacks the keyword (loose matching).', filters: { titleGap: { slots: [1, 2, 3], quantifier: 'any', mode: 'loose' } } },
});

/**
 * Every filter field at its schema default — the baseline isExplicit compares a request against
 * to decide whether the caller actually supplied a value. Derived from filtersSchema itself
 * (rather than hand-duplicated) so a schema default change can never silently drift out of sync
 * with preset expansion.
 */
const FILTER_DEFAULTS: Filters = filtersSchema.parse({});

function isExplicit(filters: Filters, field: keyof Filters): boolean {
  return !isDeepStrictEqual(filters[field], FILTER_DEFAULTS[field]);
}

/** The value `def` contributes for `field` — a filter field, or the synthetic 'sort' / 'comparisonWindow' fields. */
function presetFieldValue(def: PresetDefinition, field: string): unknown {
  if (field === 'sort') return def.sort;
  if (field === 'comparisonWindow') return def.comparisonWindow;
  return def.filters[field as keyof Filters];
}

/**
 * Records that `presetId` would set `field`, and throws INVALID_FILTERS if an earlier preset in
 * this same expansion already set that field to a different (non-deep-equal) value — two presets
 * silently disagreeing on a field would otherwise let iteration order pick a winner with no
 * signal to the caller. Two presets contributing deep-equal values are not a conflict (both
 * simply report the field applied, same as an explicit value that happens to match a preset).
 * This check runs before the request's own explicit value (if any) for the field is considered,
 * so an explicit override on the contested field never rescues a preset-vs-preset conflict.
 */
function noteSetBy(setBy: Map<string, PresetId>, definitions: Record<PresetId, PresetDefinition>, field: string, presetId: PresetId): void {
  const priorId = setBy.get(field);
  if (priorId === undefined) {
    setBy.set(field, presetId);
    return;
  }
  const priorValue = presetFieldValue(definitions[priorId], field);
  const currentValue = presetFieldValue(definitions[presetId], field);
  if (!isDeepStrictEqual(priorValue, currentValue)) {
    throw new ResearchError('INVALID_FILTERS', `Presets ${priorId} and ${presetId} both set ${field}; use one of them.`, {
      details: [{ path: 'presetIds', message: `${priorId} and ${presetId} both set ${field}` }],
    });
  }
}

export interface PresetExpansion {
  filters: Filters;
  sort: Sort;
  comparisonWindow: Window;
  applications: PresetApplication[];
}

/**
 * Expand `definitions` against `request` (parent §8.2): a preset supplies a field only when the
 * request leaves it at the schema default; an explicit request value always wins and is reported
 * (Q12) — unless it deep-equals the preset's own value, which counts as applied rather than
 * overridden, since nothing was actually overridden. A preset may also supply `sort` and
 * `comparisonWindow`; the same explicit-wins-and-is-reported rule applies to those, tracked
 * against each preset's own PresetApplication. Two presets that would set the same field
 * (including sort/comparisonWindow) to different values are rejected before either takes effect.
 *
 * Exported separately from applyPresets (rather than inlined) so tests can exercise
 * preset-vs-preset conflicts with a synthetic `definitions` map, without needing a real
 * conflicting pair in the shipped catalog — PRESETS' filter fields are pairwise disjoint and at
 * most one preset defines sort, by design (see catalog.test.ts's invariant check).
 */
export function applyPresetDefinitions(request: SearchRequest, definitions: Record<PresetId, PresetDefinition>): PresetExpansion {
  const filters: Filters = { ...request.filters };
  const explicitSort = request.sort !== undefined;
  const explicitWindow = request.comparisonWindow !== null;
  const applications: PresetApplication[] = [];
  const setBy = new Map<string, PresetId>();
  let presetSort: Sort | undefined;
  let presetSortApp: PresetApplication | undefined;
  let presetWindow: Window | undefined;
  let presetWindowApp: PresetApplication | undefined;
  let movementPresetId: PresetId | undefined;

  for (const presetId of request.presetIds) {
    const def = definitions[presetId];
    const app: PresetApplication = { presetId, appliedFields: [], overriddenFields: [] };
    applications.push(app);

    for (const [field, value] of Object.entries(def.filters) as Array<[keyof Filters, Filters[keyof Filters]]>) {
      noteSetBy(setBy, definitions, field, presetId);
      const explicitField = isExplicit(request.filters, field);
      const equalsPreset = explicitField && isDeepStrictEqual(request.filters[field], value);
      if (explicitField && !equalsPreset) {
        if (field === 'movement' && request.filters.movement && def.filters.movement && request.filters.movement.window !== def.filters.movement.window) {
          throw new ResearchError(
            'INVALID_FILTERS',
            `Preset ${presetId} uses the ${def.filters.movement.window} window but the explicit movement filter uses ${request.filters.movement.window}. Drop the preset or align the window.`,
            { details: [{ path: 'presetIds', message: 'conflicts with filters.movement.window' }] },
          );
        }
        app.overriddenFields.push(field);
        continue;
      }
      if (!explicitField) {
        // structuredClone: def.filters values live on the shared PRESETS constant (frozen, and
        // reused by every call for this preset). Without cloning, `filters` (and the response
        // built from it) would alias that shared object graph, so a downstream mutation on one
        // request's result could leak into every other request that ever applies this preset
        // again. See contracts.test.ts's "gives each parse its own categories arrays, not a
        // shared default" for the same concern applied to schema defaults.
        (filters as Record<string, unknown>)[field] = structuredClone(value);
      }
      app.appliedFields.push(field);
      if (field === 'movement') movementPresetId = presetId;
    }

    if (def.sort) {
      noteSetBy(setBy, definitions, 'sort', presetId);
      presetSort = { ...def.sort };
      presetSortApp = app;
    }
    if (def.comparisonWindow) {
      noteSetBy(setBy, definitions, 'comparisonWindow', presetId);
      presetWindow = def.comparisonWindow;
      presetWindowApp = app;
    }
  }

  // An explicit sort/window that deep-equals the preset's own value counts as applied, not
  // overridden — nothing was actually overridden (parent §8.2, Q12). Only a genuinely
  // different explicit value is a true override.
  const sortOverridden = explicitSort && !isDeepStrictEqual(request.sort, presetSort);
  const windowOverridden = explicitWindow && request.comparisonWindow !== presetWindow;
  if (presetSortApp) presetSortApp[sortOverridden ? 'overriddenFields' : 'appliedFields'].push('sort');
  if (presetWindowApp) presetWindowApp[windowOverridden ? 'overriddenFields' : 'appliedFields'].push('comparisonWindow');

  // Spread, never hand out the frozen DEFAULT_SORT singleton itself: a caller that mutates
  // `effectiveSort`/`out.sort` on its own response must never be able to corrupt the shared
  // fallback every other request relies on.
  const sort: Sort = request.sort ?? presetSort ?? { ...DEFAULT_SORT };
  const comparisonWindow: Window | undefined = request.comparisonWindow ?? presetWindow ?? undefined;
  const effectiveWindow: Window = comparisonWindow ?? filters.movement?.window ?? '4w';
  if (filters.movement && filters.movement.window !== effectiveWindow) {
    const message = movementPresetId
      ? `Preset ${movementPresetId} uses the ${filters.movement.window} window but comparisonWindow is ${effectiveWindow}.`
      : 'comparisonWindow must equal movement.window.';
    throw new ResearchError('INVALID_FILTERS', message, { details: [{ path: 'comparisonWindow', message: 'window mismatch' }] });
  }
  return { filters, sort, comparisonWindow: effectiveWindow, applications };
}

/** Expand declared presets, let explicit values win, reject conflicts (parent §8.2). */
export function applyPresets(request: SearchRequest): PresetExpansion {
  return applyPresetDefinitions(request, PRESETS);
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
    schemaVersion: SCHEMA_VERSION,
    catalogVersion: CATALOG_VERSION,
    datasetWeek: ctx.datasetWeek,
    audience: ctx.audience,
    metrics: METRIC_DEFINITIONS,
    presets: (Object.keys(PRESETS) as PresetId[]).map((id) => ({
      id,
      description: PRESETS[id].description,
      filters: PRESETS[id].filters,
      ...(PRESETS[id].sort ? { sort: PRESETS[id].sort } : {}),
      ...(PRESETS[id].comparisonWindow ? { comparisonWindow: PRESETS[id].comparisonWindow } : {}),
    })),
    sorts: SORT_FIELDS,
    windows: WINDOWS,
    defaultSort: { ...DEFAULT_SORT },
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
      `Counts above ${COUNT_CAP.toLocaleString('en-US')} are reported as at_least; never claim a capped result is everything.`,
    ],
    presetRules: [
      'A preset expands to explicit filters first; a filter you pass on the same field replaces the preset value and is reported in overriddenFields (an equal value counts as applied).',
      'A preset may set sort and comparisonWindow; a sort or window you pass wins and is reported the same way. A preset sort stays in effect even if you override its filter.',
      'Two presets that set the same field differently, or a preset window that disagrees with an explicit movement window, are rejected — choose one.',
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
      rowsPerMinute: ctx.limits.rowsPerMinute,
      maxPayloadBytes: ctx.limits.maxPayloadBytes,
    },
    pagination: 'Pages are computed live from a signed cursor: continue with {cursor} only. A weekly data refresh expires cursors (SEARCH_EXPIRED); a mid-week product sync can shift a review-sorted page by a few rows.',
    errorCodes: [...RESEARCH_ERROR_CODES],
  };
}
