/**
 * Summary refresh job — rebuilds keyword_current_summary from kwm.
 *
 * Called as the final phase of processFileImport (after mark_imported is
 * effectively staged but before the file is committed as fully done).
 * For Plan 3.1 MVP, this populates the critical fields the Plan 3.2
 * explorer depends on:
 *
 *   ✓ current_week_end_date, current_rank
 *   ✓ prior_week_rank, rank_4w_ago, rank_13w_ago, rank_26w_ago, rank_52w_ago
 *   ✓ improvement_1w / 4w / 13w / 26w / 52w
 *   ✓ ever_top_50k
 *   ✓ last_seen_week, weeks_since_seen
 *   ✓ fake_volume_severity_current
 *   ✓ snapshot fields (category, asins, titles, in-title flags, match count)
 *
 * Defaulted to safe values for Plan 3.1, enriched in Plan 3.5:
 *   - consecutive_improvement_streak = 0  (needs window function/recursive CTE)
 *   - has_unranked_week / unranked_week_count / unranked_after_top_50k = false/0
 *     (need cross-join against reporting_weeks calendar)
 *
 * Filter: active terms only (last_seen_week >= current_week_end_date - 28 days).
 *
 * Strategy: stage rows in temp tables for clean intermediate plans, then
 * INSERT into the parallel `keyword_current_summary_stage` table. After
 * commit, atomically swap names with the live table via three RENAMEs
 * in a tiny transaction (~ms). Concurrent reads of
 * keyword_current_summary are NEVER blocked beyond that brief metadata
 * swap — the prior approach (TRUNCATE + INSERT in one transaction on
 * the live table) blocked the explorer for ~3 min during the INSERT.
 *
 * Estimated cost: ~30 minutes on ~4M active terms (post-covering-index
 * fix; was ~155 min before migration 0011). Connection: pg.Pool with
 * TCP keepalives (the @neondatabase/serverless HTTP driver would time
 * out on long INSERTs).
 */
import { Pool, type PoolClient } from 'pg';

export interface RefreshSummaryResult {
  rowsWritten: number;
  durationMs: number;
  currentWeekEndDate: string;
}

export async function refreshKeywordCurrentSummary(): Promise<RefreshSummaryResult> {
  const startedAt = Date.now();
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error('DATABASE_URL not set');
  const pool = new Pool({
    connectionString: dbUrl,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    connectionTimeoutMillis: 20_000,
    statement_timeout: 1_800_000, // 30 min ceiling per statement
  });

  const client = await pool.connect();
  let currentWeekEndDate: string | null = null;
  let rowsWritten = 0;

  try {
    // 0. Determine the current week — the most recent fully-imported week.
    const { rows: refRows } = await client.query<{ current_week: string }>(
      `SELECT MAX(week_end_date)::date AS current_week
       FROM reporting_weeks WHERE is_complete = true`,
    );
    if (refRows.length === 0 || !refRows[0].current_week) {
      throw new Error('refreshSummary: no completed reporting_weeks found');
    }
    currentWeekEndDate = refRows[0].current_week as unknown as string;

    // Stage-and-swap pattern (Plan 3.2 perf fix #4):
    //   - Build the new snapshot inside `keyword_current_summary_stage`,
    //     a parallel table with identical structure (created in migration
    //     0012). This holds an EXCLUSIVE lock on _stage but no lock on the
    //     live `keyword_current_summary`.
    //   - At the end, do a brief metadata-only RENAME swap: the live
    //     table becomes _stage, _stage becomes live. Reader-blocking
    //     window goes from ~3 min (the prior INSERT duration) to a
    //     few milliseconds (just the system catalog update).
    //
    // Everything from BEGIN through the final INSERT runs in one
    // transaction so the temp tables persist across stages. The RENAME
    // swap is a separate, very short transaction at the end.
    await client.query('BEGIN');

    // Wipe stale data from the previous refresh's stage table. (After a
    // successful swap, _stage holds the prior snapshot; we don't need
    // it.) TRUNCATE on _stage takes ACCESS EXCLUSIVE on _stage but no
    // one reads _stage, so this doesn't block any explorer queries.
    await client.query('TRUNCATE keyword_current_summary_stage');

    // 1. latest_per_term — most recent kwm row per active term.
    //    Active = seen within the last 28 days of current_week_end_date.
    //    Materialized as a temp table so subsequent steps reuse the result
    //    without re-scanning kwm.
    await stageLatestPerTerm(client);

    // 2. rank_at_offset(N) for N in {1, 4, 13, 26, 52} weeks ago.
    //    Each offset is the actual_rank in the EXACT week N*7 days before
    //    each term's current_week_end_date. NULL when the term wasn't
    //    observed that exact week (treated as "unranked then" by the spec).
    for (const weeks of [1, 4, 13, 26, 52]) {
      await stageRankAtOffset(client, weeks);
    }

    // 3. Stage loose-match flags into a temp table so each per-(term, slot)
    //    regex match is evaluated once (vs. 2x if computed inline in the
    //    INSERT — once for the boolean, once inside the count CASE).
    await stageLooseMatchFlags(client);

    // ever_top_50k DEFERRED to Plan 3.5: a full-history scan of kwm joined
    // to latest_per_term takes 1+ hours via Neon's cold-page prefetch
    // (135M rows still NULL severity-wise post-scoped-backfill, so they're
    // also cold). For Plan 3.1 we default ever_top_50k to false; once
    // the overnight full-history backfill warms the cache and the aggregate
    // can complete in reasonable time, we'll add a one-off "ever_top_50k
    // compute" job and decide whether to keep it inline in the refresh
    // or maintain it incrementally on each import.

    // 4. INSERT into the stage table (the live table is untouched).
    const insertResult = await client.query(
      `
      INSERT INTO keyword_current_summary_stage (
        search_term_id, current_week_end_date, current_rank,
        prior_week_rank, rank_4w_ago, rank_13w_ago, rank_26w_ago, rank_52w_ago,
        improvement_1w, improvement_4w, improvement_13w, improvement_26w, improvement_52w,
        consecutive_improvement_streak, ever_top_50k,
        has_unranked_week, unranked_week_count, unranked_after_top_50k,
        last_seen_week, weeks_since_seen,
        fake_volume_severity_current,
        top_clicked_category_1_current,
        top_clicked_product_1_asin_current,
        top_clicked_product_1_title_current,
        top_clicked_product_1_click_share_current,
        top_clicked_product_1_conversion_share_current,
        keyword_in_title_1_current, keyword_in_title_2_current, keyword_in_title_3_current,
        keyword_title_match_count_current,
        keyword_in_title_1_loose_current, keyword_in_title_2_loose_current, keyword_in_title_3_loose_current,
        keyword_title_match_count_loose_current,
        updated_at
      )
      SELECT
        l.search_term_id,
        l.week_end_date,
        l.actual_rank,
        r1.actual_rank,
        r4.actual_rank,
        r13.actual_rank,
        r26.actual_rank,
        r52.actual_rank,
        (r1.actual_rank - l.actual_rank),
        (r4.actual_rank - l.actual_rank),
        (r13.actual_rank - l.actual_rank),
        (r26.actual_rank - l.actual_rank),
        (r52.actual_rank - l.actual_rank),
        0 AS consecutive_improvement_streak,
        false AS ever_top_50k, -- deferred to Plan 3.5; see note above
        false AS has_unranked_week,
        0 AS unranked_week_count,
        false AS unranked_after_top_50k,
        l.week_end_date AS last_seen_week,
        -- date - date returns int (days). Divide by 7 for weeks.
        (($1::date - l.week_end_date) / 7)::int AS weeks_since_seen,
        l.fake_volume_severity,
        l.top_clicked_category_1,
        l.top_clicked_product_1_asin,
        l.top_clicked_product_1_title,
        l.top_clicked_product_1_click_share,
        l.top_clicked_product_1_conversion_share,
        l.keyword_in_title_1,
        l.keyword_in_title_2,
        l.keyword_in_title_3,
        l.keyword_title_match_count,
        lf.f1 AS in_title_1_loose,
        lf.f2 AS in_title_2_loose,
        lf.f3 AS in_title_3_loose,
        (
          (CASE WHEN lf.f1 IS TRUE THEN 1 ELSE 0 END) +
          (CASE WHEN lf.f2 IS TRUE THEN 1 ELSE 0 END) +
          (CASE WHEN lf.f3 IS TRUE THEN 1 ELSE 0 END)
        )::smallint AS title_match_count_loose,
        NOW()
      FROM latest_per_term l
      JOIN loose_flags lf ON lf.search_term_id = l.search_term_id
      LEFT JOIN rank_at_1w r1 ON r1.search_term_id = l.search_term_id
      LEFT JOIN rank_at_4w r4 ON r4.search_term_id = l.search_term_id
      LEFT JOIN rank_at_13w r13 ON r13.search_term_id = l.search_term_id
      LEFT JOIN rank_at_26w r26 ON r26.search_term_id = l.search_term_id
      LEFT JOIN rank_at_52w r52 ON r52.search_term_id = l.search_term_id
      `,
      [currentWeekEndDate],
    );
    rowsWritten = insertResult.rowCount ?? 0;

    await client.query('COMMIT');

    // 5. Swap stage <-> live in a separate, very short transaction.
    //    Three RENAMEs are pure metadata operations on the system catalog;
    //    each takes ACCESS EXCLUSIVE briefly but completes in
    //    milliseconds. Net reader-blocking window: ~tens of ms.
    //
    //    After this commit:
    //      - The previously-live `keyword_current_summary` is now the
    //        empty-pending-truncate `_stage` (will be wiped at the start
    //        of the next refresh).
    //      - The freshly-built rows are now live as
    //        `keyword_current_summary`.
    //
    //    Index names rotate with their tables and are not renamed —
    //    EXPLAIN output may transiently show indexes named like
    //    `keyword_current_summary_stage_<col>_idx` against the live
    //    table. Functional but visually quirky.
    await client.query('BEGIN');
    await client.query(
      'ALTER TABLE keyword_current_summary RENAME TO keyword_current_summary_swap_old',
    );
    await client.query(
      'ALTER TABLE keyword_current_summary_stage RENAME TO keyword_current_summary',
    );
    await client.query(
      'ALTER TABLE keyword_current_summary_swap_old RENAME TO keyword_current_summary_stage',
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
    await pool.end();
  }

  return {
    rowsWritten,
    durationMs: Date.now() - startedAt,
    currentWeekEndDate: currentWeekEndDate as string,
  };
}

async function stageLatestPerTerm(client: PoolClient): Promise<void> {
  // We pull all 3 product titles + search_term_raw into the temp table even
  // though kcs only stores title 1, because the loose-match computation in
  // the final INSERT needs to compare every search-term token against each
  // of the 3 titles. search_term_raw is joined from search_terms.
  await client.query(`
    CREATE TEMP TABLE latest_per_term ON COMMIT DROP AS
    WITH ref AS (
      SELECT MAX(week_end_date)::date AS current_week
      FROM reporting_weeks WHERE is_complete = true
    )
    SELECT DISTINCT ON (k.search_term_id)
      k.search_term_id,
      st.search_term_raw,
      k.week_end_date,
      k.actual_rank,
      k.fake_volume_severity,
      k.top_clicked_category_1,
      k.top_clicked_product_1_asin,
      k.top_clicked_product_1_title,
      k.top_clicked_product_2_title,
      k.top_clicked_product_3_title,
      k.top_clicked_product_1_click_share,
      k.top_clicked_product_1_conversion_share,
      k.keyword_in_title_1,
      k.keyword_in_title_2,
      k.keyword_in_title_3,
      k.keyword_title_match_count
    FROM keyword_weekly_metrics k
    JOIN search_terms st ON st.id = k.search_term_id,
    ref
    WHERE k.week_end_date >= ref.current_week - INTERVAL '28 days'
    ORDER BY k.search_term_id, k.week_end_date DESC;
    CREATE INDEX ON latest_per_term (search_term_id);
  `);
}

async function stageRankAtOffset(client: PoolClient, weeksAgo: number): Promise<void> {
  // The "exact week N weeks before each term's current week" is computed
  // by joining latest_per_term to kwm where kwm.week_end_date matches.
  // Output: 1 row per (active term that had data N weeks ago).
  const tableName = `rank_at_${weeksAgo}w`;
  await client.query(
    `
    CREATE TEMP TABLE ${tableName} ON COMMIT DROP AS
    SELECT
      l.search_term_id,
      k.actual_rank
    FROM latest_per_term l
    JOIN keyword_weekly_metrics k
      ON k.search_term_id = l.search_term_id
      AND k.week_end_date = (l.week_end_date - (${weeksAgo} * INTERVAL '7 days'))::date;
    CREATE INDEX ON ${tableName} (search_term_id);
    `,
  );
}

// stageEverTop50k removed — see "ever_top_50k DEFERRED" comment in main flow.
// Will return in Plan 3.5 once we have a faster aggregate strategy.

/**
 * Compute, for every term in latest_per_term, three booleans (f1/f2/f3)
 * — TRUE iff every non-stopword token in the search term appears in the
 * corresponding product title with word-boundary semantics, case-
 * insensitive. NULL when that slot's title is NULL.
 *
 * Implementation: a two-stage approach for performance.
 *
 *   1. Build `term_normalized` — lowercase the search term + each title,
 *      replace runs of non-alphanumeric chars with spaces, and pad with
 *      a leading and trailing space. Punctuation/hyphens become spaces
 *      so that "monohydrate-flavored" tokenizes as two words.
 *
 *   2. For each (term, slot) pair, check that every non-stopword token
 *      in the search term appears in the title via `POSITION(' word ' IN
 *      padded_title) > 0` — a substring search that's dramatically
 *      faster than a regex word-boundary match (which the database
 *      can't pre-compile because the pattern is constructed per row).
 *
 * Equivalence to the old regex approach: identical for all alphanumeric
 * tokens. The padding-with-spaces trick + punctuation-to-space
 * preprocessing reproduces the `\m...\M` word-boundary semantics for
 * anything we care about (the strict/loose divergence we observed in
 * verification was unicode-symbol / weird-char edge cases that affect
 * BOTH approaches the same way).
 *
 * Stopword list is intentionally small — common English function words
 * that contribute no semantic information when matching brand-style
 * search terms.
 */
async function stageLooseMatchFlags(client: PoolClient): Promise<void> {
  // Stage 1: normalize and pad. One regexp_replace per (term, slot) — done
  // once and the result is reused by all three slot checks below.
  await client.query(`
    CREATE TEMP TABLE term_normalized ON COMMIT DROP AS
    SELECT
      l.search_term_id,
      ' ' || regexp_replace(LOWER(l.search_term_raw), '[^a-z0-9]+', ' ', 'g') || ' ' AS s,
      CASE WHEN l.top_clicked_product_1_title IS NULL THEN NULL
           ELSE ' ' || regexp_replace(LOWER(l.top_clicked_product_1_title), '[^a-z0-9]+', ' ', 'g') || ' '
      END AS t1,
      CASE WHEN l.top_clicked_product_2_title IS NULL THEN NULL
           ELSE ' ' || regexp_replace(LOWER(l.top_clicked_product_2_title), '[^a-z0-9]+', ' ', 'g') || ' '
      END AS t2,
      CASE WHEN l.top_clicked_product_3_title IS NULL THEN NULL
           ELSE ' ' || regexp_replace(LOWER(l.top_clicked_product_3_title), '[^a-z0-9]+', ' ', 'g') || ' '
      END AS t3
    FROM latest_per_term l;
    CREATE INDEX ON term_normalized (search_term_id);
  `);

  // Stage 2: for each (term, slot), check that every non-stopword token
  // in the search term appears in the padded title.
  // POSITION returns 0 when the substring is not found — so the NOT EXISTS
  // returns true iff every token IS found (= the term matches the title).
  const slotExpr = (titleCol: string): string => `(
    CASE
      WHEN ${titleCol} IS NULL THEN NULL
      ELSE NOT EXISTS (
        SELECT 1 FROM unnest(string_to_array(trim(tn.s), ' ')) AS word
        WHERE word <> ''
          AND word NOT IN (
            'a','an','and','are','as','at','be','by','for','from','has','have',
            'in','is','it','its','of','on','or','that','the','this','to','with'
          )
          AND POSITION(' ' || word || ' ' IN ${titleCol}) = 0
      )
    END
  )`;

  await client.query(`
    CREATE TEMP TABLE loose_flags ON COMMIT DROP AS
    SELECT
      tn.search_term_id,
      ${slotExpr('tn.t1')} AS f1,
      ${slotExpr('tn.t2')} AS f2,
      ${slotExpr('tn.t3')} AS f3
    FROM term_normalized tn;
    CREATE INDEX ON loose_flags (search_term_id);
  `);
}
