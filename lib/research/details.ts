import { neon } from '@neondatabase/serverless';
import { env } from '@/lib/env';
import { fetchKeywordHeader, fetchKeywordProducts, type KeywordHeaderData, type KeywordProducts } from '@/lib/explorer/fetchKeywordDetail';
import type { KeywordDetailsResponse, ProductSlot, Severity, Warning } from './contracts';
import { dataUnavailableError, keywordNotFoundError } from './errors';
import { keywordUrlFor } from './links';
import { loadSnapshotMetaHttp, type SnapshotMeta } from './snapshot';

export interface SummaryRow {
  estimated_monthly_volume_current: string | null;
  avg_reviews: number | null;
  word_count: number | null;
  top_clicked_category_path: string | null;
  top_clicked_category_1_current: string | null;
  fake_volume_severity_current: string | null;
}
/**
 * Deps for `loadKeywordDetails`. `appUrl` builds the Explorer deep link (`keywordUrlFor`); the
 * four loaders — `header` (identity + current-week core fields), `products` (current-week
 * top-3 slots; only ever called for an active keyword), `summary` (the stored
 * `keyword_current_summary` row `search_keywords` also reads, so the two tools never
 * disagree), and `meta` (the snapshot kill switch and its volume-fit extrapolation flag) — are
 * read in parallel. `defaultDetailsDeps` wires the production implementations; tests inject
 * stubs.
 */
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

/**
 * Maps the current-week top-3 product slots (`KeywordProducts.currentWeekProductSlots`) to
 * `ProductSlot[]`, joining in Keepa enrichment (`enrichedProductsByAsin`) by ASIN where
 * present. Amazon-reported share strings become numbers; a slot with no ASIN, or one whose
 * ASIN was never enriched, reports every enrichment field as null rather than being omitted.
 */
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

/**
 * `get_keyword_details`: one keyword's identity, current-week metrics (from the stored
 * `keyword_current_summary` row, so this tool and `search_keywords` never disagree), and its
 * top-3 product slots (Keepa-enriched where available). `header`, `summary` and `meta` are
 * read in parallel — one wasted summary/meta read on an unknown id is an acceptable cost for
 * not serializing the common case.
 *
 * `status: 'dormant'` (no current-week row — last seen more than 28 days ago) returns
 * `current: null` and `products: []` WITHOUT ever calling `deps.products` (Q30): there is
 * nothing current to fetch products for.
 *
 * Throws `DATA_UNAVAILABLE` when the snapshot meta row is missing (the kill switch) — checked
 * first, right after the parallel reads, so a missing meta refuses the whole response (never
 * empty provenance strings, never a cacheable false `KEYWORD_NOT_FOUND`) — and then
 * `KEYWORD_NOT_FOUND` for an unknown `searchTermId`.
 */
export async function loadKeywordDetails(searchTermId: string, deps: DetailsDeps): Promise<KeywordDetailsResponse> {
  const [header, summary, meta] = await Promise.all([deps.header(searchTermId), deps.summary(searchTermId), deps.meta()]);
  // Meta is checked FIRST: the kill switch refuses the whole response (as search and history do),
  // so an outage can never be cached by a client as a non-retryable "id does not exist".
  if (!meta) throw dataUnavailableError();
  if (!header) throw keywordNotFoundError();
  const keywordUrl = keywordUrlFor(deps.appUrl, searchTermId);
  const warnings: Warning[] = [{ code: 'ESTIMATED_VOLUME', message: 'estimatedMonthlySearches is an estimate derived from rank and calibration.' }];
  const identity = { searchTermId, keyword: header.searchTermRaw, keywordUrl, firstSeenWeek: header.firstSeenWeek, lastSeenWeek: header.lastSeenWeek };

  if (!header.current) {
    warnings.push({ code: 'DORMANT', message: 'Not seen in the last 28 days of data; no current metrics exist. History may still be available.' });
    const provenance = { datasetWeek: meta.currentWeekEndDate, snapshotVersion: meta.snapshotVersion, resultCapturedAt: new Date().toISOString() };
    return { ...identity, provenance, status: 'dormant', current: null, products: [], warnings };
  }
  const cur = header.current;
  const products = toProductSlots(await deps.products(searchTermId, cur.currentWeekEndDate));
  // resultCapturedAt is computed here, after the products read resolves — it's the slow step,
  // so this is the truest "as of" timestamp for the response as a whole (Task 11 review).
  const provenance = { datasetWeek: meta.currentWeekEndDate, snapshotVersion: meta.snapshotVersion, resultCapturedAt: new Date().toISOString() };
  if (products.filter((p) => p.reviewCount !== null).length < 3) {
    warnings.push({
      code: 'PARTIAL_REVIEW_COVERAGE_POSSIBLE',
      message: 'averageReviews is the stored average over the latest enriched top-three products; fewer than three products in this response carry a current-week review count, so it may cover fewer than three.',
    });
  }

  // estimatedMonthlySearches prefers the stored kcs value (computed at refresh time with the
  // fit recorded in keyword_current_summary_meta.volume_fit_run_id — meta.isExtrapolated
  // describes THAT fit); only when nothing is stored does this fall back to the header's own
  // current-week figure, computed with the fit mapCurrent picked at read time, paired with
  // ITS OWN extrapolation flag. The two flags describe different fits, so they must never be
  // swapped in with the wrong volume (Task 11 review).
  const stored = summary?.estimated_monthly_volume_current ?? null;
  const estimatedMonthlySearches = stored !== null ? parseInt(stored, 10) : cur.estimatedMonthlyVolumeCurrent;
  const volumeIsExtrapolated = stored !== null ? meta.isExtrapolated : cur.estimatedMonthlyVolumeIsExtrapolated;
  if (volumeIsExtrapolated) {
    warnings.push({ code: 'EXTRAPOLATED_VOLUME', message: 'The dataset week predates every calibration month, so this volume estimate applies the earliest calibration fit backward in time; treat it as directional.' });
  }

  return {
    ...identity,
    provenance,
    status: 'active',
    current: {
      datasetWeek: cur.currentWeekEndDate,
      rank: cur.currentRank,
      priorWeekRank: cur.priorWeekRank,
      estimatedMonthlySearches,
      volumeIsExtrapolated,
      averageReviews: summary?.avg_reviews ?? null,
      wordCount: summary?.word_count ?? null,
      categoryPath: summary?.top_clicked_category_path ?? null,
      broadCategory: summary?.top_clicked_category_1_current ?? null,
      // summary.fake_volume_severity_current and cur.fakeVolumeSeverityCurrent are the exact
      // same masked kcs column (fake_volume_severity_current) — no distinct fallback needed.
      severity: (summary?.fake_volume_severity_current as Severity | null) ?? null,
      titleFlagsLoose: [cur.keywordInTitle1LooseCurrent, cur.keywordInTitle2LooseCurrent, cur.keywordInTitle3LooseCurrent],
    },
    products,
    warnings,
  };
}
