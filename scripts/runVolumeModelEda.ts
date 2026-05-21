/**
 * Exploratory data analysis on the calibration pairs.
 *
 * Outputs a TSV file (and console summary) of all (rank, volume) pairs
 * available from joining monthly_sfr ⋈ poe_calibration_data. Use the
 * TSV to plot log(rank) vs log(volume) externally (Excel, Numbers,
 * Python notebook — anything).
 *
 * What to look for in the log-log plot:
 *   - Roughly straight line → single power law fits well; proceed to
 *     scripts/fitVolumeModel.ts.
 *   - Clear bend / piecewise shape → may need a 2-segment fit (one β
 *     for top ranks, another for tail). Flag for further design.
 *   - Wide noise with no clear trend → calibration data quality is
 *     the bottleneck; revisit pairing strategy.
 *
 * Console output: pair count, rank-band counts, Pearson correlation
 * of log(rank) vs log(volume) (expected: close to -1 for clean power
 * law; values closer to 0 indicate weak relationship).
 *
 * Usage:
 *   pnpm tsx scripts/runVolumeModelEda.ts <month-end-date> [--output <tsv-path>]
 *
 * Example:
 *   pnpm tsx scripts/runVolumeModelEda.ts 2026-04-30 --output out/eda.tsv
 *
 * Plan reference: docs/superpowers/plans/2026-05-19-search-volume-estimator.md (T3)
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Pool } from 'pg';

interface Pair {
  searchTerm: string;
  rank: number;
  volume30d: number;
}

function parseArgs(): { monthEndDate: string; outputPath: string } {
  const args = process.argv.slice(2);
  const monthEndDate = args[0];
  if (!monthEndDate || !/^\d{4}-\d{2}-\d{2}$/.test(monthEndDate)) {
    console.error('Usage: pnpm tsx scripts/runVolumeModelEda.ts <YYYY-MM-DD> [--output path]');
    process.exit(1);
  }
  const outIdx = args.indexOf('--output');
  const outputPath = outIdx >= 0 ? args[outIdx + 1] : `out/eda-${monthEndDate}.tsv`;
  return { monthEndDate, outputPath };
}

async function fetchPairs(pool: Pool, monthEndDate: string): Promise<Pair[]> {
  const c = await pool.connect();
  try {
    const { rows } = await c.query<{
      search_term: string;
      actual_rank: number;
      poe_30_day_volume: string;
    }>(
      `
      SELECT
        m.search_term_normalized AS search_term,
        m.actual_rank,
        p.poe_30_day_volume::text AS poe_30_day_volume
      FROM monthly_sfr m
      JOIN poe_calibration_data p USING (search_term_normalized)
      WHERE m.month_end_date = $1::date
        AND m.actual_rank > 0
        AND p.poe_30_day_volume > 0
      `,
      [monthEndDate],
    );
    return rows.map((r) => ({
      searchTerm: r.search_term,
      rank: r.actual_rank,
      volume30d: Number(r.poe_30_day_volume),
    }));
  } finally {
    c.release();
  }
}

function pearsonCorrelation(xs: number[], ys: number[]): number {
  if (xs.length !== ys.length || xs.length < 2) return NaN;
  const n = xs.length;
  const xMean = xs.reduce((s, v) => s + v, 0) / n;
  const yMean = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0, xSS = 0, ySS = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - xMean;
    const dy = ys[i] - yMean;
    num += dx * dy;
    xSS += dx * dx;
    ySS += dy * dy;
  }
  const denom = Math.sqrt(xSS * ySS);
  return denom === 0 ? NaN : num / denom;
}

function countByBand(pairs: Pair[]): Record<string, number> {
  const buckets: Record<string, number> = {
    'top 1k': 0,
    '1k-10k': 0,
    '10k-100k': 0,
    '100k+': 0,
  };
  for (const p of pairs) {
    if (p.rank <= 1_000) buckets['top 1k']++;
    else if (p.rank <= 10_000) buckets['1k-10k']++;
    else if (p.rank <= 100_000) buckets['10k-100k']++;
    else buckets['100k+']++;
  }
  return buckets;
}

async function main() {
  const { monthEndDate, outputPath } = parseArgs();
  const pool = new Pool({ connectionString: process.env.DATABASE_URL! });

  try {
    const pairs = await fetchPairs(pool, monthEndDate);
    if (pairs.length === 0) {
      console.error(
        `No calibration pairs found for month ${monthEndDate}.\n` +
          `Verify that monthly_sfr has data for that month and ` +
          `that poe_calibration_data is populated.`,
      );
      process.exit(1);
    }

    console.log(`\n=== EDA: rank→volume calibration pairs for ${monthEndDate} ===\n`);
    console.log(`Total pairs: ${pairs.length.toLocaleString()}`);
    console.log(`Rank-band distribution:`);
    const bands = countByBand(pairs);
    for (const [name, n] of Object.entries(bands)) {
      console.log(`  ${name.padEnd(10)} ${n.toLocaleString().padStart(6)}`);
    }

    const logRanks = pairs.map((p) => Math.log(p.rank));
    const logVolumes = pairs.map((p) => Math.log(p.volume30d));
    const r = pearsonCorrelation(logRanks, logVolumes);
    console.log(`\nPearson correlation of log(rank) vs log(volume): ${r.toFixed(4)}`);
    console.log(`  Expected: close to -1 (rank up = volume down).`);
    if (r > -0.5) {
      console.log(`  ⚠ r is weaker than -0.5; power law may not fit cleanly.`);
    } else if (r > -0.8) {
      console.log(`  ⚠ r is between -0.5 and -0.8; expect some noise in fit.`);
    } else {
      console.log(`  ✓ r is below -0.8; power law should fit reasonably.`);
    }

    // Rough β estimate from the correlation + std-dev ratio (sanity check
    // before the formal grid-search fit).
    // β ≈ -r × (stddev(log_v) / stddev(log_r))
    const xMean = logRanks.reduce((s, v) => s + v, 0) / logRanks.length;
    const yMean = logVolumes.reduce((s, v) => s + v, 0) / logVolumes.length;
    const xSd = Math.sqrt(logRanks.reduce((s, v) => s + (v - xMean) ** 2, 0) / logRanks.length);
    const ySd = Math.sqrt(logVolumes.reduce((s, v) => s + (v - yMean) ** 2, 0) / logVolumes.length);
    const roughBeta = -r * (ySd / xSd);
    console.log(
      `\nQuick-and-dirty β estimate from correlation: ${roughBeta.toFixed(3)}`,
    );
    console.log(`  (Plausible range from prior literature: 0.4-1.2.)`);

    // Write TSV
    mkdirSync(dirname(outputPath), { recursive: true });
    const tsvLines = ['search_term\trank\tvolume_30d\tlog_rank\tlog_volume'];
    for (const p of pairs) {
      tsvLines.push(
        `${p.searchTerm}\t${p.rank}\t${p.volume30d}\t${Math.log(p.rank).toFixed(6)}\t${Math.log(p.volume30d).toFixed(6)}`,
      );
    }
    writeFileSync(outputPath, tsvLines.join('\n') + '\n');
    console.log(`\nFull pair data written to: ${outputPath}`);
    console.log(`\nOpen the TSV in Excel / Numbers / a Python notebook and plot`);
    console.log(`log_rank (x) vs log_volume (y). A roughly straight line confirms`);
    console.log(`the power-law assumption — proceed to scripts/fitVolumeModel.ts.`);
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
