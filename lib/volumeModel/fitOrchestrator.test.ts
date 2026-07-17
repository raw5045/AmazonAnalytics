import { describe, expect, it } from 'vitest';
import { probeLevelDelta, LEVEL_DELTA_PROBES } from './fitOrchestrator';
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
