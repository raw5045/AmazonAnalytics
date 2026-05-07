/**
 * Replay every previously-imported CSV through the corrected import
 * pipeline (with the dedup fix from Plan 3.X). Reads each file from R2
 * via its existing storage_key — no manual re-upload required.
 *
 * What this fixes:
 *   ~5-15% of popular keywords' weekly rank rows were corrupt because
 *   `ON CONFLICT DO NOTHING` non-deterministically picked between a
 *   real row and a phantom OBJ-prefixed row. The fix in
 *   inngest/functions/importFile.ts now dedups deterministically and
 *   picks the row with the lowest rank. Replaying every CSV through
 *   that path heals all historical kwm rows.
 *
 * Strategy:
 *   1. List uploaded_files where validation_status = 'imported',
 *      ordered by week_end_date ASC (oldest first; deterministic).
 *   2. For each file, call processFileImport with skipRefresh=true.
 *      - Skips per-file refresh (~30 min each → ~26 hr total saved)
 *      - Skips per-file completion email (avoids 53 inbox messages)
 *   3. After all files complete, run one final
 *      refreshKeywordCurrentSummary.
 *   4. Send a single summary email recapping the run.
 *
 * Resilience:
 *   - If the script is interrupted, it can be re-run; the dedup logic
 *     is idempotent (re-importing identical data is a no-op via the
 *     ROW IS DISTINCT clause).
 *   - The DRY_RUN env var lists files that would be replayed without
 *     touching the DB. Useful before kicking off the actual run.
 *
 * Estimated runtime: ~9 hr for the 53 files we have today (kwm-only
 * import is ~10 min/file warm-cache), plus ~30 min for the final
 * refresh.
 *
 * Usage:
 *   pnpm tsx scripts/replayHistoricalImports.ts            # actual run
 *   DRY_RUN=1 pnpm tsx scripts/replayHistoricalImports.ts  # list only
 *   START_FROM=2026-01-17 pnpm tsx scripts/replayHistoricalImports.ts
 *     # resume from the file with that week_end_date if a prior run
 *     # was interrupted
 */
import { config } from 'dotenv';
config({ path: '.env.local' });

async function main() {
  const { db } = await import('@/db/client');
  const { uploadedFiles } = await import('@/db/schema');
  const { processFileImport } = await import('@/inngest/functions/importFile');
  const { refreshKeywordCurrentSummary } = await import('@/inngest/functions/refreshSummary');
  const { sendImportEmail } = await import('@/lib/notifications/sendImportEmail');
  const { eq, asc, and, isNotNull } = await import('drizzle-orm');

  const startFrom = process.env.START_FROM ?? null;
  const dryRun = process.env.DRY_RUN === '1';

  // Pull all imported files in week order. The replay processes them
  // chronologically so the final state of search_terms (which tracks
  // first_seen_week / last_seen_week) ends up correct.
  const files = await db
    .select({
      id: uploadedFiles.id,
      filename: uploadedFiles.originalFilename,
      weekEndDate: uploadedFiles.weekEndDate,
      storageKey: uploadedFiles.storageKey,
      validationStatus: uploadedFiles.validationStatus,
    })
    .from(uploadedFiles)
    .where(
      and(
        eq(uploadedFiles.validationStatus, 'imported'),
        isNotNull(uploadedFiles.weekEndDate),
      ),
    )
    .orderBy(asc(uploadedFiles.weekEndDate));

  const filtered = startFrom
    ? files.filter((f) => f.weekEndDate && f.weekEndDate >= startFrom)
    : files;

  console.log(`\nReplay plan: ${filtered.length} files`);
  if (startFrom) console.log(`  Resuming from week ${startFrom}`);
  console.log();
  for (const f of filtered) {
    console.log(`  ${f.weekEndDate}  ${f.filename ?? '(no name)'}`);
  }

  if (dryRun) {
    console.log('\n[DRY_RUN] no changes made. Re-run without DRY_RUN=1 to execute.');
    return;
  }

  console.log('\nStarting replay...');
  const startedAt = Date.now();
  const results: Array<{ id: string; filename: string; ok: boolean; durationMs: number; error?: string }> = [];

  for (let i = 0; i < filtered.length; i++) {
    const f = filtered[i];
    const fileStartedAt = Date.now();
    const remaining = filtered.length - i;
    console.log(
      `\n[${(i + 1).toString().padStart(2)}/${filtered.length}] ${f.weekEndDate} — ${f.filename ?? '(no name)'} (${remaining} remaining)`,
    );
    try {
      const result = await processFileImport({
        uploadedFileId: f.id,
        skipRefresh: true,
      });
      const durationMs = Date.now() - fileStartedAt;
      console.log(`  ✓ ${result.rowsImported.toLocaleString()} rows imported in ${(durationMs / 1000).toFixed(1)}s`);
      results.push({
        id: f.id,
        filename: f.filename ?? '(no name)',
        ok: true,
        durationMs,
      });
    } catch (e) {
      const durationMs = Date.now() - fileStartedAt;
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`  ✗ FAILED after ${(durationMs / 1000).toFixed(1)}s: ${msg}`);
      results.push({
        id: f.id,
        filename: f.filename ?? '(no name)',
        ok: false,
        durationMs,
        error: msg,
      });
      // Don't bail — try the next file. We'd rather get most of the
      // historical data fixed than abort on the first hiccup.
    }

    // Progress estimate
    const elapsedMs = Date.now() - startedAt;
    const avgMs = elapsedMs / (i + 1);
    const etaMin = Math.round((avgMs * remaining) / 60_000);
    console.log(`  ETA ~${etaMin} min remaining for the kwm-only phase`);
  }

  const allKwmDoneMs = Date.now() - startedAt;
  console.log(`\nKWM phase complete in ${Math.round(allKwmDoneMs / 60_000)} min.`);
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.warn(`\n⚠ ${failed.length} files failed:`);
    for (const f of failed) console.warn(`  ${f.filename}: ${f.error}`);
  }

  console.log('\nRunning final refreshKeywordCurrentSummary...');
  const refreshStartedAt = Date.now();
  let refreshResult: { rowsWritten: number; currentWeekEndDate: string } | null = null;
  try {
    refreshResult = await refreshKeywordCurrentSummary();
    console.log(
      `✓ Refresh: ${refreshResult.rowsWritten.toLocaleString()} rows in ${Math.round((Date.now() - refreshStartedAt) / 60_000)} min`,
    );
  } catch (e) {
    console.error('✗ Final refresh FAILED:', e);
  }

  const totalMin = Math.round((Date.now() - startedAt) / 60_000);
  console.log(`\nTotal replay time: ${totalMin} min`);

  // One summary email at the end
  await sendImportEmail({
    outcome: failed.length === 0 && refreshResult ? 'completed' : 'completed_with_refresh_failure',
    filename: `Historical replay (${filtered.length} files)`,
    batchId: 'historical-replay',
    durationMs: Date.now() - startedAt,
    rowsImported: results.reduce((sum, r) => sum + 0, 0),
    rowsInSummary: refreshResult?.rowsWritten,
    latestWeek: refreshResult?.currentWeekEndDate,
    errorMessage:
      failed.length > 0
        ? `${failed.length} file(s) failed: ${failed.map((f) => f.filename).join(', ')}`
        : undefined,
  });
}
main().catch((e) => { console.error(e); process.exit(1); });
