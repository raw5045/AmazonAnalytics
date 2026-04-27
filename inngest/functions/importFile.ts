import { eq, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { from as copyFrom } from 'pg-copy-streams';
import { inngest } from '../client';
import { downloadStreamFromR2 } from '@/lib/storage/r2';
import { streamParseCsv } from '@/lib/csv/streamParse';
import { normalizeForMatch } from '@/lib/analytics/derivedFields';
import { env } from '@/lib/env';
import { BOOT_ID } from '@/lib/runtime';
import { db } from '@/db/client';
import {
  uploadedFiles,
  stagingWeeklyMetrics,
  reportingWeeks,
  importPhaseTimings,
} from '@/db/schema';

export interface ImportFileInput {
  uploadedFileId: string;
}

export interface ImportFileOutput {
  rowsImported: number;
}

function toNumeric(v: string | undefined | null): string | null {
  if (!v || v.trim() === '') return null;
  const n = Number(v);
  if (Number.isNaN(n)) return null;
  return n.toFixed(2);
}

function titleContainsKeyword(normalizedKeyword: string, title: string | null | undefined): boolean {
  if (!title || !normalizedKeyword) return false;
  const nTitle = normalizeForMatch(title);
  return !!nTitle && nTitle.includes(normalizedKeyword);
}

/**
 * Wraps a phase of processFileImport in start/end timestamp tracking and
 * writes a row to import_phase_timings. Also updates the live
 * uploaded_files.import_phase column at phase start so a stuck import
 * shows the exact phase it died in (the import_phase_timings table only
 * gets a row on phase completion).
 *
 * Phase-start logging matters: when the previous import wedged in
 * `copy_to_staging`, we couldn't tell from the DB whether COPY started
 * because no completion-time row exists for stuck phases. With the
 * import_phase column updated up front, we can tell at a glance.
 */
async function timePhase<T>(
  fileId: string,
  phase: string,
  work: () => Promise<T>,
  getRowCount?: (r: T) => number | null,
): Promise<T> {
  const startedAt = new Date();

  // Mark the live phase before doing work. If the work crashes the
  // process, this leaves a breadcrumb in uploaded_files.import_phase.
  try {
    await db.execute(sql`
      UPDATE uploaded_files
      SET import_phase = ${phase}
      WHERE id = ${fileId}
    `);
  } catch (e) {
    console.warn(`[phase] failed to set live phase "${phase}":`, e);
  }

  const result = await work();
  const endedAt = new Date();
  const durationMs = endedAt.getTime() - startedAt.getTime();
  try {
    await db.insert(importPhaseTimings).values({
      uploadedFileId: fileId,
      phase,
      startedAt,
      endedAt,
      durationMs,
      rowsAffected: getRowCount ? getRowCount(result) : null,
    });
  } catch (e) {
    console.warn(`[timing] failed to log phase "${phase}":`, e);
  }
  return result;
}

/**
 * Starts a 60s-interval heartbeat that bumps uploaded_files.import_heartbeat_at.
 * Returned function stops the heartbeat (called from finally block).
 *
 * Why: Before this, the lock was based on a fixed 60-minute expiry on
 * import_started_at. That was safe when imports took ~15 min, but as the
 * DB grew imports now routinely exceed 60 min — meaning the lock can
 * legally expire mid-import, allowing a retry to acquire it while the
 * first invocation is still running. With the heartbeat, "lock is stale"
 * means "no heartbeat for 3+ minutes" — which only happens if the worker
 * actually died.
 */
function startHeartbeat(fileId: string): () => Promise<void> {
  let stopped = false;
  const intervalId: NodeJS.Timeout = setInterval(async () => {
    if (stopped) return;
    try {
      await db.execute(
        sql`UPDATE uploaded_files SET import_heartbeat_at = NOW() WHERE id = ${fileId}`,
      );
    } catch (e) {
      console.warn(`[heartbeat] update failed for ${fileId.slice(0, 8)}:`, e);
    }
  }, 60_000);
  return async () => {
    stopped = true;
    clearInterval(intervalId);
  };
}

export async function processFileImport(input: ImportFileInput): Promise<ImportFileOutput> {
  // Atomic re-entry lock using the heartbeat. Succeeds only if:
  //  (a) no current heartbeat, OR
  //  (b) heartbeat is > 10 min stale (worker is genuinely dead), AND
  //  (c) file isn't already imported.
  // Also records BOOT_ID so post-mortem we can compare against the live
  // worker's BOOT_ID to confirm whether the original process is still
  // around or got restarted.
  //
  // Why 10 min (not 3): observed behavior on Feb 07 import showed the
  // heartbeat setInterval can stall for ~3-5 min during the long
  // kwm_insert phase even when the worker is alive — likely due to
  // Drizzle pool contention or pgbouncer-side queueing while the long
  // INSERT holds a connection. A 3-min threshold falsely flagged a
  // healthy in-flight import as orphaned. 10 min is well past any
  // legitimate stall but still recovers from a real worker death.
  const lockResult = await db.execute<{ id: string }>(sql`
    UPDATE uploaded_files
    SET import_started_at = NOW(),
        import_heartbeat_at = NOW(),
        import_worker_boot_id = ${BOOT_ID},
        import_phase = 'lock_acquired'
    WHERE id = ${input.uploadedFileId}
      AND (import_heartbeat_at IS NULL OR import_heartbeat_at < NOW() - INTERVAL '10 minutes')
      AND validation_status != 'imported'
    RETURNING id
  `);

  if (lockResult.rows.length === 0) {
    const existing = await db.query.uploadedFiles.findFirst({
      where: eq(uploadedFiles.id, input.uploadedFileId),
    });
    if (!existing) throw new Error(`uploaded file ${input.uploadedFileId} not found`);
    if (existing.validationStatus === 'imported') {
      return { rowsImported: existing.rowCountLoaded ?? 0 };
    }
    throw new Error(
      `file ${input.uploadedFileId.slice(0, 8)} is locked by another invocation (heartbeat at ${existing.importHeartbeatAt?.toISOString() ?? 'unknown'})`,
    );
  }

  const file = await db.query.uploadedFiles.findFirst({
    where: eq(uploadedFiles.id, input.uploadedFileId),
  });
  if (!file) throw new Error(`uploaded file ${input.uploadedFileId} not found`);
  if (!file.weekEndDate) throw new Error(`file ${input.uploadedFileId} has no weekEndDate`);

  const weekEndDate = file.weekEndDate;
  const weekStartDate = new Date(Date.parse(weekEndDate));
  weekStartDate.setUTCDate(weekStartDate.getUTCDate() - 6);
  const weekStartIso = weekStartDate.toISOString().slice(0, 10);

  const stopHeartbeat = startHeartbeat(file.id);

  try {
    // Clear any partial staging rows from a previous timed-out run of this file.
    // (TRUNCATE at the end of the pipeline keeps staging generally empty; this
    // DELETE handles the narrow case where a prior attempt staged but never
    // reached cleanup.)
    await timePhase(file.id, 'clear_staging', async () => {
      await db
        .delete(stagingWeeklyMetrics)
        .where(eq(stagingWeeklyMetrics.uploadedFileId, file.id));
    });

    // ------------------------------------------------------------------
    // Phase 1: COPY CSV into staging.
    // Uses pg-copy-streams on a dedicated pg.Pool with TCP keepalives.
    // COPY is ~50x faster than parameterized INSERTs for a 2.8M-row file.
    // ------------------------------------------------------------------
    const rowsStaged = await timePhase(
      file.id,
      'copy_to_staging',
      async () => {
        const stream = await downloadStreamFromR2(file.storageKey);
        let rowsStaged = 0;
        const pool = new Pool({
          connectionString: env.DATABASE_URL,
          keepAlive: true,
          keepAliveInitialDelayMillis: 10_000,
          connectionTimeoutMillis: 20_000,
        });
        pool.on('error', (err) => {
          console.warn('[copy pool] idle client error:', err.message);
        });
        const client = await pool.connect();
        try {
          const copySql = `
            COPY staging_weekly_metrics (
              batch_id, uploaded_file_id, week_end_date,
              search_term_raw, search_term_normalized,
              actual_rank,
              top_clicked_brand_1, top_clicked_brand_2, top_clicked_brand_3,
              top_clicked_category_1, top_clicked_category_2, top_clicked_category_3,
              top_clicked_product_1_asin, top_clicked_product_2_asin, top_clicked_product_3_asin,
              top_clicked_product_1_title, top_clicked_product_2_title, top_clicked_product_3_title,
              top_clicked_product_1_click_share, top_clicked_product_2_click_share, top_clicked_product_3_click_share,
              top_clicked_product_1_conversion_share, top_clicked_product_2_conversion_share, top_clicked_product_3_conversion_share,
              keyword_in_title_1, keyword_in_title_2, keyword_in_title_3, keyword_title_match_count
            ) FROM STDIN WITH (FORMAT text, NULL '\\N')
          `;
          const copyStream = client.query(copyFrom(copySql));

          // CRITICAL: attach error listener BEFORE the first write. If
          // pg-copy-streams emits 'error' mid-COPY (Postgres rejected a
          // row, NUL byte, length overflow, type mismatch, etc.) and no
          // listener is registered, Node throws and the process exits.
          // That was the root cause of the prior "stuck on Feb 07"
          // behavior — process died mid-COPY, Railway restarted the
          // container, Inngest's waitForEvent had no completion event
          // ever fired, lock heartbeat never advanced.
          let copyError: Error | null = null;
          copyStream.on('error', (err: Error) => {
            copyError = err;
            console.error(`[copy] error event for ${file.id.slice(0, 8)}:`, err.message);
          });

          const encodeField = (v: string | number | boolean | null | undefined): string => {
            if (v === null || v === undefined || v === '') return '\\N';
            // Strip NUL bytes — Postgres text/varchar cannot contain them
            // and pg-copy-streams will emit error mid-stream if it sees
            // one. Cheap defense; rare in normal Amazon CSVs but observed
            // in practice in some search-term values.
            const s = String(v).replace(/\u0000/g, '');
            return s
              .replace(/\\/g, '\\\\')
              .replace(/\t/g, '\\t')
              .replace(/\n/g, '\\n')
              .replace(/\r/g, '\\r');
          };

          const waitForDrainOrError = (): Promise<void> =>
            new Promise<void>((resolve, reject) => {
              const onDrain = () => {
                copyStream.removeListener('error', onError);
                resolve();
              };
              const onError = (err: Error) => {
                copyStream.removeListener('drain', onDrain);
                reject(err);
              };
              copyStream.once('drain', onDrain);
              copyStream.once('error', onError);
            });

          for await (const row of streamParseCsv(stream)) {
            // If the COPY socket already errored, surface it immediately
            // rather than continuing to write into a dead stream.
            if (copyError) throw copyError;

            const searchTerm = row['Search Term'];
            const normalizedTerm =
              normalizeForMatch(searchTerm) ||
              searchTerm.toLowerCase().trim() ||
              '__unparseable__';
            const t1 = row['Top Clicked Product #1: Product Title'] ?? null;
            const t2 = row['Top Clicked Product #2: Product Title'] ?? null;
            const t3 = row['Top Clicked Product #3: Product Title'] ?? null;
            const inT1 = titleContainsKeyword(normalizedTerm, t1);
            const inT2 = titleContainsKeyword(normalizedTerm, t2);
            const inT3 = titleContainsKeyword(normalizedTerm, t3);
            const matchCount = (inT1 ? 1 : 0) + (inT2 ? 1 : 0) + (inT3 ? 1 : 0);
            const fields = [
              file.batchId,
              file.id,
              weekEndDate,
              searchTerm,
              normalizedTerm,
              Number(row['Search Frequency Rank']),
              row['Top Clicked Brand #1'] || null,
              row['Top Clicked Brands #2'] || null,
              row['Top Clicked Brands #3'] || null,
              row['Top Clicked Category #1'] || null,
              row['Top Clicked Category #2'] || null,
              row['Top Clicked Category #3'] || null,
              row['Top Clicked Product #1: ASIN'] || null,
              row['Top Clicked Product #2: ASIN'] || null,
              row['Top Clicked Product #3: ASIN'] || null,
              t1,
              t2,
              t3,
              toNumeric(row['Top Clicked Product #1: Click Share']),
              toNumeric(row['Top Clicked Product #2: Click Share']),
              toNumeric(row['Top Clicked Product #3: Click Share']),
              toNumeric(row['Top Clicked Product #1: Conversion Share']),
              toNumeric(row['Top Clicked Product #2: Conversion Share']),
              toNumeric(row['Top Clicked Product #3: Conversion Share']),
              inT1 ? 't' : 'f',
              inT2 ? 't' : 'f',
              inT3 ? 't' : 'f',
              matchCount,
            ];
            const line = fields.map(encodeField).join('\t') + '\n';
            // Use the version that races drain vs. error — without this,
            // a backpressure pause that's interrupted by an error would
            // hang forever waiting for 'drain'.
            if (!copyStream.write(line)) {
              await waitForDrainOrError();
            }
            rowsStaged++;
          }

          if (copyError) throw copyError;

          copyStream.end();

          // Final completion: race finish vs. error so a late-emitting
          // error during COPY commit (e.g., constraint violation that
          // surfaces server-side after we've sent all rows) propagates
          // properly instead of just hanging.
          await new Promise<void>((resolve, reject) => {
            const onFinish = () => {
              copyStream.removeListener('error', onError);
              resolve();
            };
            const onError = (err: Error) => {
              copyStream.removeListener('finish', onFinish);
              reject(err);
            };
            copyStream.once('finish', onFinish);
            copyStream.once('error', onError);
          });
        } finally {
          client.release();
          await pool.end();
        }
        return rowsStaged;
      },
      (n) => n,
    );

    // ------------------------------------------------------------------
    // Phase 2: upsert search_terms.
    // DO NOTHING (not DO UPDATE) — we no longer maintain first_seen_week /
    // last_seen_week on every import. Those can be recomputed from kwm in
    // a post-backfill job (MIN/MAX(week_end_date) GROUP BY search_term_id).
    // Eliminates ~2M tuple updates per file + associated WAL + index churn.
    // ------------------------------------------------------------------
    await timePhase(file.id, 'search_terms_upsert', async () => {
      await db.execute(sql`
        INSERT INTO search_terms (search_term_raw, search_term_normalized, first_seen_week, last_seen_week)
        SELECT DISTINCT ON (search_term_normalized)
          search_term_raw, search_term_normalized, ${weekEndDate}::date, ${weekEndDate}::date
        FROM staging_weekly_metrics
        WHERE uploaded_file_id = ${file.id}
        ON CONFLICT (search_term_normalized) DO NOTHING
      `);
    });

    // ------------------------------------------------------------------
    // Phase 3: promote to keyword_weekly_metrics.
    //
    // Big architectural change: we no longer UPDATE staging.search_term_id
    // as a pre-step. Instead we JOIN staging to search_terms directly in
    // the INSERT's SELECT. This saves a full ~2.8M-row UPDATE on the
    // wide staging table (which previously rewrote every row, generated
    // massive WAL, and left 2.8M dead tuples per import for vacuum to
    // reclaim).
    // ------------------------------------------------------------------
    if (file.isReplacement) {
      // Replacement flow: nuke existing week, INSERT fresh. No ON CONFLICT.
      await timePhase(file.id, 'kwm_delete_week', async () => {
        await db.execute(
          sql`DELETE FROM keyword_weekly_metrics WHERE week_end_date = ${weekEndDate}::date`,
        );
      });
      await timePhase(file.id, 'kwm_insert_replace', async () => {
        await db.execute(sql`
          INSERT INTO keyword_weekly_metrics (
            week_end_date, search_term_id, actual_rank,
            top_clicked_brand_1, top_clicked_brand_2, top_clicked_brand_3,
            top_clicked_category_1, top_clicked_category_2, top_clicked_category_3,
            top_clicked_product_1_asin, top_clicked_product_2_asin, top_clicked_product_3_asin,
            top_clicked_product_1_title, top_clicked_product_2_title, top_clicked_product_3_title,
            top_clicked_product_1_click_share, top_clicked_product_2_click_share, top_clicked_product_3_click_share,
            top_clicked_product_1_conversion_share, top_clicked_product_2_conversion_share, top_clicked_product_3_conversion_share,
            keyword_in_title_1, keyword_in_title_2, keyword_in_title_3, keyword_title_match_count,
            source_file_id
          )
          SELECT
            s.week_end_date, st.id, s.actual_rank,
            s.top_clicked_brand_1, s.top_clicked_brand_2, s.top_clicked_brand_3,
            s.top_clicked_category_1, s.top_clicked_category_2, s.top_clicked_category_3,
            s.top_clicked_product_1_asin, s.top_clicked_product_2_asin, s.top_clicked_product_3_asin,
            s.top_clicked_product_1_title, s.top_clicked_product_2_title, s.top_clicked_product_3_title,
            s.top_clicked_product_1_click_share, s.top_clicked_product_2_click_share, s.top_clicked_product_3_click_share,
            s.top_clicked_product_1_conversion_share, s.top_clicked_product_2_conversion_share, s.top_clicked_product_3_conversion_share,
            s.keyword_in_title_1, s.keyword_in_title_2, s.keyword_in_title_3, s.keyword_title_match_count,
            ${file.id}
          FROM staging_weekly_metrics s
          JOIN search_terms st ON st.search_term_normalized = s.search_term_normalized
          WHERE s.uploaded_file_id = ${file.id}
        `);
      });
    } else {
      await timePhase(file.id, 'kwm_insert', async () => {
        await db.execute(sql`
          INSERT INTO keyword_weekly_metrics (
            week_end_date, search_term_id, actual_rank,
            top_clicked_brand_1, top_clicked_brand_2, top_clicked_brand_3,
            top_clicked_category_1, top_clicked_category_2, top_clicked_category_3,
            top_clicked_product_1_asin, top_clicked_product_2_asin, top_clicked_product_3_asin,
            top_clicked_product_1_title, top_clicked_product_2_title, top_clicked_product_3_title,
            top_clicked_product_1_click_share, top_clicked_product_2_click_share, top_clicked_product_3_click_share,
            top_clicked_product_1_conversion_share, top_clicked_product_2_conversion_share, top_clicked_product_3_conversion_share,
            keyword_in_title_1, keyword_in_title_2, keyword_in_title_3, keyword_title_match_count,
            source_file_id
          )
          SELECT
            s.week_end_date, st.id, s.actual_rank,
            s.top_clicked_brand_1, s.top_clicked_brand_2, s.top_clicked_brand_3,
            s.top_clicked_category_1, s.top_clicked_category_2, s.top_clicked_category_3,
            s.top_clicked_product_1_asin, s.top_clicked_product_2_asin, s.top_clicked_product_3_asin,
            s.top_clicked_product_1_title, s.top_clicked_product_2_title, s.top_clicked_product_3_title,
            s.top_clicked_product_1_click_share, s.top_clicked_product_2_click_share, s.top_clicked_product_3_click_share,
            s.top_clicked_product_1_conversion_share, s.top_clicked_product_2_conversion_share, s.top_clicked_product_3_conversion_share,
            s.keyword_in_title_1, s.keyword_in_title_2, s.keyword_in_title_3, s.keyword_title_match_count,
            ${file.id}
          FROM staging_weekly_metrics s
          JOIN search_terms st ON st.search_term_normalized = s.search_term_normalized
          WHERE s.uploaded_file_id = ${file.id}
          ON CONFLICT (week_end_date, search_term_id) DO NOTHING
        `);
      });
    }

    // ------------------------------------------------------------------
    // Phase 4: reporting_weeks + staging cleanup.
    //
    // TRUNCATE is safe because importFileFn has concurrency:{limit:1} — no
    // other import is using staging while we're here. TRUNCATE is
    // fast (metadata-only, no per-row WAL) and reclaims space immediately
    // (vs DELETE which leaves dead tuples for vacuum). This was the big
    // source of staging-table bloat across many imports.
    // ------------------------------------------------------------------
    await timePhase(file.id, 'reporting_weeks_upsert', async () => {
      await db
        .insert(reportingWeeks)
        .values({
          weekEndDate,
          weekStartDate: weekStartIso,
          sourceFileId: file.id,
          isComplete: true,
        })
        .onConflictDoUpdate({
          target: reportingWeeks.weekEndDate,
          set: { sourceFileId: file.id, isComplete: true },
        });
    });

    // Use targeted DELETE rather than TRUNCATE. Earlier we used TRUNCATE
    // because importFileFn had concurrency:{limit:1} and only one file's
    // staging rows existed at a time. But the orchestrator's "orphan and
    // move on" behavior can spawn a second detached Promise for a
    // different file BEFORE the first one finishes its pipeline — so
    // staging may legitimately contain rows for two files simultaneously.
    // TRUNCATE wipes the entire table, including the other file's
    // in-flight COPY data, causing the "INSERT into kwm SELECT FROM
    // staging" of THAT file to insert 0 rows and silently succeed
    // (status=imported, kwm=0). Switching to DELETE WHERE
    // uploaded_file_id = X scopes cleanup to just our own file.
    await timePhase(file.id, 'staging_cleanup', async () => {
      await db
        .delete(stagingWeeklyMetrics)
        .where(eq(stagingWeeklyMetrics.uploadedFileId, file.id));
    });

    await timePhase(file.id, 'mark_imported', async () => {
      await db
        .update(uploadedFiles)
        .set({
          validationStatus: 'imported',
          importedAt: new Date(),
          rowCountLoaded: rowsStaged,
          importStartedAt: null,
          importHeartbeatAt: null,
          // Clear any stale error blob the orchestrator may have written
          // when it (incorrectly) declared this run orphaned. The race
          // can happen if the heartbeat stalled briefly during a long
          // phase; we now win the race correctness-wise but the error
          // blob would otherwise linger and confuse the UI.
          validationErrorsJson: null,
        })
        .where(eq(uploadedFiles.id, file.id));
    });

    return { rowsImported: rowsStaged };
  } finally {
    await stopHeartbeat();
  }
}

export const importFileFn = inngest.createFunction(
  {
    id: 'import-file',
    name: 'Import file to keyword_weekly_metrics',
    concurrency: { limit: 1 },
    retries: 0,
    triggers: [{ event: 'csv/file.import' }],
  },
  async ({ event, step }) => {
    const data = event.data as { uploadedFileId: string };
    return step.run('import', () =>
      processFileImport({
        uploadedFileId: data.uploadedFileId,
      }),
    );
  },
);
