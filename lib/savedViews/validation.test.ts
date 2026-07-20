import { describe, it, expect } from 'vitest';
import { normalizeFilters, normalizeFiltersBlob } from './validation';
import { EXPLORER_DEFAULTS } from '@/lib/explorer/parseFilters';

describe('normalizeFilters + normalizeFiltersBlob', () => {
  it('round-trips jumpMetric and ignores removed volume params', () => {
    // volume CUSTOM jump — the case where metric can't be inferred from a preset
    const serialized = normalizeFilters({
      ...EXPLORER_DEFAULTS,
      jump: 'custom',
      jumpMetric: 'volume',
      jumpFrom: 5000,
      jumpTo: 15000,
    });
    const back = normalizeFiltersBlob(serialized);
    expect(back.jumpMetric).toBe('volume');

    // a volume PRESET round-trips too
    const back2 = normalizeFiltersBlob(
      normalizeFilters({ ...EXPLORER_DEFAULTS, jump: 'v15k_to_30k', jumpMetric: 'volume' }),
    );
    expect(back2.jumpMetric).toBe('volume');
    expect(back2.jump).toBe('v15k_to_30k');

    // legacy stored volume params must not throw
    expect(() =>
      normalizeFiltersBlob({
        ...EXPLORER_DEFAULTS,
        vol_4w_min: 1000,
        vol_4w_max: 50000,
        jump: null,
      }),
    ).not.toThrow();
  });

  it('defaults jumpMetric to rank when absent from blob', () => {
    const result = normalizeFiltersBlob({ ...EXPLORER_DEFAULTS });
    expect(result.jumpMetric).toBe('rank');
  });

  it('infers jumpMetric=volume from a volume preset id even without stored jumpMetric', () => {
    const result = normalizeFiltersBlob({ ...EXPLORER_DEFAULTS, jump: 'v5k_to_15k' });
    expect(result.jumpMetric).toBe('volume');
    expect(result.jump).toBe('v5k_to_15k');
  });

  it('infers jumpMetric=rank from a rank preset id', () => {
    const result = normalizeFiltersBlob({ ...EXPLORER_DEFAULTS, jump: '100k_to_10k' });
    expect(result.jumpMetric).toBe('rank');
  });

  it('filtersToSearchParams emits jump_metric=volume only for volume', () => {
    // volume custom: normalizeFilters (which calls filtersToSearchParams internally)
    // must preserve jumpMetric='volume' through the URL-param round-trip
    const out = normalizeFilters({
      ...EXPLORER_DEFAULTS,
      jump: 'custom',
      jumpMetric: 'volume',
      jumpFrom: 5000,
      jumpTo: 15000,
    });
    expect(out.jumpMetric).toBe('volume');

    // rank: no emission needed, default is rank
    const outRank = normalizeFilters({
      ...EXPLORER_DEFAULTS,
      jump: 'custom',
      jumpMetric: 'rank',
      jumpFrom: 50000,
      jumpTo: 10000,
    });
    expect(outRank.jumpMetric).toBe('rank');
  });

  it('round-trips customCategoryIds through the blob (normalizeFiltersBlob)', () => {
    expect(normalizeFiltersBlob({ customCategoryIds: ['id-1', 'id-2'] }).customCategoryIds).toEqual(['id-1', 'id-2']);
  });
  it('round-trips customCategoryIds through normalizeFilters (custom param serialize→parse)', () => {
    expect(normalizeFilters({ customCategoryIds: ['id-1', 'id-2'] }).customCategoryIds).toEqual(['id-1', 'id-2']);
  });
});

describe('avg-reviews filter round-trip', () => {
  it('normalizeFilters preserves reviews bounds through the URL-param round-trip', () => {
    const out = normalizeFilters({ ...EXPLORER_DEFAULTS, reviewsMin: 100, reviewsMax: 500 });
    expect(out.reviewsMin).toBe(100);
    expect(out.reviewsMax).toBe(500);
  });

  it('round-trips a 0 bound (typeof-number check, not truthiness)', () => {
    const out = normalizeFilters({ ...EXPLORER_DEFAULTS, reviewsMax: 0 });
    expect(out.reviewsMax).toBe(0);
  });

  it('normalizeFiltersBlob reads stored bounds and defaults legacy blobs to null', () => {
    expect(normalizeFiltersBlob({ reviewsMin: 250 }).reviewsMin).toBe(250);
    expect(normalizeFiltersBlob({ reviewsMax: 0 }).reviewsMax).toBe(0);
    const legacy = normalizeFiltersBlob({ window: '4w' });
    expect(legacy.reviewsMin).toBeNull();
    expect(legacy.reviewsMax).toBeNull();
  });
});
