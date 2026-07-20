import { describe, expect, it } from 'vitest';
import { probeLevelDelta, LEVEL_DELTA_PROBES, withUltraHeadSegment } from './fitOrchestrator';
import { predictVolumeFromFit, type PiecewiseFit } from '@/lib/analytics/volumeModel';

const fit = (scale: number): PiecewiseFit => ({
  breakpoints: [1000, 10000, 100000],
  segments: [
    { beta: 0.4, scaleFactor: scale },
    { beta: 0.8, scaleFactor: scale * 2 },
    { beta: 1.0, scaleFactor: scale * 5 },
    { beta: 1.2, scaleFactor: scale * 20 },
  ],
});

describe('probeLevelDelta', () => {
  it('reports ~0.5 in every band when the new fit halves every scale factor', () => {
    const d = probeLevelDelta(fit(1_000_000), fit(2_000_000));
    expect(d.top1k).toBeCloseTo(0.5, 5);
    expect(d.rank1kTo10k).toBeCloseTo(0.5, 5);
    expect(d.rank10kTo100k).toBeCloseTo(0.5, 5);
    expect(d.above100k).toBeCloseTo(0.5, 5);
  });

  it('probe ranks land in their own bands', () => {
    expect(Math.max(...LEVEL_DELTA_PROBES.top1k)).toBeLessThanOrEqual(1_000);
    expect(LEVEL_DELTA_PROBES.rank1kTo10k[0]).toBeGreaterThan(1_000);
    expect(LEVEL_DELTA_PROBES.above100k[0]).toBeGreaterThan(100_000);
  });
});

describe('implied rank-1 volume', () => {
  it('equals the head segment scale factor (A · 1^−β = A)', () => {
    expect(predictVolumeFromFit(1, fit(3_459_791))).toBeCloseTo(3_459_791, 3);
  });
});

describe('withUltraHeadSegment', () => {
  const base: PiecewiseFit = {
    breakpoints: [1000, 10000, 100000],
    segments: [
      { beta: 0.425, scaleFactor: 6_844_524 },
      { beta: 0.8, scaleFactor: 20_000_000 },
      { beta: 1.0, scaleFactor: 80_000_000 },
      { beta: 1.2, scaleFactor: 300_000_000 },
    ],
  };

  it('is continuous at the anchor and flatter above it', () => {
    const damped = withUltraHeadSegment(base, 15, 0.3);
    expect(predictVolumeFromFit(15, damped)).toBeCloseTo(predictVolumeFromFit(15, base), 6);
    expect(predictVolumeFromFit(1, damped)).toBeCloseTo(predictVolumeFromFit(15, base) * Math.pow(15, 0.3), 3);
    expect(predictVolumeFromFit(1, damped)).toBeLessThan(predictVolumeFromFit(1, base));
  });

  it('leaves ranks beyond the anchor untouched', () => {
    const damped = withUltraHeadSegment(base, 15, 0.3);
    for (const r of [16, 500, 5_000, 50_000, 500_000]) {
      expect(predictVolumeFromFit(r, damped)).toBeCloseTo(predictVolumeFromFit(r, base), 6);
    }
  });

  it('no-ops on null beta or anchor rank ≤ 1', () => {
    expect(withUltraHeadSegment(base, 15, null)).toBe(base);
    expect(withUltraHeadSegment(base, 1, 0.3)).toBe(base);
  });

  it('no-ops when the anchor sits at or beyond the first breakpoint (would unsort breakpoints)', () => {
    expect(withUltraHeadSegment(base, 1500, 0.3)).toBe(base);
  });

  it('keeps breakpoints sorted ascending', () => {
    const damped = withUltraHeadSegment(base, 15, 0.3);
    expect(damped.breakpoints).toEqual([15, 1000, 10000, 100000]);
  });
});
