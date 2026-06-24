/**
 * Server-side runner for the explorer query. Executes the (sql, args) pair
 * produced by buildExplorerQuery against Neon via the http driver and
 * returns typed rows + total count for the pagination footer.
 *
 * Uses neon-http rather than pg.Pool because:
 * 1. The explorer page runs on Vercel serverless — no long-lived connections
 *    to maintain, and Neon's HTTP transport is the recommended path.
 * 2. The query is short (<1s on indexed kcs reads) so serverless cold-start
 *    penalties don't hurt us.
 *
 * Per-layer perf optimizations active in this file:
 *
 *  - current_week_end_date predicate injection (migration 0020): unlocks
 *    Index Scan on kcs_rank_idx for the rows query.
 *  - default_severity_total short-circuit (migration 0021): the
 *    default landing footer count comes from a precomputed integer on
 *    meta, not a live COUNT(*) over kcs.
 *  - category facets short-circuit (migration 0021): when filters are
 *    "category-only + default severity," count comes from
 *    keyword_current_summary_category_facets, not a live COUNT(*).
 *
 * Each short-circuit has a graceful fallback to the live count if the
 * meta/facets data is missing, so behavior is never broken.
 *
 * The page.tsx server component imports this; raw SQL stays in buildQuery.ts
 * so it remains pure and easy to unit-test.
 */
import { neon } from '@neondatabase/serverless';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { env } from '@/lib/env';
import { buildExplorerQuery } from './buildQuery';
import { applyCountCap, extractCount, extractWindowTotal } from './queryTotals';
import type { ExplorerFilters, ExplorerRow, SeverityKey, VolumeFitMeta } from './types';
import { EXPLORER_DEFAULTS } from './parseFilters';

interface ExplorerQueryResult {
  rows: ExplorerRow[];
  /** True when there is at least one more page after this one (from the N+1 probe). */
  hasNext: boolean;
  /**
   * Exact match total when cheaply known (precomputed meta/facet, or the
   * q-path window count). `null` when the total is DEFERRED — the heavy
   * legacy live-count case — and must be fetched separately via
   * countExplorerMatches() inside a streamed boundary.
   */
  total: number | null;
  /** True when total === COUNT_CAP and the real total may be larger. Only meaningful when total !== null. */
  totalIsCapped: boolean;
  /** True when a broad search hit the 115s statement timeout; rows is []. */
  broadTimedOut?: boolean;
  /**
   * Volume-fit metadata for the current snapshot, sourced from the same meta
   * lookup that supplies current_week_end_date. `null` when no fit was selected
   * at refresh time (cold start).
   */
  volumeFit: VolumeFitMeta | null;
  /** Per-layer wall-clock timings for the perf instrumentation strip. */
  timings: {
    /** Meta-row lookup that supplies the current_week_end_date predicate. */
    metaLookupMs: number;
    /** Main paged SELECT (LIMIT perPage+1 OFFSET …). */
    rowsMs: number;
    /** q-path empty-page fallback COUNT, or 0 (the legacy count is deferred). */
    countMs: number;
    /** True if buildExplorerQuery was given a currentWeekEndDate (fast path). */
    usedPredicate: boolean;
    /**
     * Which path served the total: 'live' (q-path/broad window count),
     * 'meta' (default landing), 'facet' (single category/leaf),
     * 'deferred' (heavy legacy → countExplorerMatches streams it in).
     */
    countSource: 'live' | 'meta' | 'facet' | 'deferred';
  };
}

interface RawRow {
  search_term_id: string;
  search_term_raw: string;
  current_rank: number;
  prior_rank: number | null;
  improvement: number | null;
  top_clicked_category_1_current: string | null;
  fake_volume_severity_current: 'none' | 'warning' | 'critical' | null;
  keyword_title_match_count_current: number | null;
  keyword_in_title_1_current: boolean | null;
  keyword_in_title_2_current: boolean | null;
  keyword_in_title_3_current: boolean | null;
  keyword_title_match_count_loose_current: number | null;
  keyword_in_title_1_loose_current: boolean | null;
  keyword_in_title_2_loose_current: boolean | null;
  keyword_in_title_3_loose_current: boolean | null;
  top_clicked_product_1_asin_current: string | null;
  top_clicked_product_1_title_current: string | null;
  top_clicked_product_1_click_share_current: string | null;
  top_clicked_product_1_conversion_share_current: string | null;
  // bigint comes back as string from pg/neon-http to avoid 53-bit
  // precision loss. Mapper parses to number.
  estimated_monthly_volume_current: string | number | null;
  avg_price_cents: string | number | null;
  avg_reviews: number | null;
  top_clicked_leaf_category: string | null;
  total?: number | string; // q-path window count: (count(*) OVER ())::int
}

interface MetaRow {
  current_week_end_date: string | null;
  snapshot_version: string | null;
  default_severity_total: number | null;
  volume_fit_calibration_month_end_date: string | null;
  volume_fit_is_extrapolated: boolean | null;
}

/**
 * Severity defaults match parseFilters.ts EXPLORER_DEFAULTS.severities.
 * The precomputed counts (default_severity_total, default_severity_count
 * on facets) only apply when severities match this exact set.
 */
function isDefaultSeverity(severities: SeverityKey[]): boolean {
  const def = [...EXPLORER_DEFAULTS.severities].sort();
  const cur = [...severities].sort();
  return def.length === cur.length && def.every((s, i) => s === cur[i]);
}

/** True when none of the Keepa-aggregate filters are set. */
function noKeepaFilters(f: ExplorerFilters): boolean {
  return f.leafCategories.length === 0;
}

/**
 * True when the filter set is "default landing": no narrowing filters
 * beyond the default severity. Lets us skip the live COUNT(*) and use
 * the precomputed total on meta.
 */
function canUseDefaultTotal(f: ExplorerFilters): boolean {
  return (
    f.q === null
    && f.rankMin === null
    && f.rankMax === null
    && f.jump === null
    && f.category === null
    && f.titleMatchMode === null
    && isDefaultSeverity(f.severities)
    && noKeepaFilters(f)
  );
}

/**
 * True when the filter set is "broad-category-only + default severity":
 * exactly one broad category filter, no other narrowing. Lets us use
 * the per-category precomputed count from facets.
 */
function canUseCategoryFacet(f: ExplorerFilters): boolean {
  return (
    f.q === null
    && f.rankMin === null
    && f.rankMax === null
    && f.jump === null
    && f.category !== null
    && f.titleMatchMode === null
    && isDefaultSeverity(f.severities)
    && noKeepaFilters(f)
  );
}

/**
 * True when the filter set is "single-leaf-category-only + default
 * severity": exactly ONE leaf category filter, no broad cat, no other
 * narrowing. Lets us use the precomputed leaf-facet count. Multi-leaf
 * selections fall through to the live COUNT(*) path.
 */
function canUseLeafCategoryFacet(f: ExplorerFilters): boolean {
  return (
    f.q === null
    && f.rankMin === null
    && f.rankMax === null
    && f.jump === null
    && f.category === null
    && f.leafCategories.length === 1
    && f.titleMatchMode === null
    && isDefaultSeverity(f.severities)
  );
}

export async function runExplorerQuery(
  filters: ExplorerFilters,
): Promise<ExplorerQueryResult> {
  // --- DIAGNOSTIC INSTRUMENTATION (temporary; explorer pagination investigation) ---
  // Correlate a browser request with its Vercel function log line and record the
  // driver path + per-layer timings + outcome, so we can tell apart:
  //   * a fast neon-http failure  -> '[explorer] FAILED' with a small totalMs + code
  //   * a 120s function-cap kill   -> NO line from us at all (only Vercel's timeout)
  //   * a slow-but-OK page-2 query -> '[explorer]' ok with a large totalMs
  // Remove once the root cause is fixed.
  const reqId = randomUUID().slice(0, 8);
  const tAll = Date.now();
  const driver = filters.q !== null && filters.qMode === 'broad' ? 'tcp' : 'http';
  const logBase = {
    reqId,
    driver,
    page: filters.page,
    leafCount: filters.leafCategories.length,
    sort: filters.sort,
    rankMax: filters.rankMax,
    qMode: filters.q ? filters.qMode : null,
  };
  try {
    const result = await runExplorerQueryInner(filters);
    console.log('[explorer]', JSON.stringify({
      ...logBase,
      outcome: result.broadTimedOut ? 'broad_timeout' : 'ok',
      countSource: result.timings.countSource,
      total: result.total,
      totalIsCapped: result.totalIsCapped,
      hasNext: result.hasNext,
      deferred: result.total === null,
      rowCount: result.rows.length,
      metaLookupMs: result.timings.metaLookupMs,
      rowsMs: result.timings.rowsMs,
      countMs: result.timings.countMs,
      totalMs: Date.now() - tAll,
    }));
    return result;
  } catch (e) {
    const err = e as { code?: string; message?: string };
    console.error('[explorer] FAILED', JSON.stringify({
      ...logBase,
      outcome: 'error',
      code: err.code ?? null,
      message: err.message ?? String(e),
      totalMs: Date.now() - tAll,
    }));
    throw e;
  }
}

async function runExplorerQueryInner(
  filters: ExplorerFilters,
): Promise<ExplorerQueryResult> {
  const sqlClient = neon(env.DATABASE_URL);

  // Fast path setup: one meta lookup gives us everything we need —
  // the current_week_end_date predicate, the snapshot_version (for
  // facet lookups), the default_severity_total (for landing-page
  // count short-circuit), and the volume-fit info (for the page
  // chip).
  let currentWeekEndDate: string | undefined;
  let snapshotVersion: string | undefined;
  let defaultSeverityTotal: number | undefined;
  let volumeFit: VolumeFitMeta | null = null;
  const tMetaStart = Date.now();
  try {
    const metaRows = (await sqlClient`
      SELECT
        m.current_week_end_date::text AS current_week_end_date,
        m.snapshot_version::text       AS snapshot_version,
        m.default_severity_total       AS default_severity_total,
        r.calibration_month_end_date::text AS volume_fit_calibration_month_end_date,
        m.volume_fit_is_extrapolated   AS volume_fit_is_extrapolated
      FROM keyword_current_summary_meta m
      LEFT JOIN model_calibration_runs r ON r.id = m.volume_fit_run_id
      WHERE m.singleton = true
    `) as MetaRow[];
    const meta = metaRows[0];
    currentWeekEndDate = meta?.current_week_end_date ?? undefined;
    snapshotVersion = meta?.snapshot_version ?? undefined;
    defaultSeverityTotal = meta?.default_severity_total ?? undefined;
    if (meta?.volume_fit_calibration_month_end_date) {
      volumeFit = {
        calibrationMonthEndDate: meta.volume_fit_calibration_month_end_date,
        isExtrapolated: meta.volume_fit_is_extrapolated ?? false,
      };
    }
  } catch {
    // Fallthrough: everything stays undefined, queries use legacy paths.
  }
  const metaLookupMs = Date.now() - tMetaStart;

  const built = buildExplorerQuery(filters, currentWeekEndDate);
  const { sql, args, countSql, countArgs } = built;

  // Decide whether to short-circuit the count.
  let countSource: 'live' | 'meta' | 'facet' | 'deferred' = 'live';
  let precomputedTotal: number | null = null;

  if (canUseDefaultTotal(filters) && defaultSeverityTotal !== undefined) {
    precomputedTotal = defaultSeverityTotal;
    countSource = 'meta';
  } else if (canUseCategoryFacet(filters) && snapshotVersion) {
    try {
      const facetRows = (await sqlClient`
        SELECT default_severity_count AS n
        FROM keyword_current_summary_category_facets
        WHERE snapshot_version = ${snapshotVersion}::uuid
          AND category = ${filters.category}
      `) as Array<{ n: number }>;
      if (facetRows.length > 0) {
        precomputedTotal = facetRows[0].n;
        countSource = 'facet';
      }
    } catch {
      // Fall through to live count
    }
  } else if (canUseLeafCategoryFacet(filters) && snapshotVersion) {
    try {
      const facetRows = (await sqlClient`
        SELECT default_severity_count AS n
        FROM keyword_current_summary_leaf_category_facets
        WHERE snapshot_version = ${snapshotVersion}::uuid
          AND leaf_category = ${filters.leafCategories[0]}
      `) as Array<{ n: number }>;
      if (facetRows.length > 0) {
        precomputedTotal = facetRows[0].n;
        countSource = 'facet';
      }
    } catch {
      // Fall through to live count
    }
  }

  const isBroad = filters.q !== null && filters.qMode === 'broad';

  // Rows query. Broad mode runs on a node-postgres TCP connection with a
  // 115s statement_timeout — Neon's HTTP driver is tuned for short queries
  // and won't reliably hold a ~2-minute one. Everything else runs on
  // neon-http; the legacy live count is DEFERRED (see below).
  const tRowsStart = Date.now();
  let rawRows: RawRow[];
  let rowsMs: number;
  let countMs = 0;

  if (isBroad) {
    const broad = await runBroad(sql, args);
    rowsMs = Date.now() - tRowsStart;
    if (broad === 'timeout') {
      return broadTimeoutResult(volumeFit, metaLookupMs, rowsMs, currentWeekEndDate !== undefined);
    }
    rawRows = broad as unknown as RawRow[];
  } else {
    // Legacy path: fetch rows only (N+1). The live count is DEFERRED to a
    // separate streamed query (countExplorerMatches); we never block on it here.
    const rowsTimed = await sqlClient
      .query(sql, args)
      .then((r) => ({ result: r, ms: Date.now() - tRowsStart }));
    rawRows = rowsTimed.result as unknown as RawRow[];
    rowsMs = rowsTimed.ms;
  }

  // hasNext: q-path/broad know the exact window total (resolved below); legacy
  // path uses the N+1 probe — a full extra row means there's another page.
  // Invariant: precomputed-total results are always the legacy path (q === null),
  // never countFromRows — so the placeholder below is only ever transient for
  // q-path/broad, which reassign it once total is resolved.
  let hasNext: boolean;
  if (built.countFromRows || isBroad) {
    hasNext = false; // reassigned after total is resolved (q-path/broad)
  } else {
    hasNext = rawRows.length > filters.perPage;
    if (hasNext) rawRows = rawRows.slice(0, filters.perPage);
  }

  const rows: ExplorerRow[] = rawRows.map((r) => ({
    searchTermId: r.search_term_id,
    searchTermRaw: r.search_term_raw,
    currentRank: r.current_rank,
    priorRank: r.prior_rank,
    improvement: r.improvement,
    topClickedCategory1: r.top_clicked_category_1_current,
    fakeVolumeSeverity: r.fake_volume_severity_current,
    keywordTitleMatchCount: r.keyword_title_match_count_current,
    keywordInTitle1: r.keyword_in_title_1_current,
    keywordInTitle2: r.keyword_in_title_2_current,
    keywordInTitle3: r.keyword_in_title_3_current,
    keywordTitleMatchCountLoose: r.keyword_title_match_count_loose_current,
    keywordInTitle1Loose: r.keyword_in_title_1_loose_current,
    keywordInTitle2Loose: r.keyword_in_title_2_loose_current,
    keywordInTitle3Loose: r.keyword_in_title_3_loose_current,
    topClickedProduct1Asin: r.top_clicked_product_1_asin_current,
    topClickedProduct1Title: r.top_clicked_product_1_title_current,
    topClickedProduct1ClickShare: r.top_clicked_product_1_click_share_current,
    topClickedProduct1ConversionShare: r.top_clicked_product_1_conversion_share_current,
    estimatedMonthlyVolumeCurrent: parseBigint(r.estimated_monthly_volume_current),
    avgPriceCents: parseBigint(r.avg_price_cents),
    avgReviews: r.avg_reviews ?? null,
    topClickedLeafCategory: r.top_clicked_leaf_category ?? null,
  }));

  let total: number | null;
  let totalIsCapped: boolean;
  if (precomputedTotal !== null) {
    ({ total, totalIsCapped } = applyCountCap(precomputedTotal));
  } else if (built.countFromRows) {
    const windowTotal = extractWindowTotal(rawRows as Array<{ total?: number | string }>);
    if (windowTotal !== null) {
      ({ total, totalIsCapped } = applyCountCap(windowTotal));
    } else {
      // Empty page (OFFSET past the end) on the q-path: one fallback count.
      // Broad mode runs it on the TCP pool (115s timeout) so it stays bounded.
      const tFallback = Date.now();
      if (isBroad) {
        const cr = await runBroad(countSql, countArgs);
        countMs = Date.now() - tFallback;
        if (cr === 'timeout') {
          return broadTimeoutResult(volumeFit, metaLookupMs, rowsMs, currentWeekEndDate !== undefined);
        }
        ({ total, totalIsCapped } = applyCountCap(extractCount(cr as unknown as Array<{ total: number | string }>)));
      } else {
        const cr = await sqlClient.query(countSql, countArgs);
        countMs = Date.now() - tFallback;
        ({ total, totalIsCapped } = applyCountCap(extractCount(cr as unknown as Array<{ total: number | string }>)));
      }
    }
    // Derive hasNext from the window total. When totalIsCapped (>COUNT_CAP
    // matches) this caps navigation at COUNT_CAP/perPage pages — intentional and
    // consistent with prior behavior. (The legacy path pages unbounded via N+1.)
    hasNext = total !== null && filters.page * filters.perPage < total;
    countSource = 'live';
  } else {
    // Legacy live-count case → DEFER. The streamed ResultCount fetches it.
    total = null;
    totalIsCapped = false;
    countSource = 'deferred';
  }

  return {
    rows,
    hasNext,
    total,
    totalIsCapped,
    volumeFit,
    timings: {
      metaLookupMs,
      rowsMs,
      countMs,
      usedPredicate: currentWeekEndDate !== undefined,
      countSource,
    },
  };
}

/**
 * Lazy node-postgres pool for the broad-search path only, reused across warm
 * serverless invocations. Broad queries can run up to the 115s statement
 * timeout — neon-http won't reliably hold a query that long.
 */
let broadPool: Pool | null = null;
function getBroadPool(): Pool {
  if (!broadPool) {
    broadPool = new Pool({
      connectionString: env.DATABASE_URL,
      max: 3,
      keepAlive: true,
      connectionTimeoutMillis: 20_000,
    });
    broadPool.on('error', (e: Error) => console.warn('[explorer broad pool] idle client error:', e.message));
  }
  return broadPool;
}

/**
 * Run a broad-search query (rows or fallback count) on a TCP connection in a
 * transaction with SET LOCAL statement_timeout = 115000. Returns the rows, or
 * 'timeout' when the DB cancels the query (Postgres error code 57014).
 */
async function runBroad(sql: string, args: unknown[]): Promise<Array<Record<string, unknown>> | 'timeout'> {
  const client = await getBroadPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL statement_timeout = 115000');
    const r = await client.query(sql, args);
    await client.query('COMMIT');
    return r.rows;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* connection may be dead */ }
    if ((e as { code?: string }).code === '57014') return 'timeout';
    throw e;
  } finally {
    client.release();
  }
}

/** Empty result flagged broadTimedOut, for the page to render a friendly message. */
function broadTimeoutResult(
  volumeFit: VolumeFitMeta | null,
  metaLookupMs: number,
  rowsMs: number,
  usedPredicate: boolean,
): ExplorerQueryResult {
  return {
    rows: [],
    hasNext: false,
    total: 0,
    totalIsCapped: false,
    volumeFit,
    broadTimedOut: true,
    timings: { metaLookupMs, rowsMs, countMs: 0, usedPredicate, countSource: 'live' },
  };
}

/**
 * Postgres bigint columns come back as strings from pg/neon-http to
 * preserve full 64-bit precision. For the volume / price columns we
 * top out well under 2^53, so parseInt is safe.
 */
function parseBigint(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  return typeof v === 'string' ? parseInt(v, 10) : v;
}

/**
 * Deferred, time-bounded match count for the heavy legacy path. Runs the
 * count on the TCP pool with SET LOCAL statement_timeout = 45s so it is
 * CANCELLABLE — it can never hang the page or the navigation. Returns null on
 * timeout (57014) or any error; the caller renders a graceful "many matches"
 * footer and pagination still works from hasNext.
 *
 * Rendered from a <Suspense> boundary, so its latency streams in independently
 * of the rows. Reuses the broad-search TCP pool (getBroadPool).
 */
export async function countExplorerMatches(
  filters: ExplorerFilters,
): Promise<{ total: number; totalIsCapped: boolean } | null> {
  // DIAGNOSTIC (temporary): a 'start' line always logs on entry; exactly one
  // terminal line (ok/timeout/failed/connect-fail) logs the outcome + elapsed.
  // 'start' with no terminal after minutes ⇒ a genuine server-side hang; 'ok'
  // with no UI update ⇒ the streamed result isn't reaching the client.
  const tStart = Date.now();
  const leafCount = filters.leafCategories.length;
  console.log('[explorer count] start', JSON.stringify({ leafCount }));
  const sqlClient = neon(env.DATABASE_URL);
  let currentWeekEndDate: string | undefined;
  try {
    const rows = (await sqlClient`
      SELECT current_week_end_date::text AS d
      FROM keyword_current_summary_meta WHERE singleton = true
    `) as Array<{ d: string | null }>;
    currentWeekEndDate = rows[0]?.d ?? undefined;
  } catch {
    // No predicate → the count still works, just without the planner hint.
  }
  const { countSql, countArgs } = buildExplorerQuery(filters, currentWeekEndDate);
  // Shares the broad-search pool (max: 3) with broad rows + broad fallback counts.
  // Under heavy concurrent load a 4th caller queues up to connectionTimeoutMillis
  // then rejects — caught by the OUTER try below and degraded to null, so the
  // footer never throws into the Suspense boundary (the route has no error.tsx).
  try {
    const client = await getBroadPool().connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL statement_timeout = 45000');
      const r = await client.query(countSql, countArgs);
      await client.query('COMMIT');
      const capped = applyCountCap(extractCount(r.rows as unknown as Array<{ total: number | string }>));
      console.log('[explorer count] ok', JSON.stringify({ leafCount, ms: Date.now() - tStart, total: capped.total, capped: capped.totalIsCapped }));
      return capped;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { /* connection may be dead */ }
      const ms = Date.now() - tStart;
      // 57014 = statement_timeout. Any error → best-effort: no exact count.
      if ((e as { code?: string }).code === '57014') {
        console.warn('[explorer count] timeout', JSON.stringify({ leafCount, ms }));
      } else {
        console.warn('[explorer count] failed', JSON.stringify({ leafCount, ms, msg: (e as Error).message }));
      }
      return null;
    } finally {
      client.release();
    }
  } catch (e) {
    // getBroadPool().connect() rejected (pool exhausted / connection timeout).
    console.warn('[explorer count] connect-fail', JSON.stringify({ leafCount, ms: Date.now() - tStart, msg: (e as Error).message }));
    return null;
  }
}
