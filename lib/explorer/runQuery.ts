/**
 * Server-side runner for the explorer queries.
 *
 * Split into two entrypoints so the page can render the table without
 * waiting for the (sometimes slow) COUNT query:
 *
 *   - runExplorerRows(filters): meta lookup + paged rows.
 *   - runExplorerCount(filters): COUNT(*) for the pagination footer,
 *     with short-circuits for default landing + category-only.
 *
 * Both share a meta-lookup helper that's memoized for the request
 * via React's `cache()`, so back-to-back calls don't double-hit the
 * one-row meta table.
 *
 * The page wraps the count call in a <Suspense> boundary so the
 * table appears as soon as rows are ready; the pagination footer
 * streams in when the count finishes (or instantly when the
 * short-circuit applies).
 *
 * See the explorer-perf RFC + migrations 0020 / 0021.
 */
import { cache } from 'react';
import { neon } from '@neondatabase/serverless';
import { env } from '@/lib/env';
import { buildExplorerQuery, COUNT_CAP } from './buildQuery';
import type { ExplorerFilters, ExplorerRow, SeverityKey } from './types';
import { EXPLORER_DEFAULTS } from './parseFilters';

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
}

interface ExplorerMeta {
  currentWeekEndDate?: string;
  snapshotVersion?: string;
  defaultSeverityTotal?: number;
  metaLookupMs: number;
}

export interface ExplorerRowsResult {
  rows: ExplorerRow[];
  timings: {
    metaLookupMs: number;
    rowsMs: number;
    usedPredicate: boolean;
  };
}

export interface ExplorerCountResult {
  total: number;
  /** True when total === COUNT_CAP and the real total may be larger. */
  totalIsCapped: boolean;
  timings: {
    countMs: number;
    /** Where the count came from: 'meta' / 'facet' = precomputed (instant); 'live' = actual SQL. */
    countSource: 'live' | 'meta' | 'facet';
  };
}

/**
 * Memoized within a request so runExplorerRows + runExplorerCount
 * share one DB roundtrip.
 */
const fetchMeta = cache(async (): Promise<ExplorerMeta> => {
  const sqlClient = neon(env.DATABASE_URL);
  const tStart = Date.now();
  try {
    const rows = (await sqlClient`
      SELECT
        current_week_end_date::text AS current_week_end_date,
        snapshot_version::text       AS snapshot_version,
        default_severity_total       AS default_severity_total
      FROM keyword_current_summary_meta
      WHERE singleton = true
    `) as Array<{
      current_week_end_date: string | null;
      snapshot_version: string | null;
      default_severity_total: number | null;
    }>;
    return {
      currentWeekEndDate: rows[0]?.current_week_end_date ?? undefined,
      snapshotVersion: rows[0]?.snapshot_version ?? undefined,
      defaultSeverityTotal: rows[0]?.default_severity_total ?? undefined,
      metaLookupMs: Date.now() - tStart,
    };
  } catch {
    return { metaLookupMs: Date.now() - tStart };
  }
});

function isDefaultSeverity(severities: SeverityKey[]): boolean {
  const def = [...EXPLORER_DEFAULTS.severities].sort();
  const cur = [...severities].sort();
  return def.length === cur.length && def.every((s, i) => s === cur[i]);
}

function canUseDefaultTotal(f: ExplorerFilters): boolean {
  return (
    f.q === null
    && f.rankMin === null
    && f.rankMax === null
    && f.jump === null
    && f.category === null
    && f.titleMatchMode === null
    && isDefaultSeverity(f.severities)
  );
}

function canUseCategoryFacet(f: ExplorerFilters): boolean {
  return (
    f.q === null
    && f.rankMin === null
    && f.rankMax === null
    && f.jump === null
    && f.category !== null
    && f.titleMatchMode === null
    && isDefaultSeverity(f.severities)
  );
}

export async function runExplorerRows(filters: ExplorerFilters): Promise<ExplorerRowsResult> {
  const sqlClient = neon(env.DATABASE_URL);
  const meta = await fetchMeta();
  const { sql, args } = buildExplorerQuery(filters, meta.currentWeekEndDate);

  const tRowsStart = Date.now();
  const rawRowsAny = (await sqlClient.query(sql, args)) as unknown as RawRow[];
  const rowsMs = Date.now() - tRowsStart;

  const rows: ExplorerRow[] = rawRowsAny.map((r) => ({
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
  }));

  return {
    rows,
    timings: {
      metaLookupMs: meta.metaLookupMs,
      rowsMs,
      usedPredicate: meta.currentWeekEndDate !== undefined,
    },
  };
}

export async function runExplorerCount(filters: ExplorerFilters): Promise<ExplorerCountResult> {
  const sqlClient = neon(env.DATABASE_URL);
  const meta = await fetchMeta();

  // Short-circuit 1: default landing → use precomputed total.
  if (canUseDefaultTotal(filters) && meta.defaultSeverityTotal !== undefined) {
    const t = meta.defaultSeverityTotal;
    const capped = t > COUNT_CAP;
    return {
      total: capped ? COUNT_CAP : t,
      totalIsCapped: capped,
      timings: { countMs: 0, countSource: 'meta' },
    };
  }

  // Short-circuit 2: category-only + default severity → use facets.
  if (canUseCategoryFacet(filters) && meta.snapshotVersion) {
    try {
      const facetRows = (await sqlClient`
        SELECT default_severity_count AS n
        FROM keyword_current_summary_category_facets
        WHERE snapshot_version = ${meta.snapshotVersion}::uuid
          AND category = ${filters.category}
      `) as Array<{ n: number }>;
      if (facetRows.length > 0) {
        const n = facetRows[0].n;
        const capped = n > COUNT_CAP;
        return {
          total: capped ? COUNT_CAP : n,
          totalIsCapped: capped,
          timings: { countMs: 0, countSource: 'facet' },
        };
      }
    } catch {
      // Fall through to live count
    }
  }

  // Slow path: live COUNT(*) with the bail-out cap.
  const { countSql, countArgs } = buildExplorerQuery(filters, meta.currentWeekEndDate);
  const tStart = Date.now();
  const countRowsAny = (await sqlClient.query(countSql, countArgs)) as unknown as Array<{ total: number | string }>;
  const countMs = Date.now() - tStart;
  const rawTotal = countRowsAny.length > 0
    ? typeof countRowsAny[0].total === 'string'
      ? parseInt(countRowsAny[0].total, 10)
      : countRowsAny[0].total
    : 0;
  const capped = rawTotal > COUNT_CAP;
  return {
    total: capped ? COUNT_CAP : rawTotal,
    totalIsCapped: capped,
    timings: { countMs, countSource: 'live' },
  };
}
