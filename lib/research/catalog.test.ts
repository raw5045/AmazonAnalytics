import { describe, it, expect, vi } from 'vitest';
// DEFAULT_LIMITS lives in limits.ts alongside researchLimits(), which imports the real
// @/lib/env — evaluating that module eagerly parses process.env and throws when the
// NEXT_PUBLIC_* vars it requires aren't set. Every other test file whose import graph
// reaches @/lib/env mocks it the same way (see lib/research/limits.test.ts); this file
// only needs the static DEFAULT_LIMITS constant, so an empty env is enough.
vi.mock('@/lib/env', () => ({ env: {} }));
import { applyPresets, PRESETS, buildGuide, CATALOG_VERSION } from './catalog';
import { searchRequestSchema } from './contracts';
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
  it('growing_4w sets movement, sort and window, and yields to an explicit sort', () => {
    const grown = applyPresets(req({ presetIds: ['growing_4w_v1'] }));
    expect(grown.filters.movement).toEqual({ window: '4w', metric: 'volume', prior: null, current: null, delta: { gt: 0 }, baseline: 'observed_only' });
    expect(grown.sort).toEqual({ field: 'volumeDelta', direction: 'desc' });
    expect(grown.comparisonWindow).toBe('4w');
    const explicit = applyPresets(req({ presetIds: ['growing_4w_v1'], sort: { field: 'rank', direction: 'asc' } }));
    expect(explicit.sort).toEqual({ field: 'rank', direction: 'asc' });
  });
  it('rejects a preset that conflicts with an explicit movement of another window', () => {
    expect(() => applyPresets(req({ presetIds: ['growing_4w_v1'], filters: { movement: { window: '13w', metric: 'volume', delta: { gt: 0 } } } }))).toThrow(/growing_4w_v1/);
  });
  it('no presets: filters pass through untouched, window defaults to 4w', () => {
    const out = applyPresets(req({ filters: { rank: { lte: 100 } } }));
    expect(out.filters.rank).toEqual({ lte: 100 });
    expect(out.applications).toEqual([]);
    expect(out.comparisonWindow).toBe('4w');
  });
});

describe('buildGuide', () => {
  it('describes every preset with its exact thresholds and the live-pagination rule', () => {
    const g = buildGuide({ datasetWeek: '2026-09-12', audience: 'admin', limits: DEFAULT_LIMITS });
    expect(g.catalogVersion).toBe(CATALOG_VERSION);
    expect(g.presets.map((p) => p.id)).toEqual(Object.keys(PRESETS));
    expect(g.presets.find((p) => p.id === 'high_demand_v1')?.filters).toEqual({ estimatedMonthlySearches: { gte: 10000 } });
    expect(g.pagination).toMatch(/live/i);
    expect(g.limits.maxRowsPerSearch).toBe(1000);
    expect(JSON.stringify(g)).not.toMatch(/@/);
  });
});
