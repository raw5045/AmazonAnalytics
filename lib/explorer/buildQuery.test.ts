import { describe, it, expect } from 'vitest';
import { buildExplorerQuery } from './buildQuery';
import { EXPLORER_DEFAULTS } from './parseFilters';
import type { ExplorerFilters } from './types';

const baseFilters: ExplorerFilters = { ...EXPLORER_DEFAULTS };

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

describe('buildExplorerQuery', () => {
  describe('with default filters (no URL params)', () => {
    it('returns the top-100 keywords sorted by current_rank ASC', () => {
      const { sql, args, countSql, countArgs } = buildExplorerQuery(baseFilters);

      // Default severities are ['none', 'warning'] → those are the only WHERE args
      expect(countArgs).toEqual(['none', 'warning']);
      // Main SQL adds LIMIT (100) and OFFSET (0) at the end
      expect(args).toEqual(['none', 'warning', 100, 0]);

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

  describe('search term substring (q)', () => {
    it('adds a LIKE clause when q is set', () => {
      const { sql, countArgs } = buildExplorerQuery({ ...baseFilters, q: 'wireless' });
      expect(norm(sql)).toContain('st.search_term_normalized LIKE $1');
      expect(countArgs).toContain('%wireless%');
    });

    it('lowercases the search pattern', () => {
      const { countArgs } = buildExplorerQuery({ ...baseFilters, q: 'WiReLeSS' });
      expect(countArgs).toContain('%wireless%');
    });

    it('skips the LIKE clause when q is null', () => {
      const { sql } = buildExplorerQuery({ ...baseFilters, q: null });
      expect(norm(sql)).not.toContain('search_term_normalized LIKE');
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
    it('"any" mode with all 3 slots → at least one is false', () => {
      const { sql } = buildExplorerQuery({
        ...baseFilters,
        titleMatchMode: 'any',
        titleSlots: [1, 2, 3],
      });
      expect(norm(sql)).toContain('NOT kcs.keyword_in_title_1_current OR NOT kcs.keyword_in_title_2_current OR NOT kcs.keyword_in_title_3_current');
    });

    it('"all" mode with all 3 slots → every slot is false', () => {
      const { sql } = buildExplorerQuery({
        ...baseFilters,
        titleMatchMode: 'all',
        titleSlots: [1, 2, 3],
      });
      expect(norm(sql)).toContain('NOT kcs.keyword_in_title_1_current AND NOT kcs.keyword_in_title_2_current AND NOT kcs.keyword_in_title_3_current');
    });

    it('"any" mode with only slot 1 selected', () => {
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
      expect(whereOnly).toContain('NOT kcs.keyword_in_title_1_current');
      expect(whereOnly).not.toContain('keyword_in_title_2_current');
      expect(whereOnly).not.toContain('keyword_in_title_3_current');
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

    it('imp → improvement DESC NULLS LAST (window-relative)', () => {
      const { sql } = buildExplorerQuery({ ...baseFilters, window: '4w', sort: 'imp' });
      expect(norm(sql)).toContain('ORDER BY kcs.improvement_4w DESC NULLS LAST');
    });

    it('decline → improvement ASC NULLS LAST (window-relative)', () => {
      const { sql } = buildExplorerQuery({ ...baseFilters, window: '13w', sort: 'decline' });
      expect(norm(sql)).toContain('ORDER BY kcs.improvement_13w ASC NULLS LAST');
    });

    it('title_gap → keyword_title_match_count_current ASC', () => {
      const { sql } = buildExplorerQuery({ ...baseFilters, sort: 'title_gap' });
      expect(norm(sql)).toContain('ORDER BY kcs.keyword_title_match_count_current ASC');
    });
  });

  describe('pagination', () => {
    it('page 1 with default per_page → LIMIT 100 OFFSET 0', () => {
      const { args } = buildExplorerQuery(baseFilters);
      expect(args.slice(-2)).toEqual([100, 0]);
    });

    it('page 3 per_page 100 → OFFSET 200', () => {
      const { args } = buildExplorerQuery({ ...baseFilters, page: 3 });
      expect(args.slice(-2)).toEqual([100, 200]);
    });

    it('custom per_page', () => {
      const { args } = buildExplorerQuery({ ...baseFilters, page: 1, perPage: 50 });
      expect(args.slice(-2)).toEqual([50, 0]);
    });
  });

  describe('countSql vs sql', () => {
    it('countSql uses identical WHERE + the bail-out LIMIT, no ORDER BY / OFFSET', () => {
      const { countSql } = buildExplorerQuery({
        ...baseFilters,
        q: 'wireless',
        rankMin: 1,
        rankMax: 50000,
      });
      expect(norm(countSql)).toContain('search_term_normalized LIKE');
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
        page: 2,
      };
      const { args, countArgs } = buildExplorerQuery(filters);
      expect(args.slice(0, countArgs.length)).toEqual(countArgs);
      expect(args.length).toBe(countArgs.length + 2);
    });
  });

  describe('combined filters', () => {
    it('handles all filters together', () => {
      const { sql, args, countSql, countArgs } = buildExplorerQuery({
        window: '4w',
        q: 'phone case',
        rankMin: 1,
        rankMax: 100_000,
        jump: '500k_to_100k',
        category: 'Electronics',
        severities: ['none', 'warning'],
        titleSlots: [1, 2, 3],
        titleMatchMode: 'any',
        sort: 'imp',
        page: 2,
        perPage: 50,
      });

      // Spot-check that every filter contributed a clause
      expect(norm(sql)).toContain('search_term_normalized LIKE');
      expect(norm(sql)).toContain('current_rank >=');
      expect(norm(sql)).toContain('current_rank <=');
      expect(norm(sql)).toContain('kcs.rank_4w_ago >');
      expect(norm(sql)).toContain('top_clicked_category_1_current =');
      expect(norm(sql)).toContain('IS NULL OR kcs.fake_volume_severity_current IN');
      expect(norm(sql)).toContain('NOT kcs.keyword_in_title_1_current OR');
      expect(norm(sql)).toContain('ORDER BY kcs.improvement_4w DESC NULLS LAST');
      expect(args.slice(-2)).toEqual([50, 50]);
      expect(args.length).toBe(countArgs.length + 2);
      // countSql LIMITs the bail-out subquery; that's the only LIMIT it has.
      expect(norm(countSql)).toContain('LIMIT 10001');
    });
  });
});
