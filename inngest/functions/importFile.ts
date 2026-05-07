import { eq, sql } from 'drizzle-orm';
import { Pool, Client as PgClient } from 'pg';
import { from as copyFrom } from 'pg-copy-streams';
import { inngest } from '../client';
import { downloadStreamFromR2 } from '@/lib/storage/r2';
import { streamParseCsv } from '@/lib/csv/streamParse';
import {
  cleanSearchTermForDisplay,
  hadUnicodeNoise,
  normalizeForMatch,
} from '@/lib/analytics/derivedFields';
import { env } from '@/lib/env';
import { BOOT_ID } from '@/lib/runtime';
import { db } from '@/db/client';
import {
  uploadedFiles,
  stagingWeeklyMetrics,
  reportingWeeks,
  importPhaseTimings,
} from '@/db/schema';
import { refreshKeywordCurrentSummary } from './refreshSummary';
import { sendImportEmail } from '@/lib/notifications/sendImportEmail';

export interface ImportFileInput {
  uploadedFileId: string;
  /**
   * If true, skip the kcs refresh + email notification at the end of
   * processFileImport. Used by the bulk historical-replay job to avoid
   * paying ~30 min of refresh cost per file (53 files × 30 min ≈ 26 hr
   * saved). The replay caller is responsible for running one final
   * refresh after all files complete.
   */
  skipRefresh?: boolean;
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
 * Promote staging rows to keyword_weekly_metrics with deterministic
 * deduplication of (week_end_date, search_term_id) groups.
 *
 * Why this exists: Amazon's BA CSV exports sometimes contain phantom
 * duplicate rows for popular keywords (e.g. "essential oils" + an
 * OBJ-prefixed copy at a junk rank). Both rows resolve to the same
 * search_term_id via normalization. The previous import used
 * `ON CONFLICT DO NOTHING` which left it to Postgres to non-
 * deterministically pick a winner — about 5-15% of popular keyword
 * weeks ended up showing the phantom row's junk rank.
 *
 * The fix here:
 *   1. CTE builds candidate rows by joining staging to search_terms,
 *      with a row_number() over (week, term_id) ordered by rank ASC,
 *      then no-noise preference, then source_row_number for a
 *      deterministic final tiebreak.
 *   2. We log every duplicate group to import_duplicate_search_terms
 *      for forensics (this gets us a paper trail of which CSVs ship
 *      noise rows and how often).
 *   3. We INSERT only `rn = 1` winners into kwm.
 *   4. ON CONFLICT DO UPDATE replaces an existing row only if the new
 *      row differs (re-imports of the same data are no-ops; corrections
 *      go through cleanly).
 *
 * The CHECK that the input batch contains no duplicates of the conflict
 * key is enforced by the CTE itself — we filter to rn=1 before INSERT,
 * so Postgres never sees more than one row per (week, term_id) per
 * statement and can't raise a cardinality violation.
 */
async function runStagingToKwmInsert(fileId: string): Promise<void> {
  // 1. Audit-log duplicate groups BEFORE the kwm INSERT runs. This
  //    keeps the forensic record even if the INSERT itself errors.
  await db.execute(sql`
    INSERT INTO import_duplicate_search_terms (
      uploaded_file_id, week_end_date, search_term_id,
      search_term_normalized, duplicate_count, winning_rank,
      losing_ranks, raw_examples
    )
    SELECT
      s.uploaded_file_id,
      s.week_end_date,
      st.id,
      s.search_term_normalized,
      COUNT(*)::int,
      MIN(s.actual_rank)::int,
      ARRAY_AGG(s.actual_rank ORDER BY s.actual_rank ASC),
      (ARRAY_AGG(LEFT(s.search_term_raw_original, 200) ORDER BY s.actual_rank ASC))[1:3]
    FROM staging_weekly_metrics s
    JOIN search_terms st ON st.search_term_normalized = s.search_term_normalized
    WHERE s.uploaded_file_id = ${fileId}
    GROUP BY s.uploaded_file_id, s.week_end_date, st.id, s.search_term_normalized
    HAVING COUNT(*) > 1
  `);

  // 2. INSERT winners (rn=1) into kwm with safe upsert.
  await db.execute(sql`
    WITH candidates AS (
      SELECT
        s.*,
        st.id AS term_id,
        ROW_NUMBER() OVER (
          PARTITION BY s.week_end_date, st.id
          ORDER BY
            s.actual_rank ASC,             -- prefer the row with the lower (better) rank
            s.had_unicode_noise ASC,       -- false < true: prefer clean rows
            s.source_row_number ASC        -- final deterministic tiebreak
        ) AS rn
      FROM staging_weekly_metrics s
      JOIN search_terms st ON st.search_term_normalized = s.search_term_normalized
      WHERE s.uploaded_file_id = ${fileId}
    )
    INSERT INTO keyword_weekly_metrics AS kwm (
      week_end_date, search_term_id, actual_rank,
      top_clicked_brand_1, top_clicked_brand_2, top_clicked_brand_3,
      top_clicked_category_1, top_clicked_category_2, top_clicked_category_3,
      top_clicked_product_1_asin, top_clicked_product_2_asin, top_clicked_product_3_asin,
      top_clicked_product_1_title, top_clicked_product_2_title, top_clicked_product_3_title,
      top_clicked_product_1_click_share, top_clicked_product_2_click_share, top_clicked_product_3_click_share,
      top_clicked_product_1_conversion_share, top_clicked_product_2_conversion_share, top_clicked_product_3_conversion_share,
      keyword_in_title_1, keyword_in_title_2, keyword_in_title_3, keyword_title_match_count,
      fake_volume_severity, fake_volume_eval_status,
      source_file_id
    )
    SELECT
      week_end_date, term_id, actual_rank,
      top_clicked_brand_1, top_clicked_brand_2, top_clicked_brand_3,
      top_clicked_category_1, top_clicked_category_2, top_clicked_category_3,
      top_clicked_product_1_asin, top_clicked_product_2_asin, top_clicked_product_3_asin,
      top_clicked_product_1_title, top_clicked_product_2_title, top_clicked_product_3_title,
      top_clicked_product_1_click_share, top_clicked_product_2_click_share, top_clicked_product_3_click_share,
      top_clicked_product_1_conversion_share, top_clicked_product_2_conversion_share, top_clicked_product_3_conversion_share,
      keyword_in_title_1, keyword_in_title_2, keyword_in_title_3, keyword_title_match_count,
      CASE
        WHEN top_clicked_product_1_click_share IS NULL
          OR top_clicked_product_1_conversion_share IS NULL THEN NULL
        WHEN (top_clicked_product_1_click_share > 20 AND top_clicked_product_1_conversion_share < 0.5)
          OR (top_clicked_product_1_click_share > 30 AND top_clicked_product_1_conversion_share < 1.0)
          THEN 'critical'::fake_volume_severity
        WHEN (top_clicked_product_1_click_share > 5 AND top_clicked_product_1_conversion_share < 0.5)
          OR (top_clicked_product_1_click_share > 10 AND top_clicked_product_1_conversion_share < 1.0)
          THEN 'warning'::fake_volume_severity
        ELSE 'none'::fake_volume_severity
      END AS fake_volume_severity,
      CASE
        WHEN top_clicked_product_1_click_share IS NULL THEN 'unknown_missing_click'::fake_volume_eval_status
        WHEN top_clicked_product_1_conversion_share IS NULL THEN 'unknown_missing_conversion'::fake_volume_eval_status
        ELSE 'evaluated'::fake_volume_eval_status
      END AS fake_volume_eval_status,
      ${fileId}
    FROM candidates
    WHERE rn = 1
    ON CONFLICT (week_end_date, search_term_id) DO UPDATE SET
      actual_rank = EXCLUDED.actual_rank,
      top_clicked_brand_1 = EXCLUDED.top_clicked_brand_1,
      top_clicked_brand_2 = EXCLUDED.top_clicked_brand_2,
      top_clicked_brand_3 = EXCLUDED.top_clicked_brand_3,
      top_clicked_category_1 = EXCLUDED.top_clicked_category_1,
      top_clicked_category_2 = EXCLUDED.top_clicked_category_2,
      top_clicked_category_3 = EXCLUDED.top_clicked_category_3,
      top_clicked_product_1_asin = EXCLUDED.top_clicked_product_1_asin,
      top_clicked_product_2_asin = EXCLUDED.top_clicked_product_2_asin,
      top_clicked_product_3_asin = EXCLUDED.top_clicked_product_3_asin,
      top_clicked_product_1_title = EXCLUDED.top_clicked_product_1_title,
      top_clicked_product_2_title = EXCLUDED.top_clicked_product_2_title,
      top_clicked_product_3_title = EXCLUDED.top_clicked_product_3_title,
      top_clicked_product_1_click_share = EXCLUDED.top_clicked_product_1_click_share,
      top_clicked_product_2_click_share = EXCLUDED.top_clicked_product_2_click_share,
      top_clicked_product_3_click_share = EXCLUDED.top_clicked_product_3_click_share,
      top_clicked_product_1_conversion_share = EXCLUDED.top_clicked_product_1_conversion_share,
      top_clicked_product_2_conversion_share = EXCLUDED.top_clicked_product_2_conversion_share,
      top_clicked_product_3_conversion_share = EXCLUDED.top_clicked_product_3_conversion_share,
      keyword_in_title_1 = EXCLUDED.keyword_in_title_1,
      keyword_in_title_2 = EXCLUDED.keyword_in_title_2,
      keyword_in_title_3 = EXCLUDED.keyword_in_title_3,
      keyword_title_match_count = EXCLUDED.keyword_title_match_count,
      fake_volume_severity = EXCLUDED.fake_volume_severity,
      fake_volume_eval_status = EXCLUDED.fake_volume_eval_status,
      source_file_id = EXCLUDED.source_file_id
    WHERE
      kwm.actual_rank IS DISTINCT FROM EXCLUDED.actual_rank
      OR kwm.top_clicked_product_1_asin IS DISTINCT FROM EXCLUDED.top_clicked_product_1_asin
      OR kwm.top_clicked_product_1_title IS DISTINCT FROM EXCLUDED.top_clicked_product_1_title
      OR kwm.top_clicked_product_1_click_share IS DISTINCT FROM EXCLUDED.top_clicked_product_1_click_share
      OR kwm.top_clicked_product_1_conversion_share IS DISTINCT FROM EXCLUDED.top_clicked_product_1_conversion_share
      OR kwm.fake_volume_severity IS DISTINCT FROM EXCLUDED.fake_volume_severity
  `);
}

/**
 * Dedicated long-lived pg connection for heartbeat updates.
 *
 * Why a separate connection (not Drizzle's pool):
 *   The kwm_insert phase holds a pool connection for 10-30 min. Other
 *   pool connections are also borrowed by orchestrator status-check
 *   queries that may run concurrently. If the heartbeat update has to
 *   acquire a fresh pool connection at exactly the wrong moment — or
 *   queues behind anything else — it can stall for many minutes.
 *   Observed: a healthy Jan 10 import had heartbeat go > 30 min stale
 *   while the kwm_insert was actively progressing in Postgres.
 *
 *   A dedicated client owns ONE connection for the entire process
 *   lifetime. The heartbeat query never has to wait to acquire one.
 *   It also keeps TCP keepalive alive on a known socket so we'd notice
 *   a real disconnect quickly.
 */
let heartbeatClient: PgClient | null = null;
let heartbeatClientPromise: Promise<PgClient> | null = null;
async function getHeartbeatClient(): Promise<PgClient> {
  if (heartbeatClient) return heartbeatClient;
  if (heartbeatClientPromise) return heartbeatClientPromise;
  heartbeatClientPromise = (async () => {
    const c = new PgClient({
      connectionString: env.DATABASE_URL,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
      connectionTimeoutMillis: 20_000,
    });
    c.on('error', (err) => {
      console.warn('[heartbeat client] connection error:', err.message);
      // Force re-create on next use; don't try to reuse a broken client.
      heartbeatClient = null;
      heartbeatClientPromise = null;
    });
    await c.connect();
    heartbeatClient = c;
    heartbeatClientPromise = null;
    return c;
  })();
  return heartbeatClientPromise;
}

/**
 * Starts a 60s-interval heartbeat that bumps uploaded_files.import_heartbeat_at.
 * Returned function stops the heartbeat (called from finally block).
 *
 * Uses a dedicated pg.Client (not Drizzle's pool) so heartbeat updates
 * never queue behind a long INSERT or other pool-contended query.
 */
function startHeartbeat(fileId: string): () => Promise<void> {
  let stopped = false;
  const intervalId: NodeJS.Timeout = setInterval(async () => {
    if (stopped) return;
    try {
      const c = await getHeartbeatClient();
      await c.query(
        `UPDATE uploaded_files SET import_heartbeat_at = NOW() WHERE id = $1`,
        [fileId],
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
  //  (b) heartbeat is > 60 min stale (worker is genuinely dead), AND
  //  (c) file isn't already imported.
  //
  // 60 min threshold is paired with a DEDICATED heartbeat connection
  // (see getHeartbeatClient above). With that, the heartbeat should
  // never miss a tick under load. If it DOES go silent for 60+ min,
  // the worker is genuinely gone (process exited, container restart,
  // network partition). 60 min lets a real dead worker be reclaimed
  // within reasonable time without false-orphaning a slow import.
  // For bulk historical replay we INTENTIONALLY want to re-process
  // files that are already validation_status='imported'. The lock
  // condition relaxes to "heartbeat stale" only — the imported-status
  // check is dropped.
  const lockResult = input.skipRefresh
    ? await db.execute<{ id: string }>(sql`
        UPDATE uploaded_files
        SET import_started_at = NOW(),
            import_heartbeat_at = NOW(),
            import_worker_boot_id = ${BOOT_ID},
            import_phase = 'lock_acquired'
        WHERE id = ${input.uploadedFileId}
          AND (import_heartbeat_at IS NULL OR import_heartbeat_at < NOW() - INTERVAL '60 minutes')
        RETURNING id
      `)
    : await db.execute<{ id: string }>(sql`
        UPDATE uploaded_files
        SET import_started_at = NOW(),
            import_heartbeat_at = NOW(),
            import_worker_boot_id = ${BOOT_ID},
            import_phase = 'lock_acquired'
        WHERE id = ${input.uploadedFileId}
          AND (import_heartbeat_at IS NULL OR import_heartbeat_at < NOW() - INTERVAL '60 minutes')
          AND validation_status != 'imported'
        RETURNING id
      `);

  if (lockResult.rows.length === 0) {
    const existing = await db.query.uploadedFiles.findFirst({
      where: eq(uploadedFiles.id, input.uploadedFileId),
    });
    if (!existing) throw new Error(`uploaded file ${input.uploadedFileId} not found`);
    if (!input.skipRefresh && existing.validationStatus === 'imported') {
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
              search_term_raw_original, search_term_raw, search_term_normalized,
              had_unicode_noise, source_row_number,
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

          let sourceRowNumber = 0;
          for await (const row of streamParseCsv(stream)) {
            // If the COPY socket already errored, surface it immediately
            // rather than continuing to write into a dead stream.
            if (copyError) throw copyError;

            sourceRowNumber++;
            const searchTermOriginal = row['Search Term'];
            // Clean for display: strip invisible noise (OBJ, ZWSP, etc.),
            // collapse whitespace, NFC. This is what gets stored as
            // staging.search_term_raw and ultimately surfaces in the UI.
            const searchTermCleaned = cleanSearchTermForDisplay(searchTermOriginal);
            const noisy = hadUnicodeNoise(searchTermOriginal);
            // Normalize from the cleaned form for the match key. Fallback
            // to a deterministic non-empty value if normalization yields
            // empty (e.g., search term was entirely noise).
            const normalizedTerm =
              normalizeForMatch(searchTermCleaned) ||
              searchTermCleaned.toLowerCase().trim() ||
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
              searchTermOriginal,
              searchTermCleaned,
              normalizedTerm,
              noisy ? 't' : 'f',
              sourceRowNumber,
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
    // DO UPDATE on conflict, maintaining first_seen_week / last_seen_week.
    // We used DO NOTHING during the 52-week backfill to avoid ~2M tuple
    // rewrites per import × 52 imports. Now that we're in steady state
    // (1 file/week), the per-import cost is small (~2-4 min on a 60M+
    // row search_terms table) and keeps these aggregate columns correct
    // without needing a separate recompute job.
    // ------------------------------------------------------------------
    await timePhase(file.id, 'search_terms_upsert', async () => {
      // Note: staging.search_term_raw now stores the CLEANED display
      // form (NFC + invisible-stripped). On conflict we also refresh
      // search_terms.search_term_raw to that clean value if it differs
      // — this is how existing rows that were created with OBJ-prefixed
      // raws get healed during the historical replay.
      await db.execute(sql`
        INSERT INTO search_terms (search_term_raw, search_term_normalized, first_seen_week, last_seen_week)
        SELECT DISTINCT ON (search_term_normalized)
          search_term_raw, search_term_normalized, ${weekEndDate}::date, ${weekEndDate}::date
        FROM staging_weekly_metrics
        WHERE uploaded_file_id = ${file.id}
        ON CONFLICT (search_term_normalized) DO UPDATE
          SET last_seen_week = GREATEST(search_terms.last_seen_week, EXCLUDED.last_seen_week),
              first_seen_week = LEAST(search_terms.first_seen_week, EXCLUDED.first_seen_week),
              search_term_raw = EXCLUDED.search_term_raw
          WHERE
            search_terms.last_seen_week < EXCLUDED.last_seen_week
            OR search_terms.first_seen_week > EXCLUDED.first_seen_week
            OR search_terms.search_term_raw <> EXCLUDED.search_term_raw
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
      // Replacement flow: nuke existing week, then INSERT fresh through
      // the dedup pipeline below. Staging dedup still applies — even
      // a fresh week could contain Amazon's phantom OBJ-prefixed rows.
      await timePhase(file.id, 'kwm_delete_week', async () => {
        await db.execute(
          sql`DELETE FROM keyword_weekly_metrics WHERE week_end_date = ${weekEndDate}::date`,
        );
      });
      await timePhase(file.id, 'kwm_insert_replace', async () => {
        await runStagingToKwmInsert(file.id);
      });
    } else {
      await timePhase(file.id, 'kwm_insert', async () => {
        await runStagingToKwmInsert(file.id);
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

    // ------------------------------------------------------------------
    // Phase 5: refresh keyword_current_summary (Plan 3.1).
    //
    // Runs AFTER mark_imported deliberately: if the refresh fails for
    // any reason, the file is still correctly marked 'imported' (its
    // data IS in kwm), and we just have a stale summary that can be
    // fixed with `pnpm tsx scripts/refreshSummaryOnce.ts`. Catching
    // here means a flaky summary refresh doesn't make the orchestrator
    // think the import failed.
    // ------------------------------------------------------------------
    let summaryRefreshOk = true;
    let refreshResult: { rowsWritten: number; currentWeekEndDate: string } | null = null;
    let refreshErrorMessage: string | undefined;
    if (input.skipRefresh) {
      // Bulk historical-replay path: caller will run one final refresh
      // after all files complete. No per-file refresh, no email per file.
      summaryRefreshOk = true;
    } else {
      try {
        refreshResult = await timePhase(file.id, 'summary_refresh', async () => {
          return await refreshKeywordCurrentSummary();
        });
      } catch (refreshErr) {
        summaryRefreshOk = false;
        refreshErrorMessage = refreshErr instanceof Error ? refreshErr.message : String(refreshErr);
        console.error(
          `[summary_refresh] failed for file ${file.id.slice(0, 8)}, but kwm import succeeded — recover with refreshSummaryOnce.ts. Error:`,
          refreshErrorMessage,
        );
      }
    }

    // Final phase mark. The `import_phase` column is a breadcrumb of the
    // last phase the worker entered; without an explicit "we're done"
    // write here it would stay stuck on 'summary_refresh' forever, even
    // after a successful import. The admin UI / notification system
    // distinguishes 'completed' (full success) from 'completed_with_refresh_failure'
    // (kwm rows landed but kcs is stale and needs a manual recovery).
    await db
      .update(uploadedFiles)
      .set({
        importPhase: summaryRefreshOk ? 'completed' : 'completed_with_refresh_failure',
      })
      .where(eq(uploadedFiles.id, file.id));

    // Notify admins via email — but skip for bulk replay runs to avoid
    // 53 emails landing in the admin's inbox over the course of an
    // overnight job. The replay caller emails one summary at the end.
    if (!input.skipRefresh) {
      const durationMs = file.importStartedAt
        ? Date.now() - new Date(file.importStartedAt).getTime()
        : undefined;
      await sendImportEmail({
        outcome: summaryRefreshOk ? 'completed' : 'completed_with_refresh_failure',
        filename: file.originalFilename ?? '(unknown filename)',
        batchId: file.batchId,
        durationMs,
        rowsImported: rowsStaged,
        rowsInSummary: refreshResult?.rowsWritten,
        latestWeek: refreshResult?.currentWeekEndDate,
        errorMessage: refreshErrorMessage,
      });
    }

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
