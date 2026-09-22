import { describe, it, expect } from 'vitest';
import { compileSearch, mapSearchRow, orderByFor, rangePredicates, type RawSearchRow } from './query';
import { filtersSchema, type Sort } from './contracts';

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const F = (partial: Record<string, unknown> = {}) => filtersSchema.parse(partial);
const VOL_DESC: Sort = { field: 'estimatedMonthlySearches', direction: 'desc' };
const base = { sort: VOL_DESC, window: '4w' as const, leaves: [] as string[], currentWeekEndDate: '2026-09-12', offset: 0, limit: 51 };

describe('rangePredicates', () => {
  it('emits one exact comparator per bound in gt, gte, lt, lte order', () => {
    const args: unknown[] = [];
    const next = (v: unknown) => { args.push(v); return `$${args.length}`; };
    expect(rangePredicates('kcs.x', { gt: 1, lte: 9 }, next)).toEqual(['kcs.x > $1', 'kcs.x <= $2']);
    expect(rangePredicates('kcs.x', null, next)).toEqual([]);
    expect(args).toEqual([1, 9]);
  });
});

describe('compileSearch — the acceptance question (Q01, Q06, Q19)', () => {
  const c = compileSearch({ ...base, filters: F({ estimatedMonthlySearches: { gt: 10000 }, averageReviews: { lt: 500 } }), leaves: ['A › B', 'A › C'] });
  it('binds the week, exact comparators, the leaf OR-set and the default severities, then a deterministic order and page', () => {
    expect(norm(c.sql)).toContain(
      'WHERE kcs.current_week_end_date = $1::date AND kcs.estimated_monthly_volume_current > $2 AND kcs.avg_reviews < $3 AND kcs.top_clicked_category_path IN ($4, $5) AND (kcs.fake_volume_severity_current IS NULL OR kcs.fake_volume_severity_current IN ($6, $7)) ORDER BY kcs.current_rank ASC, kcs.search_term_id ASC LIMIT $8 OFFSET $9',
    );
    expect(c.args).toEqual(['2026-09-12', 10000, 500, 'A › B', 'A › C', 'none', 'warning', 51, 0]);
    expect(norm(c.sql)).toContain('FROM keyword_current_summary kcs JOIN search_terms st ON st.id = kcs.search_term_id');
  });
  it('counts over the same WHERE with a 10,001-row probe and the WHERE args only', () => {
    expect(norm(c.countSql)).toBe('SELECT COUNT(*)::int AS total FROM ( SELECT 1 FROM keyword_current_summary kcs WHERE kcs.current_week_end_date = $1::date AND kcs.estimated_monthly_volume_current > $2 AND kcs.avg_reviews < $3 AND kcs.top_clicked_category_path IN ($4, $5) AND (kcs.fake_volume_severity_current IS NULL OR kcs.fake_volume_severity_current IN ($6, $7)) LIMIT 10001 ) sub');
    expect(c.countArgs).toEqual(c.args.slice(0, 7));
  });
  it('selects the row projection with text-cast bigints and dates', () => {
    const s = norm(c.sql);
    for (const col of ['kcs.search_term_id', 'st.search_term_raw', 'st.first_seen_week::text AS first_seen_week', 'kcs.last_seen_week::text AS last_seen_week', 'kcs.estimated_monthly_volume_current::text AS estimated_monthly_volume_current', 'kcs.rank_4w_ago AS prior_rank', 'kcs.estimated_monthly_volume_4w_ago::text AS prior_volume_raw', 'kcs.keyword_in_title_1_loose_current', 'kcs.keyword_in_title_3_current']) {
      expect(s).toContain(col);
    }
  });
});

describe('compileSearch — other filters', () => {
  it('gte/lte, zero reviews, rank and word bounds (Q02–Q04)', () => {
    const c = compileSearch({ ...base, filters: F({ estimatedMonthlySearches: { gte: 10000 }, averageReviews: { lte: 0 }, rank: { lte: 100000 }, wordCount: { gte: 3 } }) });
    expect(norm(c.sql)).toContain('kcs.estimated_monthly_volume_current >= $2 AND kcs.avg_reviews <= $3 AND kcs.current_rank <= $4 AND kcs.word_count >= $5');
    expect(c.args.slice(1, 5)).toEqual([10000, 0, 100000, 3]);
  });
  it('text: whole-word regex or broad LIKE on the normalized column, lowercased and escaped (Q31)', () => {
    const w = compileSearch({ ...base, filters: F({ text: { value: 'Hair Oil' } }) });
    expect(norm(w.sql)).toContain('kcs.search_term_normalized ~ $2');
    expect(w.args[1]).toBe('\\mhair oil\\M');
    const b = compileSearch({ ...base, filters: F({ text: { value: '50% off_', mode: 'broad' } }) });
    expect(norm(b.sql)).toContain('kcs.search_term_normalized LIKE $2');
    expect(b.args[1]).toBe('%50\\% off\\_%');
  });
  it('severities: all three adds no predicate; critical alone binds one; broad category is an equality', () => {
    // The bare column name always appears (it's an unconditional SELECT projection column —
    // `severity` is a required SearchRow field, unlike movement/titleFlags), so this checks for
    // the WHERE-predicate shape specifically, matching this test's own "adds no predicate" claim.
    expect(norm(compileSearch({ ...base, filters: F({ severities: ['none', 'warning', 'critical'] }) }).sql)).not.toContain('fake_volume_severity_current IN (');
    const c = compileSearch({ ...base, filters: F({ severities: ['critical'], broadCategory: 'Beauty' }) });
    expect(norm(c.sql)).toContain('kcs.top_clicked_category_1_current = $2 AND kcs.fake_volume_severity_current IN ($3)');
    expect(c.args.slice(1)).toEqual(['Beauty', 'critical', 51, 0]);
  });
  it('title gap tests false flags, any = OR, all = AND, loose vs strict columns (Q18)', () => {
    const anyLoose = compileSearch({ ...base, filters: F({ titleGap: { slots: [1, 3] } }) });
    expect(norm(anyLoose.sql)).toContain('(kcs.keyword_in_title_1_loose_current = false OR kcs.keyword_in_title_3_loose_current = false)');
    const allStrict = compileSearch({ ...base, filters: F({ titleGap: { slots: [1, 2, 3], quantifier: 'all', mode: 'strict' } }) });
    expect(norm(allStrict.sql)).toContain('(kcs.keyword_in_title_1_current = false AND kcs.keyword_in_title_2_current = false AND kcs.keyword_in_title_3_current = false)');
  });
});

describe('compileSearch — window variants (M3)', () => {
  it('1w window: projection reads prior_week_rank / estimated_monthly_volume_1w_ago, and a movement predicate binds the same columns', () => {
    const c = compileSearch({ ...base, window: '1w', filters: F() });
    const s = norm(c.sql);
    expect(s).toContain('kcs.prior_week_rank AS prior_rank');
    expect(s).toContain('kcs.estimated_monthly_volume_1w_ago::text AS prior_volume_raw');
    const m = compileSearch({ ...base, window: '1w', filters: F({ movement: { window: '1w', metric: 'rank', prior: { gt: 100000 } } }) });
    expect(norm(m.sql)).toContain('kcs.prior_week_rank IS NOT NULL AND kcs.prior_week_rank > $2');
  });
});

describe('compileSearch — invariants (M2)', () => {
  it('throws a programming-error guard when movement.window differs from the comparison window (the catalog enforces equality upstream)', () => {
    expect(() =>
      compileSearch({ ...base, window: '4w', filters: F({ movement: { window: '13w', metric: 'volume', delta: { gt: 0 } } }) }),
    ).toThrow('compileSearch: movement window 13w differs from the comparison window 4w');
  });
});

const ELIG_4W = '(kcs.estimated_monthly_volume_current IS NOT NULL AND (kcs.rank_4w_ago IS NULL OR kcs.estimated_monthly_volume_4w_ago IS NOT NULL))';
const DELTA_4W = '(kcs.estimated_monthly_volume_current - CASE WHEN kcs.rank_4w_ago IS NULL THEN 0 ELSE kcs.estimated_monthly_volume_4w_ago END)';
const PRIOR_4W = 'CASE WHEN kcs.rank_4w_ago IS NULL THEN 0 ELSE kcs.estimated_monthly_volume_4w_ago END';

describe('compileSearch — movement (Q16, Q17)', () => {
  it('volume, observed baseline, positive delta: eligibility + prior present + delta bound on the shared expression', () => {
    const c = compileSearch({ ...base, filters: F({ movement: { window: '4w', metric: 'volume', delta: { gt: 0 } } }) });
    expect(norm(c.sql)).toContain(`${ELIG_4W} AND kcs.rank_4w_ago IS NOT NULL AND ${DELTA_4W} > $2`);
    expect(c.args[1]).toBe(0);
  });
  it('volume, include_not_observed: prior bound uses the zero-baseline expression and no prior-present guard', () => {
    const c = compileSearch({ ...base, filters: F({ movement: { window: '4w', metric: 'volume', baseline: 'include_not_observed', prior: { lt: 5000 }, current: { gt: 15000 } } }) });
    const s = norm(c.sql);
    expect(s).toContain(`${ELIG_4W} AND ${PRIOR_4W} < $2 AND kcs.estimated_monthly_volume_current > $3`);
    expect(s).not.toContain('kcs.rank_4w_ago IS NOT NULL');
  });
  it('rank, observed: prior present + prior/current bounds on rank columns; include_not_observed ORs the missing prior', () => {
    const o = compileSearch({ ...base, window: '13w', filters: F({ movement: { window: '13w', metric: 'rank', prior: { gt: 100000 }, current: { lt: 10000 } } }) });
    expect(norm(o.sql)).toContain('kcs.rank_13w_ago IS NOT NULL AND kcs.rank_13w_ago > $2 AND kcs.current_rank < $3');
    const n = compileSearch({ ...base, window: '13w', filters: F({ movement: { window: '13w', metric: 'rank', baseline: 'include_not_observed', prior: { gt: 100000 }, current: { lt: 10000 } } }) });
    expect(norm(n.sql)).toContain('(kcs.rank_13w_ago > $2 OR kcs.rank_13w_ago IS NULL) AND kcs.current_rank < $3');
  });
  it('volume, observed_only: the prior bound binds on the bare prior-volume column, not the zero-baseline CASE (index-friendly — M1)', () => {
    const c = compileSearch({ ...base, filters: F({ movement: { window: '4w', metric: 'volume', prior: { gte: 1000 } } }) });
    const s = norm(c.sql);
    const whereOnly = s.slice(s.indexOf('WHERE'), s.indexOf('ORDER BY'));
    expect(whereOnly).toContain('kcs.estimated_monthly_volume_4w_ago >= $2');
    expect(whereOnly).not.toContain('CASE WHEN');
  });
  it('volume movement with prior, current, and delta together binds all three in order after the eligibility/prior-present guards', () => {
    const c = compileSearch({ ...base, filters: F({ movement: { window: '4w', metric: 'volume', prior: { gte: 1000 }, current: { gte: 2000 }, delta: { gt: 0 } } }) });
    expect(norm(c.sql)).toContain(
      `${ELIG_4W} AND kcs.rank_4w_ago IS NOT NULL AND kcs.estimated_monthly_volume_4w_ago >= $2 AND kcs.estimated_monthly_volume_current >= $3 AND ${DELTA_4W} > $4`,
    );
    expect(c.args.slice(1, 4)).toEqual([1000, 2000, 0]);
  });
});

describe('orderByFor and sort-driven predicates (Q20)', () => {
  it('volume order runs as rank order with the id tie-break; other keys share the same tail, no NULLS LAST (nulls are excluded by the WHERE instead — F1)', () => {
    expect(orderByFor({ field: 'estimatedMonthlySearches', direction: 'desc' }, '4w')).toBe('ORDER BY kcs.current_rank ASC, kcs.search_term_id ASC');
    expect(orderByFor({ field: 'estimatedMonthlySearches', direction: 'asc' }, '4w')).toBe('ORDER BY kcs.current_rank DESC, kcs.search_term_id ASC');
    expect(orderByFor({ field: 'rank', direction: 'desc' }, '4w')).toBe('ORDER BY kcs.current_rank DESC, kcs.search_term_id ASC');
    expect(orderByFor({ field: 'averageReviews', direction: 'asc' }, '4w')).toBe('ORDER BY kcs.avg_reviews ASC, kcs.current_rank ASC, kcs.search_term_id ASC');
    expect(orderByFor({ field: 'wordCount', direction: 'desc' }, '4w')).toBe('ORDER BY kcs.word_count DESC, kcs.current_rank ASC, kcs.search_term_id ASC');
    expect(orderByFor({ field: 'volumeDelta', direction: 'desc' }, '4w')).toBe(`ORDER BY ${DELTA_4W} DESC, kcs.current_rank ASC, kcs.search_term_id ASC`);
  });
  it('a volumeDelta sort without a movement filter still adds the eligibility predicate', () => {
    const c = compileSearch({ ...base, filters: F(), sort: { field: 'volumeDelta', direction: 'desc' } });
    expect(norm(c.sql)).toContain(`AND ${ELIG_4W} ORDER BY`);
  });
  it('rank-metric movement + volumeDelta sort: the eligibility guard still runs exactly once (I1 — movement itself adds nothing for rank)', () => {
    const c = compileSearch({ ...base, filters: F({ movement: { window: '4w', metric: 'rank', prior: { gt: 100000 } } }), sort: { field: 'volumeDelta', direction: 'desc' } });
    expect(norm(c.sql).split(ELIG_4W).length - 1).toBe(1);
    expect(norm(c.countSql).split(ELIG_4W).length - 1).toBe(1);
  });
  it('volume-metric movement + volumeDelta sort: still exactly one eligibility guard (movement and the sort-driven guard never both add it)', () => {
    const c = compileSearch({ ...base, filters: F({ movement: { window: '4w', metric: 'volume', delta: { gt: 0 } } }), sort: { field: 'volumeDelta', direction: 'desc' } });
    expect(norm(c.sql).split(ELIG_4W).length - 1).toBe(1);
  });
  it('an averageReviews sort excludes null-review rows so the index serves both directions (F1); the count shares the same WHERE', () => {
    const c = compileSearch({ ...base, filters: F(), sort: { field: 'averageReviews', direction: 'desc' } });
    expect(norm(c.sql)).toContain('AND kcs.avg_reviews IS NOT NULL ORDER BY kcs.avg_reviews DESC, kcs.current_rank ASC, kcs.search_term_id ASC');
    expect(norm(c.countSql)).toContain('kcs.avg_reviews IS NOT NULL LIMIT 10001');
  });
  it('an averageReviews sort with an existing reviews bound still adds IS NOT NULL exactly once, and the bound keeps its arg number', () => {
    const c = compileSearch({ ...base, filters: F({ averageReviews: { lt: 500 } }), sort: { field: 'averageReviews', direction: 'desc' } });
    const s = norm(c.sql);
    expect(s).toContain('kcs.avg_reviews < $2');
    expect(c.args[1]).toBe(500);
    expect((s.match(/kcs\.avg_reviews IS NOT NULL/g) ?? []).length).toBe(1);
  });
  it('a wordCount sort excludes null-word-count rows the same way (no dedicated index, same semantics for consistency); the count shares the same WHERE', () => {
    const c = compileSearch({ ...base, filters: F(), sort: { field: 'wordCount', direction: 'asc' } });
    expect(norm(c.sql)).toContain('AND kcs.word_count IS NOT NULL ORDER BY kcs.word_count ASC, kcs.current_rank ASC, kcs.search_term_id ASC');
    expect(norm(c.countSql)).toContain('kcs.word_count IS NOT NULL LIMIT 10001');
  });
  it('a wordCount sort with an existing word-count bound still adds IS NOT NULL exactly once', () => {
    const c = compileSearch({ ...base, filters: F({ wordCount: { gte: 3 } }), sort: { field: 'wordCount', direction: 'desc' } });
    const s = norm(c.sql);
    expect(s).toContain('kcs.word_count >= $2');
    expect((s.match(/kcs\.word_count IS NOT NULL/g) ?? []).length).toBe(1);
  });
  it('a volumeDelta sort steers the count onto the partial index via a matching ORDER BY + LIMIT (F2)', () => {
    const c = compileSearch({ ...base, filters: F(), sort: { field: 'volumeDelta', direction: 'desc' } });
    expect(norm(c.countSql)).toContain(`ORDER BY ${DELTA_4W} DESC LIMIT 10001`);
    expect(c.countArgs).toEqual(c.args.slice(0, -2));
  });
  it('a non-volumeDelta sort keeps the plain, unordered count', () => {
    const c = compileSearch({ ...base, filters: F(), sort: { field: 'rank', direction: 'asc' } });
    expect(norm(c.countSql)).not.toContain('ORDER BY');
  });
  it('the steering follows the sort direction and the window (F2: asc, 13w)', () => {
    const c = compileSearch({ ...base, filters: F(), window: '13w', sort: { field: 'volumeDelta', direction: 'asc' } });
    expect(norm(c.countSql)).toContain('ORDER BY (kcs.estimated_monthly_volume_current - CASE WHEN kcs.rank_13w_ago IS NULL THEN 0 ELSE kcs.estimated_monthly_volume_13w_ago END) ASC LIMIT 10001');
  });
  it('a volumeDelta sort with a leaf scope or a text match keeps the plain count (the bitmap path is faster; F2 probe 2)', () => {
    const scoped = compileSearch({ ...base, filters: F(), leaves: ['A › B'], sort: { field: 'volumeDelta', direction: 'desc' } });
    expect(norm(scoped.countSql)).not.toContain('ORDER BY');
    const text = compileSearch({ ...base, filters: F({ text: { value: 'lamp' } }), sort: { field: 'volumeDelta', direction: 'desc' } });
    expect(norm(text.countSql)).not.toContain('ORDER BY');
  });
});

describe('mapSearchRow', () => {
  const raw: RawSearchRow = {
    search_term_id: 'id-1', search_term_raw: 'Hair Oil', first_seen_week: '2025-01-04', last_seen_week: '2026-09-12', current_rank: 1234,
    estimated_monthly_volume_current: '48210', avg_reviews: 312, word_count: 2, top_clicked_category_path: 'Beauty › Hair Care', top_clicked_category_1_current: 'Beauty',
    fake_volume_severity_current: null, prior_rank: 2000, prior_volume_raw: '30000', volume_delta: '18210',
    keyword_in_title_1_loose_current: true, keyword_in_title_2_loose_current: null, keyword_in_title_3_loose_current: false,
    keyword_in_title_1_current: false, keyword_in_title_2_current: null, keyword_in_title_3_current: null,
  };
  const ctx = { appUrl: 'https://keywordquarry.com/', window: '4w' as const, includeMovement: true, titleMode: 'loose' as const };
  it('parses numbers, builds the canonical link, labels the observed baseline, and exposes the requested flags', () => {
    expect(mapSearchRow(raw, ctx)).toEqual({
      searchTermId: 'id-1', keyword: 'Hair Oil', keywordUrl: 'https://keywordquarry.com/explorer/keyword/id-1',
      estimatedMonthlySearches: 48210, averageReviews: 312, rank: 1234, wordCount: 2, categoryPath: 'Beauty › Hair Care', broadCategory: 'Beauty',
      severity: null, lastSeenWeek: '2026-09-12', firstSeenWeek: '2025-01-04',
      movement: { window: '4w', priorRank: 2000, priorVolume: 30000, volumeDelta: 18210, baselineStatus: 'observed' },
      titleFlags: { mode: 'loose', slots: [true, null, false] },
    });
  });
  it('distinguishes not_observed (zero baseline, labelled) from calibration_unavailable (null delta), and omits optional blocks', () => {
    const none = mapSearchRow({ ...raw, prior_rank: null, prior_volume_raw: null, volume_delta: '48210' }, ctx);
    expect(none.movement).toEqual({ window: '4w', priorRank: null, priorVolume: 0, volumeDelta: 48210, baselineStatus: 'not_observed' });
    const noFit = mapSearchRow({ ...raw, prior_volume_raw: null, volume_delta: null }, ctx);
    expect(noFit.movement).toEqual({ window: '4w', priorRank: 2000, priorVolume: null, volumeDelta: null, baselineStatus: 'calibration_unavailable' });
    const plain = mapSearchRow({ ...raw, estimated_monthly_volume_current: null }, { ...ctx, includeMovement: false, titleMode: null });
    expect(plain.movement).toBeUndefined();
    expect(plain.titleFlags).toBeUndefined();
    expect(plain.estimatedMonthlySearches).toBeNull();
  });
  it('titleMode strict reads the strict columns (not loose)', () => {
    const strict = mapSearchRow(raw, { ...ctx, titleMode: 'strict' });
    expect(strict.titleFlags).toEqual({ mode: 'strict', slots: [false, null, null] });
  });
});

describe('compileSearch — every filter kind at once (M3)', () => {
  it('pins the full args order across text, broadCategory, two leaves, titleGap, a volume-movement delta, and severities', () => {
    const c = compileSearch({
      ...base,
      leaves: ['A › B', 'A › C'],
      filters: F({
        text: { value: 'Hair Oil' },
        broadCategory: 'Beauty',
        titleGap: { slots: [1, 3] },
        movement: { window: '4w', metric: 'volume', delta: { gt: 0 } },
        severities: ['critical'],
      }),
    });
    expect(c.args).toEqual(['2026-09-12', '\\mhair oil\\M', 'Beauty', 'A › B', 'A › C', 0, 'critical', 51, 0]);
    const s = norm(c.sql);
    expect(s).toContain('kcs.search_term_normalized ~ $2');
    expect(s).toContain('kcs.top_clicked_category_1_current = $3');
    expect(s).toContain('kcs.top_clicked_category_path IN ($4, $5)');
    expect(s).toContain(`${ELIG_4W} AND kcs.rank_4w_ago IS NOT NULL AND ${DELTA_4W} > $6`);
    expect(s).toContain('kcs.fake_volume_severity_current IN ($7)');
    expect(s).toContain('(kcs.keyword_in_title_1_loose_current = false OR kcs.keyword_in_title_3_loose_current = false)');
  });
});
