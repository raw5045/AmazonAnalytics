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
  /**
   * If true, use the targeted-repair path instead of the full UPSERT
   * path: TRUNCATE staging instead of DELETE-by-uploaded_file_id; skip
   * search_terms_upsert (existing terms are already correct from the
   * original import); use runStagingToKwmTargetedRepair for the kwm
   * promotion (only touches duplicate-group rows).
   *
   * ~3-4× faster per file than the upsert path because we avoid 3M
   * cold-cache wide-row IS-DISTINCT-FROM comparisons.
   *
   * Implies skipRefresh and that the file is already imported — see
   * docs/replay-slowness-rfc.md.
   */
  replayMode?: boolean;
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
 * SQL fragment that evaluates to a boolean (or NULL when the title is
 * NULL): TRUE iff every non-stopword token in the search term appears
 * in the title with word-boundary semantics. Mirrors the JS
 * cleanSearchTermForDisplay + normalizeForMatch + word-by-word check.
 *
 * `searchTermSql` and `titleSql` should each be SQL expressions that
 * resolve to a text column or string. They get plugged into POSITION
 * checks against a padded-and-cleaned form built inline.
 *
 * Used by both the import path's kwm INSERT and the historical
 * backfill (scripts/backfillKwmLooseFlags.ts).
 */
/**
 * Rank threshold for loose computation. Rows with actual_rank > this
 * are functionally zero-traffic noise; we skip loose computation for
 * them to match the historical backfill behavior. Loose columns stay
 * NULL on those rows.
 */
const LOOSE_RANK_THRESHOLD = 1_000_000;

/**
 * Build a SQL expression that calls loose_title_flags_3() — the
 * single-function-call matcher introduced in migration 0016. Returns
 * a `loose_title_flags` composite (f1, f2, f3, match_count). The
 * caller is expected to alias the result and project the fields via
 * `(alias).f1` etc.
 *
 * Skips the matcher entirely for rows with actual_rank > LOOSE_RANK_THRESHOLD
 * (returns a NULL composite, so all loose columns end up NULL — consistent
 * with the historical backfill).
 *
 * `rankSql` should evaluate to the actual_rank column. The other args
 * are SQL expressions resolving to the search-term + title + strict-flag
 * columns.
 */
function looseFlagsCall(
  searchSql: string,
  titlePrefix: string,
  strictPrefix: string,
  rankSql: string,
): string {
  return `(CASE
    WHEN ${rankSql} > ${LOOSE_RANK_THRESHOLD} THEN NULL::loose_title_flags
    ELSE loose_title_flags_3(
      ${searchSql},
      ${titlePrefix}_1_title, ${titlePrefix}_2_title, ${titlePrefix}_3_title,
      ${strictPrefix}_1, ${strictPrefix}_2, ${strictPrefix}_3
    )
  END)`;
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
    ),
    with_flags AS (
      -- Filter to winners (rn=1) and compute all 3 loose flags + count
      -- in one function call per row via loose_title_flags_3 (composite
      -- return: f1, f2, f3, match_count). The function inlines the
      -- null-title and strict-true shortcuts.
      SELECT
        *,
        ${sql.raw(looseFlagsCall('search_term_normalized', 'top_clicked_product', 'keyword_in_title', 'actual_rank'))} AS lf
      FROM candidates
      WHERE rn = 1
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
      keyword_in_title_1_loose, keyword_in_title_2_loose, keyword_in_title_3_loose, keyword_title_match_count_loose,
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
      (lf).f1 AS keyword_in_title_1_loose,
      (lf).f2 AS keyword_in_title_2_loose,
      (lf).f3 AS keyword_in_title_3_loose,
      (lf).match_count AS keyword_title_match_count_loose,
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
    FROM with_flags
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
      keyword_in_title_1_loose = EXCLUDED.keyword_in_title_1_loose,
      keyword_in_title_2_loose = EXCLUDED.keyword_in_title_2_loose,
      keyword_in_title_3_loose = EXCLUDED.keyword_in_title_3_loose,
      keyword_title_match_count_loose = EXCLUDED.keyword_title_match_count_loose,
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
      OR kwm.keyword_in_title_1_loose IS DISTINCT FROM EXCLUDED.keyword_in_title_1_loose
  `);
}

/**
 * Targeted-repair version of the staging→kwm promotion. ONLY touches
 * (week, term_id) groups where the original staging had duplicates —
 * i.e., the rows that could have been corrupted by the
 * `ON CONFLICT DO NOTHING` non-determinism bug. Non-duplicate rows
 * are already correct, so we don't read/UPDATE them.
 *
 * Strategy (per GPT review):
 *   1. Build tmp_kwm_replay_winners ONCE — deduped winners + duplicate
 *      counts. Used for both audit-log and the targeted repair.
 *   2. Audit log entries for groups where duplicate_count > 1.
 *   3. DELETE only the kwm rows whose (week, term_id) is in a
 *      duplicate group.
 *   4. Plain INSERT (no UPSERT) the deduped winners for those same
 *      groups. If a conflict happens here, that's a bug we want to
 *      see loudly — don't hide with another upsert.
 *
 * Compared to runStagingToKwmInsert, avoids ~3M wide-row UPSERT
 * comparisons (the per-row IS DISTINCT FROM check that requires
 * cold heap reads on historical partitions). Affects only the small
 * fraction of rows that actually had the bug.
 *
 * Caller must wrap in a single transaction so reads see consistent
 * state mid-repair.
 */
async function runStagingToKwmTargetedRepair(fileId: string): Promise<void> {
  // 1. Audit log first — runs OUTSIDE the transaction so it can
  //    aggregate from staging directly (the temp table only has
  //    winners, but we want all-ranks per duplicate group for
  //    forensics). Same query shape as runStagingToKwmInsert's audit.
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

  // 2. Targeted repair — temp table + DELETE + plain INSERT. All in
  //    one transaction for connection-pinning (temp tables are
  //    session-scoped) AND for atomic mid-repair visibility.
  await db.transaction(async (tx) => {
    // Build the deduped winners + duplicate counts in one pass.
    await tx.execute(sql`
      CREATE TEMP TABLE tmp_kwm_replay_winners ON COMMIT DROP AS
      WITH candidates AS (
        SELECT
          s.*,
          st.id AS term_id,
          ROW_NUMBER() OVER (
            PARTITION BY s.week_end_date, st.id
            ORDER BY
              s.actual_rank ASC,
              s.had_unicode_noise ASC,
              s.source_row_number ASC
          ) AS rn,
          COUNT(*) OVER (
            PARTITION BY s.week_end_date, st.id
          ) AS duplicate_count
        FROM staging_weekly_metrics s
        JOIN search_terms st ON st.search_term_normalized = s.search_term_normalized
        WHERE s.uploaded_file_id = ${fileId}
      )
      SELECT * FROM candidates WHERE rn = 1
    `);
    await tx.execute(sql`CREATE UNIQUE INDEX ON tmp_kwm_replay_winners (week_end_date, term_id)`);
    await tx.execute(sql`ANALYZE tmp_kwm_replay_winners`);

    // Targeted repair: DELETE only kwm rows in duplicate groups.
    await tx.execute(sql`
      DELETE FROM keyword_weekly_metrics kwm
      USING tmp_kwm_replay_winners w
      WHERE kwm.week_end_date = w.week_end_date
        AND kwm.search_term_id = w.term_id
        AND w.duplicate_count > 1
    `);

    // INSERT winners for those same groups. Plain INSERT (no UPSERT) —
    // if a conflict occurs after we just DELETEd the rows + dedup'd
    // the source, that's a bug to see loudly, not paper over.
    await tx.execute(sql`
      INSERT INTO keyword_weekly_metrics (
        week_end_date, search_term_id, actual_rank,
        top_clicked_brand_1, top_clicked_brand_2, top_clicked_brand_3,
        top_clicked_category_1, top_clicked_category_2, top_clicked_category_3,
        top_clicked_product_1_asin, top_clicked_product_2_asin, top_clicked_product_3_asin,
        top_clicked_product_1_title, top_clicked_product_2_title, top_clicked_product_3_title,
        top_clicked_product_1_click_share, top_clicked_product_2_click_share, top_clicked_product_3_click_share,
        top_clicked_product_1_conversion_share, top_clicked_product_2_conversion_share, top_clicked_product_3_conversion_share,
        keyword_in_title_1, keyword_in_title_2, keyword_in_title_3, keyword_title_match_count,
        keyword_in_title_1_loose, keyword_in_title_2_loose, keyword_in_title_3_loose, keyword_title_match_count_loose,
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
        (${sql.raw(looseFlagsCall('search_term_normalized', 'top_clicked_product', 'keyword_in_title', 'actual_rank'))}).f1 AS keyword_in_title_1_loose,
        (${sql.raw(looseFlagsCall('search_term_normalized', 'top_clicked_product', 'keyword_in_title', 'actual_rank'))}).f2 AS keyword_in_title_2_loose,
        (${sql.raw(looseFlagsCall('search_term_normalized', 'top_clicked_product', 'keyword_in_title', 'actual_rank'))}).f3 AS keyword_in_title_3_loose,
        (${sql.raw(looseFlagsCall('search_term_normalized', 'top_clicked_product', 'keyword_in_title', 'actual_rank'))}).match_count,
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
        END,
        CASE
          WHEN top_clicked_product_1_click_share IS NULL THEN 'unknown_missing_click'::fake_volume_eval_status
          WHEN top_clicked_product_1_conversion_share IS NULL THEN 'unknown_missing_conversion'::fake_volume_eval_status
          ELSE 'evaluated'::fake_volume_eval_status
        END,
        ${fileId}
      FROM tmp_kwm_replay_winners
      WHERE duplicate_count > 1
    `);
  });
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
  const isReplay = input.skipRefresh || input.replayMode;
  const lockResult = isReplay
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
    if (!isReplay && existing.validationStatus === 'imported') {
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
      if (input.replayMode) {
        // Replay is single-threaded and we don't need to preserve any
        // other file's staging rows — TRUNCATE is instant vs. minutes
        // for the per-file DELETE on a populated staging table.
        await db.execute(sql`TRUNCATE staging_weekly_metrics`);
      } else {
        await db
          .delete(stagingWeeklyMetrics)
          .where(eq(stagingWeeklyMetrics.uploadedFileId, file.id));
      }
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
            const searchTermOriginalRaw = row['Search Term'] ?? '';
            // Clean for display: strip invisible noise (OBJ, ZWSP, etc.),
            // collapse whitespace, NFC. This is what gets stored as
            // staging.search_term_raw and ultimately surfaces in the UI.
            const searchTermCleanedRaw = cleanSearchTermForDisplay(searchTermOriginalRaw);
            const noisy = hadUnicodeNoise(searchTermOriginalRaw);
            // Defensive fallbacks. The cleanest production case (a real
            // search term with maybe some unicode noise) never hits these,
            // but if Amazon ships a row with an empty cell or a term
            // composed entirely of OBJ/ZWSP/etc, we need non-empty values
            // for the NOT NULL constraints. Use the same sentinel for all
            // three columns so the dedup logic still groups them together.
            const searchTermOriginal = searchTermOriginalRaw || '__unparseable__';
            const searchTermCleaned = searchTermCleanedRaw || '__unparseable__';
            const normalizedTerm =
              normalizeForMatch(searchTermCleanedRaw) ||
              searchTermCleanedRaw.toLowerCase().trim() ||
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
    if (input.replayMode) {
      // Skip search_terms_upsert entirely in replay mode. All terms in
      // the file already exist in search_terms (from the original
      // import); the upsert would do millions of index lookups against
      // a 9.3M-row table to discover this fact and update nothing
      // important. search_term_raw cleanup happens as a separate
      // one-shot pass after the replay (see scripts/cleanSearchTermRaw.ts).
    } else {
    await timePhase(file.id, 'search_terms_upsert', async () => {
      // Note: staging.search_term_raw now stores the CLEANED display
      // form (NFC + invisible-stripped). On conflict we also refresh
      // search_terms.search_term_raw to that clean value if it differs
      // — this is how existing rows that were created with OBJ-prefixed
      // raws get healed during the historical replay.
      //
      // The DISTINCT ON winner is chosen with the same priority as the
      // kwm dedup CTE — lowest actual_rank first, then no-noise
      // preference, then shortest raw, then earliest source_row_number.
      // This keeps search_terms.search_term_raw and the kwm winning row
      // semantically aligned: the "best" rank's raw form wins for both.
      // Without ORDER BY, DISTINCT ON would non-deterministically pick
      // any raw variant — which is how we ended up with "essential oils'"
      // (apostrophe variant) in the smoke test instead of "essential oils".
      await db.execute(sql`
        INSERT INTO search_terms (search_term_raw, search_term_normalized, first_seen_week, last_seen_week)
        SELECT DISTINCT ON (search_term_normalized)
          search_term_raw, search_term_normalized, ${weekEndDate}::date, ${weekEndDate}::date
        FROM staging_weekly_metrics
        WHERE uploaded_file_id = ${file.id}
        ORDER BY
          search_term_normalized,
          actual_rank ASC,
          had_unicode_noise ASC,
          length(search_term_raw) ASC,
          source_row_number ASC
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
    }

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
    if (input.replayMode) {
      // Targeted repair: only DELETE+INSERT rows in duplicate groups.
      // ~3-4× faster than the upsert path on cold partitions.
      // See runStagingToKwmTargetedRepair docstring.
      await timePhase(file.id, 'kwm_targeted_repair', async () => {
        await runStagingToKwmTargetedRepair(file.id);
      });
    } else if (file.isReplacement) {
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
    if (isReplay) {
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
    if (!isReplay) {
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
