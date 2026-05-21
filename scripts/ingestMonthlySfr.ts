/**
 * CLI ingest for monthly BA SFR CSVs. Thin wrapper around the shared
 * `ingestMonthlySfrFromStream` core in `lib/monthlySfr/ingestCore.ts`.
 *
 * Use this for local one-off ingestion from a CSV file on disk.
 * For the in-app upload UI path, see
 * `app/admin/upload-monthly-sfr/page.tsx` + the Inngest function in
 * `inngest/functions/processMonthlySfr.ts`.
 *
 * Usage:
 *   pnpm tsx scripts/ingestMonthlySfr.ts <csv-path> <month-end-date>
 *
 * Example:
 *   pnpm tsx scripts/ingestMonthlySfr.ts \
 *     "data/US_Top_Search_Terms_Simple_Month_2026_04_30.csv" 2026-04-30
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createReadStream } from 'node:fs';
import { basename } from 'node:path';
import { ingestMonthlySfrFromStream } from '@/lib/monthlySfr/ingestCore';

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

async function main() {
  const { csvPath, monthEndDate } = validateArgs();
  console.log(`Reading ${csvPath} for month_end_date=${monthEndDate}...`);

  const stream = createReadStream(csvPath);
  const result = await ingestMonthlySfrFromStream(stream, monthEndDate, basename(csvPath));

  console.log(
    `\nParsed in ${(result.parseMs / 1000).toFixed(1)}s:` +
      `\n  Total rows:           ${result.totalRows.toLocaleString()}` +
      `\n  Skipped (bad input):  ${result.skippedRows.toLocaleString()}` +
      `\n  Unique normalized:    ${result.uniqueTerms.toLocaleString()}` +
      `\n  Collapsed (MIN kept): ${result.collapses.toLocaleString()}` +
      (result.collapses > 0
        ? `  (${((result.collapses / Math.max(1, result.totalRows - result.skippedRows)) * 100).toFixed(2)}% — typical < 1%)`
        : ''),
  );

  console.log(
    `\nUpserted ${result.upserted.toLocaleString()} rows in ${(result.upsertMs / 1000).toFixed(1)}s.` +
      `\n\nQuick sanity check:` +
      `\n  SELECT COUNT(*) FROM monthly_sfr WHERE month_end_date = '${monthEndDate}';`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
