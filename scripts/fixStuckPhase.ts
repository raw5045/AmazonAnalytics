/**
 * One-off: mark the 4/25 file as completed since the refresh succeeded
 * but the old code path never updated import_phase past 'summary_refresh'.
 * The fix in importFile.ts handles this going forward; this script
 * cleans up the prior file.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';

async function main() {
  const sql = neon(process.env.DATABASE_URL!);
  const before = (await sql`
    SELECT id, original_filename, validation_status, import_phase
    FROM uploaded_files
    WHERE original_filename = 'US_Top_Search_Terms_Simple_Week_2026_04_25.csv'
  `) as Array<Record<string, unknown>>;
  console.log('Before:', before);

  await sql`
    UPDATE uploaded_files
    SET import_phase = 'completed'
    WHERE original_filename = 'US_Top_Search_Terms_Simple_Week_2026_04_25.csv'
      AND validation_status = 'imported'
  `;

  const after = (await sql`
    SELECT id, original_filename, validation_status, import_phase
    FROM uploaded_files
    WHERE original_filename = 'US_Top_Search_Terms_Simple_Week_2026_04_25.csv'
  `) as Array<Record<string, unknown>>;
  console.log('After:', after);
}
main().catch((e) => { console.error(e); process.exit(1); });
