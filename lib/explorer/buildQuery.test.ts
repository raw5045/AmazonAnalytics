import { describe, it, expect } from 'vitest';
import { buildExplorerQuery, sortUsesVolumeDelta, volumeDeltaEligibility, volumeDeltaExpr, wordCountExpr, categoryPathIsCovered } from './buildQuery';
import { EXPLORER_DEFAULTS } from './parseFilters';
import type { ExplorerFilters, WindowKey } from './types';

const baseFilters: ExplorerFilters = { ...EXPLORER_DEFAULTS };

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

describe('buildExplorerQuery', () => {
  describe('with default filters (no URL params)', () => {
    it('returns the top-100 keywords sorted by current_rank ASC', () => {
      const { sql, args, countSql, countArgs } = buildExplorerQuery(baseFilters);

      // Default severities are ['none', 'warning'] → those are the only WHERE args
      expect(countArgs).toEqual(['none', 'warning']);
      // Main SQL adds LIMIT (101, N+1) and OFFSET (0) at the end
      expect(args).toEqual(['none', 'warning', 101, 0]);

      expect(norm(sql)).toContain('FROM keyword_current_summary kcs');
      expect(norm(sql)).toContain('JOIN search_terms st ON st.id = kcs.search_term_id');
      expect(norm(sql)).toContain('ORDER BY kcs.current_rank ASC');
      expect(norm(sql)).toContain('LIMIT $3 OFFSET $4');
      expect(norm(sql)).toContain('AS prior_rank');
      expect(norm(sql)).toContain('AS improvement');

      // Default severity filter — covers NULL since 'none' is selected
      expect(norm(sql)).toContain('IS NULL OR kcs.fake_volume_severity_current IN ($1, $2)');

      // countSql shares the WHERE-clause args + uses the bail-out subquery
      // pattern so it stops counting after COUNT_CAP+1 matches.
      expect(norm(countSql)).toContain('SELECT COUNT(*)::int AS total');
      expect(norm(countSql)).toContain('LIMIT 10001');
      expect(norm(countSql)).not.toContain('OFFSET');
      expect(norm(countSql)).not.toContain('ORDER BY');
    });
  });

  describe('window selector', () => {
    it('uses prior_week_rank for 1w window', () => {
      const { sql } = buildExplorerQuery(baseFilters);
      expect(norm(sql)).toContain('kcs.prior_week_rank AS prior_rank');
      expect(norm(sql)).toContain('kcs.improvement_1w AS improvement');
    });

    it('uses rank_4w_ago for 4w window', () => {
      const { sql } = buildExplorerQuery({ ...baseFilters, window: '4w' });
      expect(norm(sql)).toContain('kcs.rank_4w_ago AS prior_rank');
      expect(norm(sql)).toContain('kcs.improvement_4w AS improvement');
    });

    it('uses rank_52w_ago for 52w window', () => {
      const { sql } = buildExplorerQuery({ ...baseFilters, window: '52w' });
      expect(norm(sql)).toContain('kcs.rank_52w_ago AS prior_rank');
      expect(norm(sql)).toContain('kcs.improvement_52w AS improvement');
    });
  });

  describe('search term substring (q) — single-table match on kcs', () => {
    it('whole-word: matches kcs.search_term_normalized with ~ and a word-boundary pattern', () => {
      const { sql, args } = buildExplorerQuery({ ...baseFilters, q: 'wireless' });
      expect(norm(sql)).toMatch(/kcs\.search_term_normalized ~ \$\d/);
      expect(norm(sql)).not.toContain('WITH matches');
      expect(norm(sql)).not.toContain('search_term_normalized LIKE');
      expect(norm(sql)).toContain('(count(*) OVER ())::int AS total');
      expect(args).toContain('\\mwireless\\M');
    });

    it('broad: matches with LIKE and a %substring% pattern', () => {
      const { sql, args } = buildExplorerQuery({ ...baseFilters, q: 'wireless', qMode: 'broad' });
      expect(norm(sql)).toMatch(/kcs\.search_term_normalized LIKE \$\d/);
      expect(norm(sql)).not.toContain('search_term_normalized ~');
      expect(args).toContain('%wireless%');
    });

    it('lowercases + escapes regex/LIKE metacharacters in the term', () => {
      expect(buildExplorerQuery({ ...baseFilters, q: 'WiReLeSS' }).args).toContain('\\mwireless\\M');
      expect(buildExplorerQuery({ ...baseFilters, q: 'c++' }).args).toContain('\\mc\\+\\+\\M');
      expect(buildExplorerQuery({ ...baseFilters, q: '50%', qMode: 'broad' }).args).toContain('%50\\%%');
    });

    it('reads via an inner subquery joined to search_terms for raw on the page rows', () => {
      const { sql } = buildExplorerQuery({ ...baseFilters, q: 'wireless' });
      expect(norm(sql)).toContain('FROM keyword_current_summary kcs');
      expect(norm(sql)).toContain(') k JOIN search_terms st ON st.id = k.search_term_id');
      expect(norm(sql)).toContain('k.search_term_id');
      expect(norm(sql)).toContain('st.search_term_raw');
    });

    it('flags countFromRows so the runner reads the total from the rows pass', () => {
      const { countFromRows } = buildExplorerQuery({ ...baseFilters, q: 'wireless' });
      expect(countFromRows).toBe(true);
    });

    it('sorts by ANY column: inner ORDER BY kcs.<col>, outer ORDER BY k.<alias>', () => {
      const reviews = buildExplorerQuery({ ...baseFilters, q: 'hair', sort: 'avg_reviews_desc' });
      expect(norm(reviews.sql)).toContain('ORDER BY kcs.avg_reviews DESC NULLS LAST');
      expect(norm(reviews.sql)).toContain('ORDER BY k.avg_reviews DESC NULLS LAST');
      const imp = buildExplorerQuery({ ...baseFilters, q: 'hair', window: '4w', sort: 'imp' });
      expect(norm(imp.sql)).toContain('ORDER BY (kcs.estimated_monthly_volume_current - CASE WHEN kcs.rank_4w_ago IS NULL THEN 0 ELSE kcs.estimated_monthly_volume_4w_ago END) DESC');
      expect(norm(imp.sql)).toContain('ORDER BY k.volume_delta DESC');
    });

    it('composes other filters into the inner WHERE (alongside the match)', () => {
      const { sql } = buildExplorerQuery({ ...baseFilters, q: 'hair', rankMax: 1000, category: 'Electronics' });
      const innerEnd = norm(sql).indexOf(') k JOIN');
      const inner = norm(sql).slice(0, innerEnd);
      expect(inner).toContain('kcs.current_rank <=');
      expect(inner).toContain('kcs.top_clicked_category_1_current =');
      expect(inner).toContain('kcs.search_term_normalized ~');
    });

    it('skips the q match when q is null (legacy path)', () => {
      const { sql, countFromRows } = buildExplorerQuery({ ...baseFilters, q: null });
      expect(norm(sql)).not.toContain('search_term_normalized');
      expect(norm(sql)).toContain('JOIN search_terms st ON st.id = kcs.search_term_id');
      expect(countFromRows).toBeFalsy();
    });
  });

  describe('rank min/max', () => {
    it('adds >= and <= clauses when both bounds present', () => {
      const { sql, countArgs } = buildExplorerQuery({
        ...baseFilters,
        rankMin: 1,
        rankMax: 1000,
      });
      expect(norm(sql)).toContain('kcs.current_rank >=');
      expect(norm(sql)).toContain('kcs.current_rank <=');
      expect(countArgs).toContain(1);
      expect(countArgs).toContain(1000);
    });

    it('adds only the bound that is set', () => {
      const { sql } = buildExplorerQuery({ ...baseFilters, rankMin: 100, rankMax: null });
      expect(norm(sql)).toContain('kcs.current_rank >=');
      expect(norm(sql)).not.toContain('kcs.current_rank <=');
    });
  });

  describe('avg-reviews range filter', () => {
    it('pushes both bounds into rows and count SQL (default path)', () => {
      const { sql, countSql, args, countArgs } = buildExplorerQuery({ ...baseFilters, reviewsMin: 100, reviewsMax: 500 });
      expect(norm(sql)).toContain('kcs.avg_reviews >= $');
      expect(norm(sql)).toContain('kcs.avg_reviews <= $');
      // Pin the NULL-drop semantics: bounds must be plain comparisons, not
      // NULL-tolerant rewrites (unknown ≠ low — see ExplorerFilters docs).
      expect(norm(sql)).not.toContain('avg_reviews IS NULL');
      expect(norm(sql)).not.toContain('COALESCE');
      expect(norm(countSql)).toContain('kcs.avg_reviews >= $');
      expect(norm(countSql)).toContain('kcs.avg_reviews <= $');
      expect(args).toContain(100);
      expect(args).toContain(500);
      expect(countArgs).toContain(100);
      expect(countArgs).toContain(500);
    });

    it('emits a lone bound independently', () => {
      const minOnly = buildExplorerQuery({ ...baseFilters, reviewsMin: 1000 });
      expect(norm(minOnly.sql)).toContain('kcs.avg_reviews >= $');
      expect(norm(minOnly.sql)).not.toContain('kcs.avg_reviews <= $');
    });

    it('treats reviewsMax: 0 as an active bound (not falsy-skipped)', () => {
      // countArgs, not args: args ends in OFFSET 0 on page 1, which would
      // satisfy a toContain(0) even if the bound were falsy-skipped.
      const { sql, countArgs } = buildExplorerQuery({ ...baseFilters, reviewsMax: 0 });
      expect(norm(sql)).toContain('kcs.avg_reviews <= $');
      expect(countArgs).toContain(0);
    });

    it('emits no reviews predicates by default', () => {
      const { sql, countSql } = buildExplorerQuery(baseFilters);
      expect(norm(sql)).not.toContain('avg_reviews >=');
      expect(norm(sql)).not.toContain('avg_reviews <=');
      expect(norm(countSql)).not.toContain('avg_reviews >=');
      expect(norm(countSql)).not.toContain('avg_reviews <=');
    });

    it('applies reviews predicates on the q path too', () => {
      const { sql, countSql } = buildExplorerQuery({ ...baseFilters, q: 'magnesium', reviewsMax: 500 });
      expect(norm(sql)).toContain('kcs.avg_reviews <= $');
      expect(norm(countSql)).toContain('kcs.avg_reviews <= $');
    });

    it('composes with the volume-delta sorts (reviews + eligibility both present)', () => {
      const { sql } = buildExplorerQuery({ ...baseFilters, sort: 'imp', reviewsMax: 500 });
      expect(norm(sql)).toContain('kcs.avg_reviews <= $');
      expect(norm(sql)).toContain('estimated_monthly_volume_current IS NOT NULL');
    });
  });

  describe('threshold jump (1.4)', () => {
    it('500k → 100k uses prior_week_rank for 1w window', () => {
      const { sql, countArgs } = buildExplorerQuery({ ...baseFilters, jump: '500k_to_100k' });
      expect(norm(sql)).toContain('kcs.prior_week_rank >');
      expect(norm(sql)).toContain('kcs.current_rank <');
      expect(countArgs).toContain(500_000);
      expect(countArgs).toContain(100_000);
    });

    it('500k → 100k uses rank_4w_ago when window is 4w', () => {
      const { sql } = buildExplorerQuery({
        ...baseFilters,
        window: '4w',
        jump: '500k_to_100k',
      });
      expect(norm(sql)).toContain('kcs.rank_4w_ago >');
      expect(norm(sql)).toContain('kcs.current_rank <');
    });

    it('100k → 50k uses correct thresholds', () => {
      const { countArgs } = buildExplorerQuery({ ...baseFilters, jump: '100k_to_50k' });
      expect(countArgs).toContain(100_000);
      expect(countArgs).toContain(50_000);
    });

    it('100k → 10k uses correct thresholds', () => {
      const { countArgs } = buildExplorerQuery({ ...baseFilters, jump: '100k_to_10k' });
      expect(countArgs).toContain(100_000);
      expect(countArgs).toContain(10_000);
    });

    it('50k → 10k uses correct thresholds', () => {
      const { countArgs } = buildExplorerQuery({ ...baseFilters, jump: '50k_to_10k' });
      expect(countArgs).toContain(50_000);
      expect(countArgs).toContain(10_000);
    });
  });

  describe('category filter', () => {
    it('adds an equality clause when set', () => {
      const { sql, countArgs } = buildExplorerQuery({
        ...baseFilters,
        category: 'Electronics',
      });
      expect(norm(sql)).toContain('kcs.top_clicked_category_1_current =');
      expect(countArgs).toContain('Electronics');
    });
  });

  describe('leaf path filter', () => {
    it('filters by full category path when leafPaths set', () => {
      const built = buildExplorerQuery(
        { ...baseFilters, leafPaths: ['Automotive › Interior Accessories › Air Fresheners'] },
        '2026-06-20',
      );
      expect(built.sql).toContain('top_clicked_category_path IN');
      expect(built.args).toContain('Automotive › Interior Accessories › Air Fresheners');
    });
  });

  describe('severity filter (1.6)', () => {
    it('default [none, warning] includes NULLs', () => {
      const { sql } = buildExplorerQuery(baseFilters);
      expect(norm(sql)).toContain('IS NULL OR kcs.fake_volume_severity_current IN');
    });

    it('[warning] alone excludes NULLs', () => {
      const { sql, countArgs } = buildExplorerQuery({
        ...baseFilters,
        severities: ['warning'],
      });
      expect(norm(sql)).toContain('kcs.fake_volume_severity_current IN');
      expect(norm(sql)).not.toContain('IS NULL OR kcs.fake_volume_severity_current IN');
      expect(countArgs).toEqual(['warning']);
    });

    it('[none, warning, critical] adds no severity clause (all 3)', () => {
      const { sql, countArgs } = buildExplorerQuery({
        ...baseFilters,
        severities: ['none', 'warning', 'critical'],
      });
      expect(norm(sql)).not.toContain('fake_volume_severity_current IN');
      expect(norm(sql)).not.toContain('fake_volume_severity_current IS NULL');
      expect(countArgs).toEqual([]);
    });
  });

  describe('title-gap filter (1.7)', () => {
    it('"any" mode with all 3 slots → at least one is false (loose default)', () => {
      const { sql } = buildExplorerQuery({
        ...baseFilters,
        titleMatchMode: 'any',
        titleSlots: [1, 2, 3],
      });
      expect(norm(sql)).toContain('NOT kcs.keyword_in_title_1_loose_current OR NOT kcs.keyword_in_title_2_loose_current OR NOT kcs.keyword_in_title_3_loose_current');
    });

    it('"all" mode with all 3 slots → every slot is false (loose default)', () => {
      const { sql } = buildExplorerQuery({
        ...baseFilters,
        titleMatchMode: 'all',
        titleSlots: [1, 2, 3],
      });
      expect(norm(sql)).toContain('NOT kcs.keyword_in_title_1_loose_current AND NOT kcs.keyword_in_title_2_loose_current AND NOT kcs.keyword_in_title_3_loose_current');
    });

    it('strict matchMode uses the non-loose columns', () => {
      const { sql } = buildExplorerQuery({
        ...baseFilters,
        titleMatchMode: 'any',
        titleSlots: [1, 2, 3],
        matchMode: 'strict',
      });
      expect(norm(sql)).toContain('NOT kcs.keyword_in_title_1_current OR NOT kcs.keyword_in_title_2_current OR NOT kcs.keyword_in_title_3_current');
      expect(norm(sql)).not.toContain('keyword_in_title_1_loose_current OR');
    });

    it('"any" mode with only slot 1 selected (loose default)', () => {
      const { sql } = buildExplorerQuery({
        ...baseFilters,
        titleMatchMode: 'any',
        titleSlots: [1],
      });
      // The WHERE clause should reference slot 1 only, not 2 or 3.
      // (The SELECT list always includes all 3 slots for display.)
      const whereStart = norm(sql).indexOf('WHERE');
      const whereEnd = norm(sql).indexOf('ORDER BY');
      const whereOnly = norm(sql).slice(whereStart, whereEnd);
      expect(whereOnly).toContain('NOT kcs.keyword_in_title_1_loose_current');
      expect(whereOnly).not.toContain('keyword_in_title_2_loose_current');
      expect(whereOnly).not.toContain('keyword_in_title_3_loose_current');
    });

    it('no titleMatchMode → no title-gap WHERE clause', () => {
      const { sql } = buildExplorerQuery({ ...baseFilters, titleMatchMode: null });
      expect(norm(sql)).not.toContain('keyword_in_title_1_current AND');
      expect(norm(sql)).not.toContain('keyword_in_title_1_current OR');
    });
  });

  describe('sort options (section 2)', () => {
    it('rank → ASC', () => {
      const { sql } = buildExplorerQuery({ ...baseFilters, sort: 'rank' });
      expect(norm(sql)).toContain('ORDER BY kcs.current_rank ASC');
    });

    it('rank_desc → DESC', () => {
      const { sql } = buildExplorerQuery({ ...baseFilters, sort: 'rank_desc' });
      expect(norm(sql)).toContain('ORDER BY kcs.current_rank DESC');
    });

    it('imp → volume delta DESC (window-relative)', () => {
      const { sql } = buildExplorerQuery({ ...baseFilters, window: '4w', sort: 'imp' });
      expect(norm(sql)).toContain('ORDER BY (kcs.estimated_monthly_volume_current - CASE WHEN kcs.rank_4w_ago IS NULL THEN 0 ELSE kcs.estimated_monthly_volume_4w_ago END) DESC');
    });

    it('decline → volume delta ASC (window-relative)', () => {
      const { sql } = buildExplorerQuery({ ...baseFilters, window: '13w', sort: 'decline' });
      expect(norm(sql)).toContain('ORDER BY (kcs.estimated_monthly_volume_current - CASE WHEN kcs.rank_13w_ago IS NULL THEN 0 ELSE kcs.estimated_monthly_volume_13w_ago END) ASC');
    });

    it('title_gap (loose default) → keyword_title_match_count_loose_current ASC', () => {
      const { sql } = buildExplorerQuery({ ...baseFilters, sort: 'title_gap' });
      expect(norm(sql)).toContain('ORDER BY kcs.keyword_title_match_count_loose_current ASC');
    });

    it('title_gap with strict matchMode → keyword_title_match_count_current ASC', () => {
      const { sql } = buildExplorerQuery({ ...baseFilters, sort: 'title_gap', matchMode: 'strict' });
      expect(norm(sql)).toMatch(/ORDER BY kcs\.keyword_title_match_count_current ASC/);
      expect(norm(sql)).not.toContain('ORDER BY kcs.keyword_title_match_count_loose_current ASC');
    });
  });

  describe('pagination', () => {
    it('legacy page 1 with default per_page → LIMIT 101 (N+1) OFFSET 0', () => {
      const { args } = buildExplorerQuery(baseFilters);
      expect(args.slice(-2)).toEqual([101, 0]);
    });
    it('legacy page 3 per_page 100 → LIMIT 101 OFFSET 200', () => {
      const { args } = buildExplorerQuery({ ...baseFilters, page: 3 });
      expect(args.slice(-2)).toEqual([101, 200]);
    });
    it('legacy custom per_page → LIMIT perPage+1', () => {
      const { args } = buildExplorerQuery({ ...baseFilters, page: 1, perPage: 50 });
      expect(args.slice(-2)).toEqual([51, 0]);
    });
    it('q-path LIMIT is unchanged (exact perPage — window count handles totals)', () => {
      const { args } = buildExplorerQuery({ ...baseFilters, q: 'wireless', perPage: 50 });
      expect(args.slice(-2)).toEqual([50, 0]);
    });
  });

  describe('countSql vs sql', () => {
    it('non-q countSql uses the bail-out LIMIT, no ORDER BY / OFFSET', () => {
      const { countSql } = buildExplorerQuery({ ...baseFilters, rankMin: 1, rankMax: 50000 });
      expect(norm(countSql)).toContain('current_rank >=');
      expect(norm(countSql)).toContain('current_rank <=');
      expect(norm(countSql)).not.toContain('ORDER BY');
      expect(norm(countSql)).toContain('LIMIT 10001');
      expect(norm(countSql)).not.toContain('OFFSET');
    });

    it('countArgs is a strict prefix of args', () => {
      const filters: ExplorerFilters = {
        ...baseFilters,
        q: 'foo',
        category: 'Electronics',
        rankMin: 1,
        rankMax: 1000,
        reviewsMin: null,
        reviewsMax: null,
        wordsMin: null,
        wordsMax: null,
        page: 2,
      };
      const { args, countArgs } = buildExplorerQuery(filters);
      expect(args.slice(0, countArgs.length)).toEqual(countArgs);
      expect(args.length).toBe(countArgs.length + 2);
    });

    it('drops the search_terms join from countSql when no filter references st', () => {
      const { countSql } = buildExplorerQuery({ ...baseFilters, rankMax: 50_000 });
      expect(norm(countSql)).toContain('FROM keyword_current_summary kcs');
      expect(norm(countSql)).not.toContain('JOIN search_terms');
    });

    it('q countSql is the single-table empty-page fallback (no CTE, no bail-out LIMIT)', () => {
      const { countSql } = buildExplorerQuery({ ...baseFilters, q: 'wireless', rankMax: 50000 });
      expect(norm(countSql)).toContain('SELECT count(*)::int AS total FROM keyword_current_summary kcs');
      expect(norm(countSql)).toContain('current_rank <=');
      expect(norm(countSql)).toMatch(/search_term_normalized ~ \$\d/);
      expect(norm(countSql)).not.toContain('WITH matches');
      expect(norm(countSql)).not.toContain('LIMIT 10001');
      expect(norm(countSql)).not.toContain('ORDER BY');
    });

    it('main SELECT still joins search_terms even without q (needs search_term_raw)', () => {
      const { sql } = buildExplorerQuery({ ...baseFilters, rankMax: 50_000 });
      expect(norm(sql)).toContain('JOIN search_terms st ON st.id = kcs.search_term_id');
    });
  });

  describe('Movement jump — metric-aware', () => {
    it('rank preset emits the rank-column jump clause (unchanged behavior)', () => {
      const { sql, countArgs } = buildExplorerQuery({ ...baseFilters, jump: '500k_to_100k', jumpMetric: 'rank' });
      expect(norm(sql)).toContain('kcs.prior_week_rank >');
      expect(norm(sql)).toContain('kcs.current_rank <');
      expect(countArgs).toContain(500_000);
      expect(countArgs).toContain(100_000);
    });

    it('volume preset emits the volume-column jump clause', () => {
      const { sql, countArgs } = buildExplorerQuery({
        ...baseFilters, window: '13w', jump: 'v15k_to_30k', jumpMetric: 'volume',
      });
      expect(norm(sql)).toContain('kcs.estimated_monthly_volume_13w_ago <');
      expect(norm(sql)).toContain('kcs.estimated_monthly_volume_current >');
      expect(countArgs).toContain(15_000);
      expect(countArgs).toContain(30_000);
    });

    it('volume jump at 1w uses the 1w volume column', () => {
      const { sql } = buildExplorerQuery({
        ...baseFilters, window: '1w', jump: 'v5k_to_15k', jumpMetric: 'volume',
      });
      expect(norm(sql)).toContain('kcs.estimated_monthly_volume_1w_ago <');
    });

    it('volume custom uses jumpFrom/jumpTo', () => {
      const { sql, countArgs } = buildExplorerQuery({
        ...baseFilters, window: '4w', jump: 'custom', jumpMetric: 'volume', jumpFrom: 5000, jumpTo: 15000,
      });
      expect(norm(sql)).toContain('kcs.estimated_monthly_volume_4w_ago <');
      expect(norm(sql)).toContain('kcs.estimated_monthly_volume_current >');
      expect(countArgs).toContain(5000);
      expect(countArgs).toContain(15000);
    });
  });

  describe('Movement jump — newcomer inclusion (never-ranked counts as beyond any threshold)', () => {
    it('rank jump ORs the prior-rank NULL case into rows and count SQL', () => {
      const { sql, countSql } = buildExplorerQuery({ ...baseFilters, window: '26w', jump: '100k_to_50k', jumpMetric: 'rank' });
      expect(norm(sql)).toContain('(kcs.rank_26w_ago > $');
      expect(norm(sql)).toContain('OR kcs.rank_26w_ago IS NULL) AND kcs.current_rank < $');
      expect(norm(countSql)).toContain('OR kcs.rank_26w_ago IS NULL) AND kcs.current_rank < $');
    });

    it('volume jump ORs the never-ranked case via the rank column (vol NULL from a missing fit stays excluded)', () => {
      const { sql } = buildExplorerQuery({ ...baseFilters, window: '13w', jump: 'v15k_to_30k', jumpMetric: 'volume' });
      expect(norm(sql)).toContain('(kcs.estimated_monthly_volume_13w_ago < $');
      expect(norm(sql)).toContain('OR kcs.rank_13w_ago IS NULL) AND kcs.estimated_monthly_volume_current > $');
    });

    it('custom rank jump gets the same newcomer inclusion', () => {
      const { sql } = buildExplorerQuery({ ...baseFilters, window: '4w', jump: 'custom', jumpMetric: 'rank', jumpFrom: 200_000, jumpTo: 20_000 });
      expect(norm(sql)).toContain('OR kcs.rank_4w_ago IS NULL) AND kcs.current_rank < $');
    });
  });

  describe('combined filters', () => {
    it('handles all filters together', () => {
      const { sql, args, countSql, countArgs } = buildExplorerQuery({
        ...EXPLORER_DEFAULTS,
        window: '4w',
        q: 'phone case',
        rankMin: 1,
        rankMax: 100_000,
        jump: '500k_to_100k',
        jumpFrom: null,
        jumpTo: null,
        category: 'Electronics',
        severities: ['none', 'warning'],
        titleSlots: [1, 2, 3],
        titleMatchMode: 'any',
        matchMode: 'loose',
        sort: 'imp',
        page: 2,
        perPage: 50,
      });

      // Spot-check that every filter contributed a clause
      expect(norm(sql)).toMatch(/search_term_normalized ~ \$\d/);
      expect(norm(sql)).toContain('current_rank >=');
      expect(norm(sql)).toContain('current_rank <=');
      expect(norm(sql)).toContain('kcs.rank_4w_ago >');
      expect(norm(sql)).toContain('top_clicked_category_1_current =');
      expect(norm(sql)).toContain('IS NULL OR kcs.fake_volume_severity_current IN');
      expect(norm(sql)).toContain('NOT kcs.keyword_in_title_1_loose_current OR');
      expect(norm(sql)).toContain('ORDER BY (kcs.estimated_monthly_volume_current - CASE WHEN kcs.rank_4w_ago IS NULL THEN 0 ELSE kcs.estimated_monthly_volume_4w_ago END) DESC');
      expect(args.slice(-2)).toEqual([50, 50]);
      expect(args.length).toBe(countArgs.length + 2);
      // q set → single-table kcs path: window count, single-table fallback.
      expect(norm(sql)).toContain('kcs.search_term_normalized ~');
      expect(norm(sql)).toContain('(count(*) OVER ())::int AS total');
      expect(norm(countSql)).not.toContain('LIMIT 10001');
    });
  });

  describe('volume-delta imp/decline sorts', () => {
    const DELTA_4W = '(kcs.estimated_monthly_volume_current - CASE WHEN kcs.rank_4w_ago IS NULL THEN 0 ELSE kcs.estimated_monthly_volume_4w_ago END)';
    const ELIGIBLE_4W = '(kcs.estimated_monthly_volume_current IS NOT NULL AND (kcs.rank_4w_ago IS NULL OR kcs.estimated_monthly_volume_4w_ago IS NOT NULL))';

    it('legacy path: imp orders DESC by the delta expression and applies eligibility to rows AND count', () => {
      const { sql, countSql } = buildExplorerQuery({ ...baseFilters, sort: 'imp', window: '4w' }, '2026-07-05');
      expect(sql).toContain(`ORDER BY ${DELTA_4W} DESC`);
      expect(sql).toContain(ELIGIBLE_4W);
      expect(sql).toContain('AS volume_delta');
      expect(sql).toContain('AS volume_prior');
      expect(countSql).toContain(ELIGIBLE_4W);
    });

    it('legacy path: decline orders ASC', () => {
      const { sql } = buildExplorerQuery({ ...baseFilters, sort: 'decline', window: '4w' }, '2026-07-05');
      expect(sql).toContain(`ORDER BY ${DELTA_4W} ASC`);
    });

    it('1w window uses prior_week_rank as the discriminator', () => {
      const { sql } = buildExplorerQuery({ ...baseFilters, sort: 'imp', window: '1w' }, '2026-07-05');
      expect(sql).toContain('CASE WHEN kcs.prior_week_rank IS NULL THEN 0 ELSE kcs.estimated_monthly_volume_1w_ago END');
    });

    it('other sorts get NO eligibility predicate and still select the aliases', () => {
      const { sql, countSql } = buildExplorerQuery({ ...baseFilters, sort: 'rank', window: '4w' }, '2026-07-05');
      expect(sql).not.toContain('IS NOT NULL AND (kcs.rank_4w_ago IS NULL');
      expect(countSql).not.toContain('IS NOT NULL AND (kcs.rank_4w_ago IS NULL');
      expect(sql).toContain('AS volume_delta');
    });

    it('q path: inner orders by the expression, outer by k.volume_delta, count keeps eligibility', () => {
      const { sql, countSql } = buildExplorerQuery({ ...baseFilters, sort: 'imp', window: '4w', q: 'gummies' }, '2026-07-05');
      expect(sql).toContain(`ORDER BY ${DELTA_4W} DESC`);
      expect(sql).toContain('ORDER BY k.volume_delta DESC');
      expect(sql).toContain('k.volume_prior');
      expect(sql).toContain(ELIGIBLE_4W);
      expect(countSql).toContain(ELIGIBLE_4W);
    });

    it('eligibility predicate binds no args (countArgs prefix invariant holds)', () => {
      const plain = buildExplorerQuery({ ...baseFilters, sort: 'rank', window: '4w' }, '2026-07-05');
      const withSort = buildExplorerQuery({ ...baseFilters, sort: 'imp', window: '4w' }, '2026-07-05');
      expect(withSort.args.length).toBe(plain.args.length);
    });

    it('sortUsesVolumeDelta is true only for imp/decline', () => {
      expect(sortUsesVolumeDelta('imp')).toBe(true);
      expect(sortUsesVolumeDelta('decline')).toBe(true);
      expect(sortUsesVolumeDelta('rank')).toBe(false);
      expect(sortUsesVolumeDelta('added_desc')).toBe(false);
    });
  });

  describe('alias-stripped canonical strings (migration 0044 byte-match)', () => {
    const CASES: Array<[WindowKey, string, string]> = [
      ['1w', 'prior_week_rank', 'estimated_monthly_volume_1w_ago'],
      ['4w', 'rank_4w_ago', 'estimated_monthly_volume_4w_ago'],
      ['13w', 'rank_13w_ago', 'estimated_monthly_volume_13w_ago'],
      ['26w', 'rank_26w_ago', 'estimated_monthly_volume_26w_ago'],
      ['52w', 'rank_52w_ago', 'estimated_monthly_volume_52w_ago'],
    ];
    it.each(CASES)('window %s emits the canonical DDL strings', (w, rankCol, volCol) => {
      expect(volumeDeltaExpr(w, '')).toBe(
        `(estimated_monthly_volume_current - CASE WHEN ${rankCol} IS NULL THEN 0 ELSE ${volCol} END)`,
      );
      expect(volumeDeltaEligibility(w, '')).toBe(
        `estimated_monthly_volume_current IS NOT NULL AND (${rankCol} IS NULL OR ${volCol} IS NOT NULL)`,
      );
    });
  });
});

describe('word-count range filter', () => {
  const EXPR = "(length(kcs.search_term_normalized) - length(replace(kcs.search_term_normalized, ' ', '')) + 1)";

  it('pushes both bounds into rows and count SQL with the exact expression', () => {
    const { sql, countSql, args, countArgs } = buildExplorerQuery({ ...baseFilters, wordsMin: 3, wordsMax: 5 });
    expect(norm(sql)).toContain('kcs.word_count >= $');
    expect(norm(sql)).toContain('kcs.word_count <= $');
    expect(norm(countSql)).toContain('kcs.word_count >= $');
    expect(norm(countSql)).toContain('kcs.word_count <= $');
    expect(args).toContain(3);
    expect(args).toContain(5);
    expect(countArgs).toContain(3);
    expect(countArgs).toContain(5);
  });

  it('owner example: 1-1 emits both bounds (exactly one word)', () => {
    const { sql, countArgs } = buildExplorerQuery({ ...baseFilters, wordsMin: 1, wordsMax: 1 });
    expect(norm(sql)).toContain('kcs.word_count >= $');
    expect(norm(sql)).toContain('kcs.word_count <= $');
    expect(countArgs.filter((a) => a === 1)).toHaveLength(2);
  });

  it('owner example: min 5 alone emits only the lower bound', () => {
    const { sql } = buildExplorerQuery({ ...baseFilters, wordsMin: 5 });
    expect(norm(sql)).toContain('kcs.word_count >= $');
    expect(norm(sql)).not.toContain('kcs.word_count <= $');
  });

  it('emits no word-count predicates by default', () => {
    const { sql, countSql } = buildExplorerQuery(baseFilters);
    expect(norm(sql)).not.toContain('kcs.word_count');
    expect(norm(countSql)).not.toContain('kcs.word_count');
  });

  it('applies on the q path too', () => {
    const { sql } = buildExplorerQuery({ ...baseFilters, q: 'magnesium', wordsMin: 3 });
    expect(norm(sql)).toContain('kcs.word_count >= $');
  });

  it('composes with the volume-delta sorts', () => {
    const { sql } = buildExplorerQuery({ ...baseFilters, sort: 'imp', wordsMin: 3 });
    expect(norm(sql)).toContain('kcs.word_count >= $');
    expect(norm(sql)).toContain('estimated_monthly_volume_current IS NOT NULL');
  });

  it('wordCountExpr stays byte-stable (refresh INSERT + backfill depend on it)', () => {
    expect(wordCountExpr('kcs.')).toBe(EXPR);
    expect(wordCountExpr('')).toBe(EXPR.replaceAll('kcs.', ''));
  });
});

describe('categoryPathIsCovered', () => {
  const withLeaf = { ...baseFilters, leafPaths: ['Health & Household › X'] };
  it('covered: rank sorts with severity/rank/reviews/word filters', () => {
    expect(categoryPathIsCovered(withLeaf)).toBe(true);
    expect(categoryPathIsCovered({ ...withLeaf, sort: 'rank_desc', rankMax: 1000, reviewsMax: 500, wordsMin: 3 })).toBe(true);
  });
  it('not covered: q, jumps, title filter, non-rank sorts, no leafPaths', () => {
    expect(categoryPathIsCovered(baseFilters)).toBe(false);
    expect(categoryPathIsCovered({ ...withLeaf, q: 'abc' })).toBe(false);
    expect(categoryPathIsCovered({ ...withLeaf, jump: '100k_to_50k' })).toBe(false);
    expect(categoryPathIsCovered({ ...withLeaf, titleMatchMode: 'any' })).toBe(false);
    expect(categoryPathIsCovered({ ...withLeaf, sort: 'imp' })).toBe(false);
    expect(categoryPathIsCovered({ ...withLeaf, sort: 'avg_reviews_desc' })).toBe(false);
    expect(categoryPathIsCovered({ ...withLeaf, category: 'Health & Household' })).toBe(false);
  });
});

describe('covered category path (0046 covering index)', () => {
  const leaf = { ...baseFilters, leafPaths: ['Health & Household › X', 'Health & Household › Y'] };

  it('emits the two-stage shape: index-only inner, PK-join outer', () => {
    const { sql, countSql, args, countArgs } = buildExplorerQuery({ ...leaf, reviewsMax: 500, wordsMin: 3 }, '2026-08-15');
    const n = norm(sql);
    expect(n).toContain('FROM ( SELECT kcs.search_term_id, kcs.current_rank FROM keyword_current_summary kcs');
    expect(n).toContain('kcs.top_clicked_category_path IN ($2, $3)');
    expect(n).toContain('kcs.avg_reviews <= $');
    expect(n).toContain('kcs.word_count >= $');
    expect(n).toContain(') i JOIN keyword_current_summary kcs ON kcs.search_term_id = i.search_term_id');
    expect(n).toContain('JOIN search_terms st ON st.id = kcs.search_term_id');
    expect(n).toMatch(/ORDER BY kcs\.current_rank ASC[\s\S]*ORDER BY kcs\.current_rank ASC/); // inner + outer
    expect(norm(countSql)).toContain('SELECT 1 FROM keyword_current_summary kcs');
    expect(norm(countSql)).not.toContain('JOIN'); // count = inner where only
    expect(countArgs.length).toBeLessThan(args.length); // prefix invariant
  });

  it('inner selects ONLY covered columns (index-only requirement)', () => {
    const { sql } = buildExplorerQuery(leaf, '2026-08-15');
    const n = norm(sql);
    // Isolate the derived-table subquery itself — between "FROM (" and the
    // closing ") i JOIN" — not the outer display SELECT, which legitimately
    // carries the full column set for the ~perPage rows joined back by PK.
    // (The outer SELECT necessarily precedes "FROM (" in any valid SQL, so
    // splitting on ") i JOIN" and taking everything before it, as the outer
    // shape-check above does, would include the outer column list too.)
    const inner = n.slice(n.indexOf('FROM (') + 'FROM ('.length, n.indexOf(') i JOIN'));
    for (const col of ['top_clicked_product_1_title_current', 'estimated_monthly_volume_current', 'improvement_1w']) {
      expect(inner).not.toContain(col);
    }
  });

  it('rank_desc flips both ORDER BYs', () => {
    const { sql } = buildExplorerQuery({ ...leaf, sort: 'rank_desc' }, '2026-08-15');
    expect(norm(sql)).toMatch(/ORDER BY kcs\.current_rank DESC[\s\S]*ORDER BY kcs\.current_rank DESC/);
  });

  it('non-covered combos fall back to the classic shapes unchanged', () => {
    for (const f of [
      { ...leaf, sort: 'imp' as const },
      { ...leaf, q: 'magnesium' },
      { ...leaf, jump: '100k_to_50k' as const },
      { ...baseFilters },
    ]) {
      const { sql } = buildExplorerQuery(f, '2026-08-15');
      expect(norm(sql)).not.toContain(') i JOIN keyword_current_summary');
    }
  });

  it('N+1 limit + offset ride the inner query', () => {
    const { sql, args } = buildExplorerQuery({ ...leaf, page: 3, perPage: 100 }, '2026-08-15');
    const inner = norm(sql).split(') i JOIN')[0];
    expect(inner).toMatch(/LIMIT \$\d+ OFFSET \$\d+/);
    expect(args).toContain(101); // perPage + 1
    expect(args).toContain(200); // (page-1)*perPage
  });
});
