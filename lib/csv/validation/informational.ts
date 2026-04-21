import type { ValidationStats } from './types';

function isBlank(v: string | undefined): boolean {
  return v === undefined || v === null || v.trim() === '';
}

export function createStatsAccumulator() {
  const stats: ValidationStats = {
    rowCount: 0,
    blankConversionShareCount: { p1: 0, p2: 0, p3: 0 },
    blankClickShareCount: { p1: 0, p2: 0, p3: 0 },
    blankShareByCategory: {},
    rowsWithAnyBlankShare: 0,
  };

  function consume(row: Record<string, string>) {
    stats.rowCount++;

    let anyBlank = false;

    for (const n of [1, 2, 3] as const) {
      const clickCol = `Top Clicked Product #${n}: Click Share`;
      const convCol = `Top Clicked Product #${n}: Conversion Share`;
      const key = `p${n}` as 'p1' | 'p2' | 'p3';
      if (isBlank(row[clickCol])) {
        stats.blankClickShareCount[key]++;
        anyBlank = true;
      }
      if (isBlank(row[convCol])) {
        stats.blankConversionShareCount[key]++;
        anyBlank = true;
      }
    }

    if (anyBlank) {
      stats.rowsWithAnyBlankShare++;
      const cat = row['Top Clicked Category #1'] ?? '(blank)';
      stats.blankShareByCategory[cat] = (stats.blankShareByCategory[cat] ?? 0) + 1;
    }
  }

  function finalize(): ValidationStats {
    return stats;
  }

  return { consume, finalize };
}
