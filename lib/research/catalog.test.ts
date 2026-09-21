import { describe, it, expect, vi } from 'vitest';
// DEFAULT_LIMITS lives in limits.ts alongside researchLimits(), which imports the real
// @/lib/env — evaluating that module eagerly parses process.env and throws when the
// NEXT_PUBLIC_* vars it requires aren't set. Every other test file whose import graph
// reaches @/lib/env mocks it the same way (see lib/research/limits.test.ts); this file
// only needs the static DEFAULT_LIMITS constant, so an empty env is enough.
vi.mock('@/lib/env', () => ({ env: {} }));
import { applyPresets, applyPresetDefinitions, PRESETS, buildGuide, CATALOG_VERSION, METRIC_DEFINITIONS, type PresetDefinition } from './catalog';
import { searchRequestSchema, filtersSchema, DEFAULT_SORT, type PresetId } from './contracts';
import { DEFAULT_LIMITS } from './limits';

const req = (over: Record<string, unknown>) => searchRequestSchema.parse({ schemaVersion: 1, ...over });

describe('applyPresets', () => {
  it('expands high_demand + low_review_competition into explicit bounds and reports applied fields', () => {
    const out = applyPresets(req({ presetIds: ['high_demand_v1', 'low_review_competition_v1'] }));
    expect(out.filters.estimatedMonthlySearches).toEqual({ gte: 10000 });
    expect(out.filters.averageReviews).toEqual({ lt: 500 });
    expect(out.applications).toEqual([
      { presetId: 'high_demand_v1', appliedFields: ['estimatedMonthlySearches'], overriddenFields: [] },
      { presetId: 'low_review_competition_v1', appliedFields: ['averageReviews'], overriddenFields: [] },
    ]);
  });
  it('explicit filters override a preset field and the override is reported (Q12)', () => {
    const out = applyPresets(req({ presetIds: ['high_demand_v1'], filters: { estimatedMonthlySearches: { gt: 25000 } } }));
    expect(out.filters.estimatedMonthlySearches).toEqual({ gt: 25000 });
    expect(out.applications[0]).toEqual({ presetId: 'high_demand_v1', appliedFields: [], overriddenFields: ['estimatedMonthlySearches'] });
  });
  it('an explicit value that deep-equals the preset value counts as applied, not overridden', () => {
    const out = applyPresets(req({ presetIds: ['high_demand_v1'], filters: { estimatedMonthlySearches: { gte: 10000 } } }));
    expect(out.applications[0]).toEqual({ presetId: 'high_demand_v1', appliedFields: ['estimatedMonthlySearches'], overriddenFields: [] });
  });
  it('growing_4w sets movement, sort and window, and yields to an explicit sort', () => {
    const grown = applyPresets(req({ presetIds: ['growing_4w_v1'] }));
    expect(grown.filters.movement).toEqual({ window: '4w', metric: 'volume', prior: null, current: null, delta: { gt: 0 }, baseline: 'observed_only' });
    expect(grown.sort).toEqual({ field: 'volumeDelta', direction: 'desc' });
    expect(grown.comparisonWindow).toBe('4w');
    const grownApp = grown.applications.find((a) => a.presetId === 'growing_4w_v1')!;
    expect(grownApp.appliedFields).toEqual(expect.arrayContaining(['movement', 'sort', 'comparisonWindow']));
    const explicit = applyPresets(req({ presetIds: ['growing_4w_v1'], sort: { field: 'rank', direction: 'asc' } }));
    expect(explicit.sort).toEqual({ field: 'rank', direction: 'asc' });
  });
  it('an explicit sort equal to the documented default is still explicit: it overrides a preset sort and is reported', () => {
    const out = applyPresets(req({ presetIds: ['growing_4w_v1'], sort: { field: 'estimatedMonthlySearches', direction: 'desc' } }));
    expect(out.sort).toEqual({ field: 'estimatedMonthlySearches', direction: 'desc' });
    const app = out.applications.find((a) => a.presetId === 'growing_4w_v1')!;
    expect(app.overriddenFields).toContain('sort');
    expect(app.appliedFields).not.toContain('sort');
  });
  it('an explicit sort that deep-equals the preset sort counts as applied, not overridden', () => {
    const out = applyPresets(req({ presetIds: ['growing_4w_v1'], sort: { field: 'volumeDelta', direction: 'desc' } }));
    expect(out.sort).toEqual({ field: 'volumeDelta', direction: 'desc' });
    const app = out.applications.find((a) => a.presetId === 'growing_4w_v1')!;
    expect(app.appliedFields).toContain('sort');
    expect(app.overriddenFields).not.toContain('sort');
  });
  it('an explicit comparisonWindow that equals the preset window counts as applied, not overridden', () => {
    const out = applyPresets(req({ presetIds: ['growing_4w_v1'], comparisonWindow: '4w' }));
    expect(out.comparisonWindow).toBe('4w');
    const app = out.applications.find((a) => a.presetId === 'growing_4w_v1')!;
    expect(app.appliedFields).toContain('comparisonWindow');
    expect(app.overriddenFields).not.toContain('comparisonWindow');
  });
  it('rejects a preset that conflicts with an explicit movement of another window', () => {
    expect(() => applyPresets(req({ presetIds: ['growing_4w_v1'], filters: { movement: { window: '13w', metric: 'volume', delta: { gt: 0 } } } }))).toThrow(/growing_4w_v1/);
  });
  it('names the preset when an applied movement window disagrees with an explicit comparisonWindow', () => {
    expect(() => applyPresets(req({ presetIds: ['growing_4w_v1'], comparisonWindow: '13w' }))).toThrow(
      /Preset growing_4w_v1 uses the 4w window but comparisonWindow is 13w\./,
    );
  });
  it('title_gap_loose_any_v1 expands to the documented titleGap shape', () => {
    const out = applyPresets(req({ presetIds: ['title_gap_loose_any_v1'] }));
    expect(out.filters.titleGap).toEqual({ slots: [1, 2, 3], quantifier: 'any', mode: 'loose' });
  });
  it('no presets: filters pass through untouched, window defaults to 4w', () => {
    const out = applyPresets(req({ filters: { rank: { lte: 100 } } }));
    expect(out.filters.rank).toEqual({ lte: 100 });
    expect(out.applications).toEqual([]);
    expect(out.comparisonWindow).toBe('4w');
  });
  it('with no presets, comparisonWindow defaults from an explicit movement window', () => {
    const out = applyPresets(req({ filters: { movement: { window: '13w', metric: 'volume', delta: { gt: 0 } } } }));
    expect(out.comparisonWindow).toBe('13w');
  });
  it('with no presets, an explicit comparisonWindow is used as-is', () => {
    const out = applyPresets(req({ comparisonWindow: '26w' }));
    expect(out.comparisonWindow).toBe('26w');
  });
  it('never aliases the shared PRESETS object graph: mutating a result cannot affect PRESETS', () => {
    const out = applyPresets(req({ presetIds: ['high_demand_v1'] }));
    expect(out.filters.estimatedMonthlySearches).not.toBeNull();
    if (out.filters.estimatedMonthlySearches) out.filters.estimatedMonthlySearches.gte = 999999;
    expect(PRESETS.high_demand_v1.filters.estimatedMonthlySearches).toEqual({ gte: 10000 });
    expect(Object.isFrozen(PRESETS.high_demand_v1.filters)).toBe(true);
    expect(Object.isFrozen(PRESETS.high_demand_v1)).toBe(true);
  });
  it('never hands out the frozen DEFAULT_SORT singleton: with no preset sort and no explicit sort, the fallback is a fresh, mutable object', () => {
    const out = applyPresets(req({ presetIds: ['high_demand_v1'] }));
    expect(out.sort).toEqual(DEFAULT_SORT);
    expect(out.sort).not.toBe(DEFAULT_SORT);
    expect(() => {
      out.sort.direction = 'asc';
    }).not.toThrow();
    expect(Object.isFrozen(DEFAULT_SORT)).toBe(true);
  });
});

describe('PRESETS catalog invariants', () => {
  it('every preset\'s filters round-trip through filtersSchema (a partial preset is still a valid filters object)', () => {
    for (const [id, def] of Object.entries(PRESETS)) {
      const result = filtersSchema.safeParse({ ...def.filters });
      expect(result.success, `${id} filters failed filtersSchema: ${!result.success && JSON.stringify(result.error.issues)}`).toBe(true);
      // Presets are already normalized: parsing each field in isolation must yield back the
      // exact same value, with no schema default filling in anything the preset left out.
      for (const [field, value] of Object.entries(def.filters)) {
        const single = filtersSchema.safeParse({ [field]: value });
        expect((single.data as Record<string, unknown> | undefined)?.[field], `${id}.${field} did not round-trip`).toEqual(value);
      }
    }
  });
  it('preset filter fields are pairwise disjoint, and at most one preset defines sort or comparisonWindow', () => {
    const seenBy = new Map<string, string>();
    let sortCount = 0;
    let windowCount = 0;
    for (const [id, def] of Object.entries(PRESETS)) {
      for (const field of Object.keys(def.filters)) {
        expect(seenBy.has(field), `field ${field} set by both ${seenBy.get(field)} and ${id}`).toBe(false);
        seenBy.set(field, id);
      }
      if (def.sort) sortCount += 1;
      if (def.comparisonWindow) windowCount += 1;
    }
    expect(sortCount).toBeLessThanOrEqual(1);
    // noteSetBy's "both agreeing presets report the field applied" guarantee doesn't extend to
    // sort/comparisonWindow (see its docstring): only the last preset defining one of these ends
    // up reporting it, since applyPresetDefinitions overwrites presetSortApp/presetWindowApp
    // rather than accumulating them. At most one preset may define either, so that gap can never
    // actually surface.
    expect(windowCount).toBeLessThanOrEqual(1);
  });
});

describe('applyPresetDefinitions (preset-vs-preset conflicts)', () => {
  it('rejects two presets that would set the same field to different values, in either order (order-independent)', () => {
    const conflicting: Record<PresetId, PresetDefinition> = {
      ...PRESETS,
      low_review_competition_v1: { ...PRESETS.low_review_competition_v1, filters: { estimatedMonthlySearches: { gte: 5000 } } },
    };
    expect(() => applyPresetDefinitions(req({ presetIds: ['high_demand_v1', 'low_review_competition_v1'] }), conflicting)).toThrow(
      /Presets high_demand_v1 and low_review_competition_v1 both set estimatedMonthlySearches; use one of them\./,
    );
    expect(() => applyPresetDefinitions(req({ presetIds: ['low_review_competition_v1', 'high_demand_v1'] }), conflicting)).toThrow(
      /Presets low_review_competition_v1 and high_demand_v1 both set estimatedMonthlySearches; use one of them\./,
    );
  });
  it('rejects a preset-vs-preset conflict even when the caller supplies an explicit value for the contested field', () => {
    const conflicting: Record<PresetId, PresetDefinition> = {
      ...PRESETS,
      low_review_competition_v1: { ...PRESETS.low_review_competition_v1, filters: { estimatedMonthlySearches: { gte: 5000 } } },
    };
    expect(() =>
      applyPresetDefinitions(
        req({ presetIds: ['high_demand_v1', 'low_review_competition_v1'], filters: { estimatedMonthlySearches: { gte: 7000 } } }),
        conflicting,
      ),
    ).toThrow(/Presets high_demand_v1 and low_review_competition_v1 both set estimatedMonthlySearches; use one of them\./);
  });
  it('allows two presets that agree on a deep-equal value; both report the field applied', () => {
    const agreeing: Record<PresetId, PresetDefinition> = {
      ...PRESETS,
      low_review_competition_v1: { ...PRESETS.low_review_competition_v1, filters: { estimatedMonthlySearches: { gte: 10000 } } },
    };
    const out = applyPresetDefinitions(req({ presetIds: ['high_demand_v1', 'low_review_competition_v1'] }), agreeing);
    expect(out.filters.estimatedMonthlySearches).toEqual({ gte: 10000 });
    expect(out.applications.every((a) => a.appliedFields.includes('estimatedMonthlySearches'))).toBe(true);
  });
});

describe('buildGuide', () => {
  it('describes every preset with its exact thresholds and the live-pagination rule', () => {
    const g = buildGuide({ datasetWeek: '2026-09-12', audience: 'admin', limits: DEFAULT_LIMITS });
    expect(g.catalogVersion).toBe(CATALOG_VERSION);
    // Never the frozen METRIC_DEFINITIONS singleton — same reasoning as the presets/defaultSort checks below.
    expect(g.metrics).not.toBe(METRIC_DEFINITIONS);
    expect(g.metrics).toEqual(METRIC_DEFINITIONS);
    expect(g.presets.map((p) => p.id)).toEqual(Object.keys(PRESETS));
    expect(g.presets.find((p) => p.id === 'high_demand_v1')?.filters).toEqual({ estimatedMonthlySearches: { gte: 10000 } });
    // Never the frozen PRESETS singleton itself — a caller mutating its own guide response must
    // never be able to corrupt the shared catalog every other request relies on.
    expect(g.presets.find((p) => p.id === 'high_demand_v1')?.filters).not.toBe(PRESETS.high_demand_v1.filters);
    expect(g.presets.find((p) => p.id === 'growing_4w_v1')?.comparisonWindow).toBe('4w');
    expect(g.presets.find((p) => p.id === 'growing_4w_v1')?.sort).not.toBe(PRESETS.growing_4w_v1.sort);
    expect(g.defaultSort).toEqual(DEFAULT_SORT);
    expect(g.defaultSort).not.toBe(DEFAULT_SORT);
    expect(g.pagination).toMatch(/live/i);
    expect(g.limits.maxRowsPerSearch).toBe(1000);
    expect(g.limits.rowsPerMinute).toBe(DEFAULT_LIMITS.rowsPerMinute);
    expect(g.presetRules).toHaveLength(3);
    // Task 21 F1: sorting by a nullable key excludes rows without a value — the guide says so.
    expect(g.populationRules.some((r) => r.includes('excludes keywords with no value'))).toBe(true);
    expect(JSON.stringify(g)).not.toMatch(/@/);
  });
});
