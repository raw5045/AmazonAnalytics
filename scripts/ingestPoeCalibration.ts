/**
 * Ingest a POE (Product Opportunity Explorer) search-volume sample into
 * the `poe_calibration_data` table.
 *
 * The user pulls this from Amazon's POE tool for a sample of keywords
 * (typically ~1K-5K rows). Paired with monthly_sfr on
 * `search_term_normalized` during model fitting.
 *
 * Usage:
 *   pnpm tsx scripts/ingestPoeCalibration.ts <csv-path> <month-end-date>
 *
 * Example:
 *   pnpm tsx scripts/ingestPoeCalibration.ts data/poe-30d-april.csv 2026-04-30
 *
 * The month-end-date tags this POE snapshot — it's the month the
 * 30-day window represents. Combined with search_term_normalized as
 * the composite PK, so historical monthly snapshots coexist.
 *
 * The CSV file format is the standard 2-column shape Amazon's POE
 * tool exports (after saving xlsx → csv):
 *   "Search Term","30-Day Search Volume"
 *   "mothers day gifts",3459791
 *   "car accessories",1813031
 *   ...
 *
 * Dedup: if multiple raw rows collide after `normalizeForMatch`, we
 * keep the row with the HIGHEST `poe_30_day_volume`. (Different from
 * monthly_sfr's MIN-rank — for POE we want the highest-signal
 * representative when raw variants collide.) Rare in practice since
 * POE samples are pre-curated.
 *
 * Idempotent: re-running upserts via
 * `ON CONFLICT (search_term_normalized) DO UPDATE` — supports refreshing
 * the sample when the user re-pulls POE data.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createReadStream } from 'node:fs';
import { basename } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { streamParseCsv } from '@/lib/csv/streamParse';
import { normalizeForMatch } from '@/lib/analytics/derivedFields';

interface ParsedRow {
  normalizedTerm: string;
  volume30d: number;
}

function validateArgs(): { csvPath: string; monthEndDate: string } {
  const csvPath = process.argv[2];
  const monthEndDate = process.argv[3];
  if (!csvPath || !monthEndDate) {
    console.error('Usage: pnpm tsx scripts/ingestPoeCalibration.ts <csv-path> <month-end-date YYYY-MM-DD>');
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
  collapses: number;
}> {
  const byTerm = new Map<string, ParsedRow>();
  let totalRows = 0;
  let skippedRows = 0;
  let collapses = 0;

  const stream = createReadStream(csvPath);
  // Standard CSV with header on row 1 (NOT Amazon's BA format), so
  // tell streamParseCsv not to drop a metadata row.
  for await (const row of streamParseCsv(stream, { skipMetadataRow: false })) {
    totalRows += 1;
    const rawTerm = row['Search Term'];
    const volStr = row['30-Day Search Volume'];
    if (!rawTerm || !volStr) {
      skippedRows += 1;
      continue;
    }
    const volume30d = Number(volStr.replace(/,/g, ''));
    if (!Number.isFinite(volume30d) || volume30d < 0) {
      skippedRows += 1;
      continue;
    }
    const normalizedTerm = normalizeForMatch(rawTerm);
    if (!normalizedTerm) {
      skippedRows += 1;
      continue;
    }
    const existing = byTerm.get(normalizedTerm);
    if (existing === undefined) {
      byTerm.set(normalizedTerm, { normalizedTerm, volume30d });
    } else {
      // Collision after normalization. Keep the higher-volume rep.
      collapses += 1;
      if (volume30d > existing.volume30d) {
        byTerm.set(normalizedTerm, { normalizedTerm, volume30d });
      }
    }
  }
  return { byTerm, totalRows, skippedRows, collapses };
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
    const valueRows: string[] = [];
    const params: unknown[] = [];
    let p = 1;
    for (const r of slice) {
      valueRows.push(`($${p}, $${p + 1}, $${p + 2}, $${p + 3})`);
      params.push(r.normalizedTerm, monthEndDate, r.volume30d, sourceFilename);
      p += 4;
    }
    const sql = `
      INSERT INTO poe_calibration_data
        (search_term_normalized, month_end_date, poe_30_day_volume, source_filename)
      VALUES ${valueRows.join(', ')}
      ON CONFLICT (search_term_normalized, month_end_date)
      DO UPDATE SET
        poe_30_day_volume = EXCLUDED.poe_30_day_volume,
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
  const { byTerm, totalRows, skippedRows, collapses } = await readAndDedupe(csvPath);
  const tParse = Date.now() - t0;

  const uniqueTerms = byTerm.size;

  console.log(
    `\nParsed in ${(tParse / 1000).toFixed(1)}s:` +
      `\n  Total rows:           ${totalRows.toLocaleString()}` +
      `\n  Skipped (bad input):  ${skippedRows.toLocaleString()}` +
      `\n  Unique normalized:    ${uniqueTerms.toLocaleString()}` +
      `\n  Collapsed (MAX kept): ${collapses.toLocaleString()}` +
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
        `\n  SELECT COUNT(*), MIN(poe_30_day_volume), MAX(poe_30_day_volume),` +
        `\n         percentile_cont(0.5) WITHIN GROUP (ORDER BY poe_30_day_volume) AS median` +
        `\n  FROM poe_calibration_data;`,
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
