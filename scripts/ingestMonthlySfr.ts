/**
 * Ingest a monthly Brand Analytics SFR report into the `monthly_sfr` table.
 *
 * Used to provide the BA side of (rank, volume) calibration pairs for the
 * volume estimator (paired with poe_calibration_data on
 * search_term_normalized).
 *
 * Usage:
 *   pnpm tsx scripts/ingestMonthlySfr.ts <csv-path> <month-end-date>
 *
 * Example:
 *   pnpm tsx scripts/ingestMonthlySfr.ts \
 *     "data/US_Top_Search_Terms_Simple_Month_2026_04_30.csv" 2026-04-30
 *
 * The CSV is expected to be in Amazon's standard Brand Analytics format:
 *   - Row 1: metadata (Reporting Range, year, month) — dropped by streamParseCsv
 *   - Row 2: column headers (we use "Search Term" and "Search Frequency Rank")
 *   - Row 3+: data rows
 *
 * Dedup semantics (mirroring the weekly path):
 *   - Multiple raw rows whose `search_term_normalized` collide → keep the
 *     row with the LOWEST `actual_rank`. (Same MIN-wins logic as the weekly
 *     dedup CTE in inngest/functions/importFile.ts, just done in-memory
 *     since we control the entire CSV → DB path here.)
 *
 * Re-running on the same (term, month) overwrites the existing row
 * (ON CONFLICT DO UPDATE) — intentional re-uploads are supported.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createReadStream } from 'node:fs';
import { basename } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { streamParseCsv } from '@/lib/csv/streamParse';
import { normalizeForMatch } from '@/lib/analytics/derivedFields';

interface ParsedRow {
  rawTerm: string;
  normalizedTerm: string;
  rank: number;
  sourceRowNumber: number;
}

function validateArgs(): { csvPath: string; monthEndDate: string } {
  const csvPath = process.argv[2];
  const monthEndDate = process.argv[3];
  if (!csvPath || !monthEndDate) {
    console.error('Usage: pnpm tsx scripts/ingestMonthlySfr.ts <csv-path> <month-end-date YYYY-MM-DD>');
    process.exit(1);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(monthEndDate)) {
    console.error(`Invalid month-end-date "${monthEndDate}". Use YYYY-MM-DD.`);
    process.exit(1);
  }
  return { csvPath, monthEndDate };
}

async function readAndDedupe(csvPath: string): Promise<{
  byTerm: Map<string, ParsedRow>;
  totalRows: number;
  skippedRows: number;
}> {
  const byTerm = new Map<string, ParsedRow>();
  let totalRows = 0;
  let skippedRows = 0;
  let sourceRowNumber = 0;

  const stream = createReadStream(csvPath);
  for await (const row of streamParseCsv(stream)) {
    sourceRowNumber += 1;
    totalRows += 1;
    const rawTerm = row['Search Term'];
    const rankStr = row['Search Frequency Rank'];
    if (!rawTerm || !rankStr) {
      skippedRows += 1;
      continue;
    }
    const rank = Number(rankStr.replace(/,/g, ''));
    if (!Number.isFinite(rank) || rank < 1) {
      skippedRows += 1;
      continue;
    }
    const normalizedTerm = normalizeForMatch(rawTerm);
    if (!normalizedTerm) {
      skippedRows += 1;
      continue;
    }
    const existing = byTerm.get(normalizedTerm);
    // MIN-wins dedup: replace existing only if new rank is strictly lower
    // (lower SFR = better = more popular).
    if (existing === undefined || rank < existing.rank) {
      byTerm.set(normalizedTerm, { rawTerm, normalizedTerm, rank, sourceRowNumber });
    }
  }
  return { byTerm, totalRows, skippedRows };
}

async function bulkUpsert(
  client: PoolClient,
  rows: ParsedRow[],
  monthEndDate: string,
  sourceFilename: string,
): Promise<number> {
  if (rows.length === 0) return 0;
  const CHUNK = 1000;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    // Build a multi-row INSERT: each row contributes 4 params
    // ($1=term, $2=rank, $3=month_end_date, $4=source_filename) repeated.
    const valueRows: string[] = [];
    const params: unknown[] = [];
    let p = 1;
    for (const r of slice) {
      valueRows.push(`($${p}, $${p + 1}, $${p + 2}, $${p + 3})`);
      params.push(r.normalizedTerm, r.rank, monthEndDate, sourceFilename);
      p += 4;
    }
    const sql = `
      INSERT INTO monthly_sfr (search_term_normalized, actual_rank, month_end_date, source_filename)
      VALUES ${valueRows.join(', ')}
      ON CONFLICT (search_term_normalized, month_end_date)
      DO UPDATE SET
        actual_rank = EXCLUDED.actual_rank,
        source_filename = EXCLUDED.source_filename,
        imported_at = NOW()
    `;
    const result = await client.query(sql, params);
    inserted += result.rowCount ?? 0;
  }
  return inserted;
}

async function main() {
  const { csvPath, monthEndDate } = validateArgs();
  console.log(`Reading ${csvPath} for month_end_date=${monthEndDate}...`);

  const t0 = Date.now();
  const { byTerm, totalRows, skippedRows } = await readAndDedupe(csvPath);
  const tParse = Date.now() - t0;

  const uniqueTerms = byTerm.size;
  const collapses = totalRows - skippedRows - uniqueTerms;

  console.log(
    `\nParsed in ${(tParse / 1000).toFixed(1)}s:` +
      `\n  Total rows:           ${totalRows.toLocaleString()}` +
      `\n  Skipped (bad input):  ${skippedRows.toLocaleString()}` +
      `\n  Unique normalized:    ${uniqueTerms.toLocaleString()}` +
      `\n  Collapsed (MIN kept): ${collapses.toLocaleString()}` +
      (collapses > 0
        ? `  (${((collapses / Math.max(1, totalRows - skippedRows)) * 100).toFixed(2)}% — typical < 1%)`
        : ''),
  );

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL!,
    statement_timeout: 600_000,
  });
  const client = await pool.connect();
  try {
    const t1 = Date.now();
    const inserted = await bulkUpsert(
      client,
      Array.from(byTerm.values()),
      monthEndDate,
      basename(csvPath),
    );
    const tInsert = Date.now() - t1;

    console.log(
      `\nUpserted ${inserted.toLocaleString()} rows in ${(tInsert / 1000).toFixed(1)}s.` +
        `\n\nQuick sanity check:` +
        `\n  SELECT COUNT(*) FROM monthly_sfr WHERE month_end_date = '${monthEndDate}';`,
    );
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
