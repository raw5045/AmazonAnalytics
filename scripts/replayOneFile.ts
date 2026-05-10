/**
 * Replay a single uploaded file by week_end_date. Used for one-off
 * recovery of files that failed during the bulk replay (e.g. transient
 * lock errors). Skips refresh — caller should refresh kcs separately
 * if needed for that one week's anomalies to surface in the explorer.
 *
 * Usage: pnpm tsx scripts/replayOneFile.ts <YYYY-MM-DD>
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
process.env.USE_PG_TCP = '1';

async function main() {
  const week = process.argv[2];
  if (!week) {
    console.error('Usage: pnpm tsx scripts/replayOneFile.ts <YYYY-MM-DD>');
    process.exit(1);
  }
  const { db } = await import('@/db/client');
  const { uploadedFiles } = await import('@/db/schema');
  const { processFileImport } = await import('@/inngest/functions/importFile');
  const { eq, and } = await import('drizzle-orm');

  // Pick the row whose storage_key actually has data — there can be
  // duplicate uploaded_files rows for one week, only one of which has
  // a real R2 file. Try them in order; use the one that doesn't fail
  // immediately with "key does not exist".
  const rows = await db
    .select({
      id: uploadedFiles.id,
      filename: uploadedFiles.originalFilename,
      validationStatus: uploadedFiles.validationStatus,
    })
    .from(uploadedFiles)
    .where(
      and(
        eq(uploadedFiles.weekEndDate, week),
        eq(uploadedFiles.validationStatus, 'imported'),
      ),
    );

  console.log(`Found ${rows.length} imported uploaded_files row(s) for week ${week}`);
  for (const r of rows) console.log(`  ${r.id}  ${r.filename}`);

  for (const r of rows) {
    console.log(`\nReplaying ${r.id}...`);
    try {
      const startedAt = Date.now();
      const result = await processFileImport({
        uploadedFileId: r.id,
        replayMode: true,
      });
      const sec = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.log(`  ✓ ${result.rowsImported.toLocaleString()} rows in ${sec}s`);
      return; // first success is enough
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`  ✗ ${msg}`);
    }
  }
  console.log('All rows failed.');
  process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
