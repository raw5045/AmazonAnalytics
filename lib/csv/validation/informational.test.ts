import { describe, it, expect } from 'vitest';
import { createStatsAccumulator } from './informational';

describe('stats accumulator', () => {
  it('counts blank shares per product slot', () => {
    const acc = createStatsAccumulator();
    acc.consume({
      'Top Clicked Product #1: Click Share': '12',
      'Top Clicked Product #1: Conversion Share': '',
      'Top Clicked Product #2: Click Share': '',
      'Top Clicked Product #2: Conversion Share': '',
      'Top Clicked Product #3: Click Share': '5',
      'Top Clicked Product #3: Conversion Share': '2',
      'Top Clicked Category #1': 'Beauty',
    });
    acc.consume({
      'Top Clicked Product #1: Click Share': '',
      'Top Clicked Product #1: Conversion Share': '',
      'Top Clicked Product #2: Click Share': '',
      'Top Clicked Product #2: Conversion Share': '',
      'Top Clicked Product #3: Click Share': '',
      'Top Clicked Product #3: Conversion Share': '',
      'Top Clicked Category #1': 'Health',
    });
    const stats = acc.finalize();
    expect(stats.rowCount).toBe(2);
    expect(stats.blankClickShareCount.p1).toBe(1);
    expect(stats.blankConversionShareCount.p1).toBe(2);
    expect(stats.blankShareByCategory['Beauty']).toBe(1);
    expect(stats.blankShareByCategory['Health']).toBe(1);
    expect(stats.rowsWithAnyBlankShare).toBe(2);
  });
});
