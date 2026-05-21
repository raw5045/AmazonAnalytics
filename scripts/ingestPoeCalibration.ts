/**
 * CLI ingest for POE calibration CSVs. Thin wrapper around the shared
 * `ingestPoeCalibrationFromStream` core in `lib/poeCalibration/ingestCore.ts`.
 *
 * Use this for local one-off ingestion from a CSV file on disk. For
 * the in-app upload UI path (combined BA + POE upload), see the
 * /admin/upload-calibration page and processCalibrationUpload
 * Inngest function.
 *
 * Usage:
 *   pnpm tsx scripts/ingestPoeCalibration.ts <csv-path> <month-end-date>
 *
 * Example:
 *   pnpm tsx scripts/ingestPoeCalibration.ts data/poe-30d-april.csv 2026-04-30
 *
 * The month-end-date tags this POE snapshot — combined with
 * search_term_normalized as the composite PK so historical monthly
 * snapshots coexist instead of overwriting.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createReadStream } from 'node:fs';
import { basename } from 'node:path';
import { ingestPoeCalibrationFromStream } from '@/lib/poeCalibration/ingestCore';

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

async function main() {
  const { csvPath, monthEndDate } = validateArgs();
  console.log(`Reading ${csvPath} for month_end_date=${monthEndDate}...`);

  const stream = createReadStream(csvPath);
  const result = await ingestPoeCalibrationFromStream(stream, monthEndDate, basename(csvPath));

  console.log(
    `\nParsed in ${(result.parseMs / 1000).toFixed(1)}s:` +
      `\n  Total rows:           ${result.totalRows.toLocaleString()}` +
      `\n  Skipped (bad input):  ${result.skippedRows.toLocaleString()}` +
      `\n  Unique normalized:    ${result.uniqueTerms.toLocaleString()}` +
      `\n  Collapsed (MAX kept): ${result.collapses.toLocaleString()}` +
      (result.collapses > 0
        ? `  (${((result.collapses / Math.max(1, result.totalRows - result.skippedRows)) * 100).toFixed(2)}% — typical < 1%)`
        : ''),
  );

  console.log(
    `\nUpserted ${result.upserted.toLocaleString()} rows in ${(result.upsertMs / 1000).toFixed(1)}s.`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
