import { neon } from '@neondatabase/serverless';
import { env } from '@/lib/env';
import { fetchKeywordHeader, fetchKeywordProducts, type KeywordHeaderData, type KeywordProducts } from '@/lib/explorer/fetchKeywordDetail';
import type { KeywordDetailsResponse, ProductSlot, Severity, Warning } from './contracts';
import { ResearchError } from './errors';
import { loadSnapshotMetaHttp, type SnapshotMeta } from './snapshot';

export interface SummaryRow {
  estimated_monthly_volume_current: string | null;
  avg_reviews: number | null;
  word_count: number | null;
  top_clicked_category_path: string | null;
  top_clicked_category_1_current: string | null;
  fake_volume_severity_current: string | null;
}
export interface DetailsDeps {
  appUrl: string;
  header: (id: string) => Promise<KeywordHeaderData | null>;
  products: (id: string, currentWeekEndDate: string) => Promise<KeywordProducts>;
  summary: (id: string) => Promise<SummaryRow | null>;
  meta: () => Promise<SnapshotMeta | null>;
}

/** The stored current row — the same fields search_keywords returns, so the two tools never disagree. */
export async function loadCurrentSummary(id: string): Promise<SummaryRow | null> {
  const sql = neon(env.DATABASE_URL);
  const rows = (await sql`
    SELECT estimated_monthly_volume_current::text AS estimated_monthly_volume_current,
           avg_reviews, word_count, top_clicked_category_path, top_clicked_category_1_current,
           fake_volume_severity_current::text AS fake_volume_severity_current
    FROM keyword_current_summary
    WHERE search_term_id = ${id}
  `) as SummaryRow[];
  return rows[0] ?? null;
}

export const defaultDetailsDeps = (appUrl: string): DetailsDeps => ({
  appUrl, header: fetchKeywordHeader, products: fetchKeywordProducts, summary: loadCurrentSummary, meta: loadSnapshotMetaHttp,
});

const pct = (v: string | null): number | null => (v === null ? null : Number.parseFloat(v));

export function toProductSlots(products: KeywordProducts): ProductSlot[] {
  return products.currentWeekProductSlots.map((s) => {
    const e = s.asin ? products.enrichedProductsByAsin[s.asin] : undefined;
    return {
      slot: s.slot,
      asin: s.asin,
      title: s.title,
      clickSharePct: pct(s.clickShare),
      conversionSharePct: pct(s.conversionShare),
      reviewCount: e?.reviewCount ?? null,
      ratingStars: e && e.averageRatingX10 !== null ? e.averageRatingX10 / 10 : null,
      currentPriceCents: e?.currentPriceCents ?? null,
      salesRank: e?.salesRank ?? null,
      enrichmentStatus: e?.enrichmentStatus ?? null,
    };
  });
}

export async function loadKeywordDetails(searchTermId: string, deps: DetailsDeps): Promise<KeywordDetailsResponse> {
  const header = await deps.header(searchTermId);
  if (!header) throw new ResearchError('KEYWORD_NOT_FOUND', 'No keyword exists with that id.');
  const [summary, meta] = await Promise.all([deps.summary(searchTermId), deps.meta()]);
  const keywordUrl = `${deps.appUrl.replace(/\/+$/, '')}/explorer/keyword/${searchTermId}`;
  const resultCapturedAt = new Date().toISOString();
  const provenance = { datasetWeek: meta?.currentWeekEndDate ?? '', snapshotVersion: meta?.snapshotVersion ?? '', resultCapturedAt };
  const warnings: Warning[] = [{ code: 'ESTIMATED_VOLUME', message: 'estimatedMonthlySearches is an estimate derived from rank and calibration.' }];
  const base = { searchTermId, keyword: header.searchTermRaw, keywordUrl, firstSeenWeek: header.firstSeenWeek, lastSeenWeek: header.lastSeenWeek, provenance };

  if (!header.current) {
    warnings.push({ code: 'DORMANT', message: 'Not seen in the last 28 days of data; no current metrics exist. History may still be available.' });
    return { ...base, status: 'dormant', current: null, products: [], warnings };
  }
  const cur = header.current;
  const products = toProductSlots(await deps.products(searchTermId, cur.currentWeekEndDate));
  if (products.filter((p) => p.reviewCount !== null).length < 3) {
    warnings.push({ code: 'PARTIAL_REVIEW_COVERAGE_POSSIBLE', message: 'averageReviews covers only the observed top-three products; fewer than three have review observations here.' });
  }
  return {
    ...base,
    status: 'active',
    current: {
      datasetWeek: cur.currentWeekEndDate,
      rank: cur.currentRank,
      priorWeekRank: cur.priorWeekRank,
      estimatedMonthlySearches: summary?.estimated_monthly_volume_current !== null && summary?.estimated_monthly_volume_current !== undefined
        ? parseInt(summary.estimated_monthly_volume_current, 10)
        : cur.estimatedMonthlyVolumeCurrent,
      volumeIsExtrapolated: cur.estimatedMonthlyVolumeIsExtrapolated,
      averageReviews: summary?.avg_reviews ?? null,
      wordCount: summary?.word_count ?? null,
      categoryPath: summary?.top_clicked_category_path ?? null,
      broadCategory: summary?.top_clicked_category_1_current ?? null,
      severity: ((summary?.fake_volume_severity_current ?? cur.fakeVolumeSeverityCurrent) as Severity | null) ?? null,
      titleFlagsLoose: [cur.keywordInTitle1LooseCurrent, cur.keywordInTitle2LooseCurrent, cur.keywordInTitle3LooseCurrent],
    },
    products,
    warnings,
  };
}
