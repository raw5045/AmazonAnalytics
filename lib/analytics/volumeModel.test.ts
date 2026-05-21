import { describe, it, expect } from 'vitest';
import {
  predictVolume,
  fitScaleFactorForBeta,
  logSpaceSSE,
  gridSearchBeta,
  meanAbsolutePercentageError,
  stratifiedMape,
  pickFitForWeek,
  endOfMonthIso,
  type FitParams,
} from './volumeModel';

describe('predictVolume', () => {
  it('returns scaleFactor at rank 1 (β doesnt matter when rank^0)', () => {
    expect(predictVolume(1, 0.7, 1_000_000)).toBeCloseTo(1_000_000, 0);
    expect(predictVolume(1, 1.2, 5_000_000)).toBeCloseTo(5_000_000, 0);
  });

  it('decays by the expected power law', () => {
    // β = 1.0, scaleFactor = 1,000,000 → volume(10) = 100,000
    expect(predictVolume(10, 1.0, 1_000_000)).toBeCloseTo(100_000, 0);
    // β = 0.5, scaleFactor = 1,000,000 → volume(100) = 100,000
    expect(predictVolume(100, 0.5, 1_000_000)).toBeCloseTo(100_000, 0);
  });

  it('returns 0 for invalid ranks', () => {
    expect(predictVolume(0, 0.7, 1000)).toBe(0);
    expect(predictVolume(-5, 0.7, 1000)).toBe(0);
    expect(predictVolume(NaN, 0.7, 1000)).toBe(0);
  });

  it('returns 0 for invalid β or scaleFactor', () => {
    expect(predictVolume(10, NaN, 1000)).toBe(0);
    expect(predictVolume(10, 0.7, NaN)).toBe(0);
  });
});

describe('fitScaleFactorForBeta', () => {
  it('recovers scaleFactor when data exactly matches the model', () => {
    // Generate noise-free pairs from β=0.7, A=1,000,000
    const pairs = [1, 10, 100, 1000].map((rank) => ({
      rank,
      volume: 1_000_000 * Math.pow(rank, -0.7),
    }));
    const { scaleFactor, nUsed } = fitScaleFactorForBeta(pairs, 0.7);
    expect(scaleFactor).toBeCloseTo(1_000_000, -2); // within ~100 absolute
    expect(nUsed).toBe(4);
  });

  it('skips non-positive rank or volume pairs', () => {
    const pairs = [
      { rank: 0, volume: 100 },
      { rank: -5, volume: 100 },
      { rank: 10, volume: 0 },
      { rank: 10, volume: -50 },
      { rank: 10, volume: 100_000 },
    ];
    const { nUsed } = fitScaleFactorForBeta(pairs, 0.7);
    expect(nUsed).toBe(1);
  });

  it('returns scaleFactor=0 when all pairs are invalid', () => {
    const pairs = [{ rank: 0, volume: 100 }];
    const { scaleFactor, nUsed } = fitScaleFactorForBeta(pairs, 0.7);
    expect(scaleFactor).toBe(0);
    expect(nUsed).toBe(0);
  });
});

describe('logSpaceSSE', () => {
  it('is zero for perfect fit', () => {
    const pairs = [1, 10, 100].map((rank) => ({
      rank,
      volume: 1_000_000 * Math.pow(rank, -0.7),
    }));
    const sse = logSpaceSSE(pairs, 0.7, 1_000_000);
    expect(sse).toBeLessThan(1e-10);
  });

  it('is positive for imperfect fit', () => {
    const pairs = [
      { rank: 1, volume: 1_000_000 },
      { rank: 10, volume: 100_000 },
    ];
    // Wrong β should give nonzero error
    const sse = logSpaceSSE(pairs, 0.5, 1_000_000);
    expect(sse).toBeGreaterThan(0);
  });

  it('returns Infinity if scaleFactor is non-positive', () => {
    const pairs = [{ rank: 1, volume: 1 }];
    expect(logSpaceSSE(pairs, 0.7, 0)).toBe(Infinity);
    expect(logSpaceSSE(pairs, 0.7, -1)).toBe(Infinity);
  });
});

describe('gridSearchBeta', () => {
  it('recovers the true β within step granularity on synthetic data', () => {
    const trueBeta = 0.75;
    const trueA = 2_000_000;
    const pairs = [1, 5, 10, 50, 100, 500, 1_000, 5_000, 10_000].map((rank) => ({
      rank,
      volume: trueA * Math.pow(rank, -trueBeta),
    }));
    const result = gridSearchBeta(pairs, { minBeta: 0.4, maxBeta: 1.2, step: 0.025 });
    expect(result.beta).toBeCloseTo(trueBeta, 1); // within one step (0.025)
    expect(result.scaleFactor).toBeCloseTo(trueA, -3);
    expect(result.sse).toBeLessThan(1e-6);
  });

  it('returns the searched-range value even with very noisy data', () => {
    // Heavy noise still gives a meaningful (if imperfect) β
    const pairs = [1, 10, 100, 1000].map((rank, i) => ({
      rank,
      volume: 1_000_000 * Math.pow(rank, -0.8) * [1.5, 0.7, 2.0, 0.5][i],
    }));
    const result = gridSearchBeta(pairs);
    expect(result.beta).toBeGreaterThanOrEqual(0.4);
    expect(result.beta).toBeLessThanOrEqual(1.2);
    expect(result.scaleFactor).toBeGreaterThan(0);
  });

  it('throws on invalid range/step args', () => {
    expect(() => gridSearchBeta([], { minBeta: 1.0, maxBeta: 0.5 })).toThrow();
    expect(() => gridSearchBeta([], { step: 0 })).toThrow();
    expect(() => gridSearchBeta([], { step: -0.1 })).toThrow();
  });
});

describe('meanAbsolutePercentageError', () => {
  it('is zero for perfect predictions', () => {
    const pairs = [1, 10, 100].map((rank) => ({
      rank,
      volume: 1_000_000 * Math.pow(rank, -0.7),
    }));
    const { mape } = meanAbsolutePercentageError(pairs, 0.7, 1_000_000);
    expect(mape).toBeCloseTo(0, 6);
  });

  it('is 0.5 when predictions are 50% high', () => {
    // Volumes are exact for β=0.7, A=1M; predict with A=1.5M instead.
    const pairs = [1, 10, 100].map((rank) => ({
      rank,
      volume: 1_000_000 * Math.pow(rank, -0.7),
    }));
    const { mape } = meanAbsolutePercentageError(pairs, 0.7, 1_500_000);
    expect(mape).toBeCloseTo(0.5, 6);
  });

  it('returns NaN when no usable pairs', () => {
    const { mape, nUsed } = meanAbsolutePercentageError([{ rank: 0, volume: 100 }], 0.7, 1000);
    expect(Number.isNaN(mape)).toBe(true);
    expect(nUsed).toBe(0);
  });
});

describe('endOfMonthIso', () => {
  it('returns the last day of the month for the given date', () => {
    expect(endOfMonthIso('2026-04-15')).toBe('2026-04-30');
    expect(endOfMonthIso('2026-04-01')).toBe('2026-04-30');
    expect(endOfMonthIso('2026-04-30')).toBe('2026-04-30');
  });
  it('handles February correctly (leap and non-leap)', () => {
    expect(endOfMonthIso('2026-02-15')).toBe('2026-02-28'); // 2026 is not a leap year
    expect(endOfMonthIso('2024-02-15')).toBe('2024-02-29'); // 2024 IS a leap year
  });
  it('handles December', () => {
    expect(endOfMonthIso('2026-12-21')).toBe('2026-12-31');
  });
  it('throws on bad format', () => {
    expect(() => endOfMonthIso('2026/04/15')).toThrow();
    expect(() => endOfMonthIso('not-a-date')).toThrow();
  });
});

describe('pickFitForWeek', () => {
  const fits: FitParams[] = [
    { calibrationMonthEndDate: '2026-04-30', fittedAt: '2026-05-01T00:00:00Z', beta: 0.75, scaleFactor: 2_000_000 },
    { calibrationMonthEndDate: '2026-05-31', fittedAt: '2026-06-01T00:00:00Z', beta: 0.74, scaleFactor: 1_800_000 },
    { calibrationMonthEndDate: '2026-11-30', fittedAt: '2026-12-01T00:00:00Z', beta: 0.76, scaleFactor: 3_500_000 },
    { calibrationMonthEndDate: '2026-12-31', fittedAt: '2027-01-01T00:00:00Z', beta: 0.77, scaleFactor: 4_200_000 },
  ];

  it('returns null when no fits are available', () => {
    expect(pickFitForWeek('2026-12-15', [])).toBeNull();
  });

  it('picks the fit matching the week\'s calendar month when one exists', () => {
    const result = pickFitForWeek('2026-12-21', fits);
    expect(result?.fit.calibrationMonthEndDate).toBe('2026-12-31');
    expect(result?.isExtrapolated).toBe(false);
  });

  it('picks the most-recent past fit when no exact-month match exists', () => {
    // Pretend we don't have December's fit yet
    const noDec = fits.filter((f) => f.calibrationMonthEndDate !== '2026-12-31');
    const result = pickFitForWeek('2026-12-21', noDec);
    expect(result?.fit.calibrationMonthEndDate).toBe('2026-11-30');
    expect(result?.isExtrapolated).toBe(false);
  });

  it('NEVER uses a future fit for a past week (the load-bearing rule)', () => {
    // April week: should use April fit, NOT May/Nov/Dec
    const result = pickFitForWeek('2026-04-07', fits);
    expect(result?.fit.calibrationMonthEndDate).toBe('2026-04-30');
    expect(result?.isExtrapolated).toBe(false);
  });

  it('falls back to earliest fit (with isExtrapolated=true) for weeks before any fit', () => {
    // March 2026 week — earlier than all our fits
    const result = pickFitForWeek('2026-03-15', fits);
    expect(result?.fit.calibrationMonthEndDate).toBe('2026-04-30'); // earliest available
    expect(result?.isExtrapolated).toBe(true);
  });

  it('tiebreaks multiple fits in the same calibration month by latest fittedAt', () => {
    const withDupes: FitParams[] = [
      { calibrationMonthEndDate: '2026-04-30', fittedAt: '2026-05-01T00:00:00Z', beta: 0.70, scaleFactor: 1_000_000 },
      { calibrationMonthEndDate: '2026-04-30', fittedAt: '2026-05-15T00:00:00Z', beta: 0.75, scaleFactor: 2_000_000 },
    ];
    const result = pickFitForWeek('2026-04-21', withDupes);
    expect(result?.fit.beta).toBe(0.75); // the later-fitted of the two April fits
    expect(result?.fit.scaleFactor).toBe(2_000_000);
  });

  it('handles a single-fit edge case (only one fit available)', () => {
    const oneFit: FitParams[] = [
      { calibrationMonthEndDate: '2026-04-30', fittedAt: '2026-05-01T00:00:00Z', beta: 0.7, scaleFactor: 1e6 },
    ];
    // Same month: not extrapolated
    expect(pickFitForWeek('2026-04-15', oneFit)?.isExtrapolated).toBe(false);
    // Later month: not extrapolated (uses past fit)
    expect(pickFitForWeek('2026-08-15', oneFit)?.isExtrapolated).toBe(false);
    // Earlier month: IS extrapolated
    expect(pickFitForWeek('2026-02-15', oneFit)?.isExtrapolated).toBe(true);
  });

  it('treats fits sorted in any input order identically', () => {
    const shuffled = [...fits].reverse();
    const a = pickFitForWeek('2026-12-21', fits);
    const b = pickFitForWeek('2026-12-21', shuffled);
    expect(a?.fit.calibrationMonthEndDate).toBe(b?.fit.calibrationMonthEndDate);
  });
});

describe('stratifiedMape', () => {
  it('partitions pairs by rank band', () => {
    const pairs = [
      { rank: 5, volume: 100 },       // top1k
      { rank: 500, volume: 100 },     // top1k
      { rank: 5_000, volume: 100 },   // 1k-10k
      { rank: 50_000, volume: 100 },  // 10k-100k
      { rank: 500_000, volume: 100 }, // 100k+
    ];
    const result = stratifiedMape(pairs, 0.7, 1_000_000);
    expect(result.counts.overall).toBe(5);
    expect(result.counts.top1k).toBe(2);
    expect(result.counts.rank1kTo10k).toBe(1);
    expect(result.counts.rank10kTo100k).toBe(1);
    expect(result.counts.above100k).toBe(1);
  });

  it('returns null for empty buckets', () => {
    const pairs = [{ rank: 5, volume: 100 }];
    const result = stratifiedMape(pairs, 0.7, 1_000_000);
    expect(result.counts.top1k).toBe(1);
    expect(result.counts.rank1kTo10k).toBe(0);
    expect(result.rank1kTo10k).toBeNull();
    expect(result.rank10kTo100k).toBeNull();
    expect(result.above100k).toBeNull();
  });

  it('still gives sane numbers when only one bucket is populated', () => {
    const pairs = [1, 5, 10, 100, 500].map((rank) => ({
      rank,
      volume: 1_000_000 * Math.pow(rank, -0.7),
    }));
    const result = stratifiedMape(pairs, 0.7, 1_000_000);
    expect(result.top1k).not.toBeNull();
    expect(result.top1k).toBeCloseTo(0, 5);
    expect(result.overall).toBeCloseTo(0, 5);
  });
});
