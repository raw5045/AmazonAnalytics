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
 *   2. Snapshot the cutoff: write `.replay-state.json` with the
 *      maximum `imported_at` across those files at start. Used for
 *      resume.
 *   3. For each file in turn, skip it if its `imported_at` is already
 *      > the snapshot cutoff (i.e., a previous run of this script
 *      already replayed it). Otherwise call processFileImport with
 *      skipRefresh=true. The successful replay updates imported_at
 *      to NOW(), automatically taking it out of the "needs replay"
 *      set on resume.
 *   4. After all files complete, run one final
 *      refreshKeywordCurrentSummary.
 *   5. Send a single summary email recapping the run.
 *
 * Resilience:
 *   - Resume is automatic: re-run the script and it picks up where
 *     it left off, skipping already-replayed files.
 *   - The DRY_RUN env var lists files that would be replayed without
 *     touching the DB. Useful before kicking off the actual run.
 *   - START_FROM=YYYY-MM-DD overrides the snapshot logic and forces
 *     replay starting at that week.
 *   - DELETE the .replay-state.json file to start fresh.
 *
 * Estimated runtime: ~9 hr for the 53 files we have today (kwm-only
 * import is ~10 min/file warm-cache), plus ~30 min for the final
 * refresh.
 *
 * Usage:
 *   pnpm tsx scripts/replayHistoricalImports.ts            # start or resume
 *   DRY_RUN=1 pnpm tsx scripts/replayHistoricalImports.ts  # list only
 *   START_FROM=2026-01-17 pnpm tsx scripts/replayHistoricalImports.ts
 *     # force replay from that week regardless of state file
 *   rm .replay-state.json && pnpm tsx scripts/replayHistoricalImports.ts
 *     # forget all progress and start over
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Force TCP (pg.Pool) instead of neon-http for the replay. The HTTP
// driver times out on INSERT statements that take more than a few
// minutes — the search_terms upsert and the kwm dedup CTE both can
// run 5-15 min on cold cache, well past Neon's HTTP timeout. The
// production Railway worker uses TCP via USE_PG_TCP=1; we set the same
// here so the replay matches that path.
//
// MUST run before importing @/db/client below (createDb() reads this
// at module-init time).
process.env.USE_PG_TCP = '1';

// Catch async errors from R2 streams that emit 'error' AFTER the COPY
// loop has consumed the stream. Without this, a single transient R2
// inactivity timeout would emit an uncaught 'error' event and kill
// the whole replay process, losing 5+ hours of progress. Per-file
// errors are already caught in the loop's try/catch — this is a
// safety net for stream errors that bubble up via the event-emitter
// path instead of via the await.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException — logged, not fatal]:', err.message);
});
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error('[unhandledRejection — logged, not fatal]:', msg);
});

interface ReplayState {
  /**
   * ISO timestamp at run start. Files whose imported_at is > this
   * cutoff have been replayed by the current script run; we skip them
   * on resume.
   */
  cutoffIso: string;
  /** When this state file was first written (informational). */
  startedAt: string;
}

const STATE_FILE = join(process.cwd(), '.replay-state.json');

async function main() {
  const { db } = await import('@/db/client');
  const { uploadedFiles } = await import('@/db/schema');
  const { processFileImport } = await import('@/inngest/functions/importFile');
  const { refreshKeywordCurrentSummary } = await import('@/inngest/functions/refreshSummary');
  const { sendImportEmail } = await import('@/lib/notifications/sendImportEmail');
  const { eq, asc, and, isNotNull } = await import('drizzle-orm');

  const startFrom = process.env.START_FROM ?? null;
  const dryRun = process.env.DRY_RUN === '1';

  // Load or create state snapshot. The cutoff timestamp lets us
  // reliably resume — any file whose imported_at is > cutoffIso has
  // already been replayed by a prior invocation of this run.
  let state: ReplayState;
  if (existsSync(STATE_FILE)) {
    state = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as ReplayState;
    console.log(`Resuming run started ${state.startedAt}`);
    console.log(`  cutoff: imported_at > ${state.cutoffIso} = already replayed`);
  } else {
    // Fresh run: cutoff is the max imported_at across all imported files
    // RIGHT NOW. Anything updated after this point is by us.
    const [{ max_imported }] = (await db.execute(
      // Cast to text to avoid timezone-shift issues across drivers
      `SELECT COALESCE(MAX(imported_at)::text, '1970-01-01T00:00:00Z') AS max_imported
       FROM uploaded_files
       WHERE validation_status = 'imported'`,
    )).rows as Array<{ max_imported: string }>;
    state = {
      cutoffIso: max_imported,
      startedAt: new Date().toISOString(),
    };
    if (!dryRun) {
      writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
      console.log(`Wrote ${STATE_FILE} with cutoff = ${state.cutoffIso}`);
    }
  }

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
      importedAt: uploadedFiles.importedAt,
    })
    .from(uploadedFiles)
    .where(
      and(
        eq(uploadedFiles.validationStatus, 'imported'),
        isNotNull(uploadedFiles.weekEndDate),
      ),
    )
    .orderBy(asc(uploadedFiles.weekEndDate));

  const cutoff = new Date(state.cutoffIso).getTime();
  const filtered = files.filter((f) => {
    if (startFrom && f.weekEndDate && f.weekEndDate < startFrom) return false;
    // Skip files already replayed by this run (imported_at > cutoff)
    const importedAt = f.importedAt ? new Date(f.importedAt).getTime() : 0;
    if (importedAt > cutoff) return false;
    return true;
  });
  const skipped = files.length - filtered.length;
  if (skipped > 0) {
    console.log(`\nSkipping ${skipped} files already replayed in this run.`);
  }

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
        replayMode: true,
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

  // Clean up the state file once we've reached the end of the loop
  // AND the final refresh is done. If the script gets killed before
  // here, the state file persists and the next run resumes.
  if (existsSync(STATE_FILE)) {
    try {
      const fs = await import('node:fs');
      fs.unlinkSync(STATE_FILE);
      console.log(`Removed ${STATE_FILE}`);
    } catch (e) {
      console.warn('Could not remove state file:', e);
    }
  }

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
