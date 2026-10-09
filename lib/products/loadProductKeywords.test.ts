// lib/products/loadProductKeywords.test.ts
import { describe, it, expect } from 'vitest';
import { keywordTopAsins, keywordCurrentSummary, searchTerms } from '@/db/schema';
import { loadProductKeywords, productKeywordsSql, productKeywordCountSql, PRODUCT_KEYWORDS_CAP, type ProductKeywordRow } from './loadProductKeywords';
import { aliasCols, dbCols, notIn, recordingRow, recordingRunner, selectNames } from './testHelpers';

/** The capped-count statement (the rows statement never starts with count). */
const isCount = (text: string) => text.startsWith('SELECT count(*)');
const fakeRun = (rows: unknown[], total: number) => recordingRunner((text) => (isCount(text) ? [{ n: total }] : rows));

const ID_1 = '0b0f7a52-0c51-4f6e-9a55-1d2f2d9d3c11';
const ID_2 = '7c1d2e9a-55a0-4a9e-8f37-3b6a6a1b0d22';
const RAW = {
  search_term_raw: 'desk lamp', search_term_id: ID_1, current_rank: 4521, estimated_monthly_volume_current: '48790',
  slot: 1, click_share: '32.50', conversion_share: '12.34', weeks_in_top3: 11, streak_started_week: '2026-07-25',
};
const ROW: ProductKeywordRow = {
  searchTermId: ID_1, searchTermRaw: 'desk lamp', currentRank: 4521, estimatedMonthlySearches: 48790,
  slot: 1, clickSharePct: 32.5, conversionSharePct: 12.34, weeksInTop3: 11, streakStartedWeek: '2026-07-25',
};

describe('productKeywordsSql', () => {
  const q = productKeywordsSql('B000000001', 500);
  it('joins the reverse table to the current summary and the term, best rank first, capped by a bound limit', () => {
    expect(q.values).toEqual(['B000000001', 500]);
    expect(q.text).toContain('FROM keyword_top_asins k');
    expect(q.text).toContain('JOIN keyword_current_summary kcs ON kcs.search_term_id = k.search_term_id');
    expect(q.text).toContain('JOIN search_terms st ON st.id = kcs.search_term_id');
    expect(q.text).toContain('WHERE k.asin = $1');
    expect(q.text).toContain('LIMIT $2');
    expect(productKeywordsSql('B000000001', 100).values).toEqual(['B000000001', 100]);
  });
  it('orders by rank with the keyword id as the tie-break, so the 500 kept are the same on every read', () => {
    expect(q.text).toContain('ORDER BY kcs.current_rank ASC, k.search_term_id');
    expect(q.text).not.toContain('NULLS LAST'); // current_rank is NOT NULL (migration 0008)
  });
  it('selects the columns the keywords table shows; the bigint, numerics and the date come back as text', () => {
    expect([...selectNames(q.text)]).toEqual([
      'search_term_raw', 'search_term_id', 'current_rank', 'estimated_monthly_volume_current',
      'slot', 'click_share', 'conversion_share', 'weeks_in_top3', 'streak_started_week',
    ]);
    expect(q.text).toContain('kcs.estimated_monthly_volume_current::text AS estimated_monthly_volume_current');
    expect(q.text).toContain('k.click_share::text AS click_share');
    expect(q.text).toContain('k.conversion_share::text AS conversion_share');
    expect(q.text).toContain('k.streak_started_week::text AS streak_started_week');
  });
  it('names only real columns', () => {
    for (const [alias, table] of [['k', keywordTopAsins], ['kcs', keywordCurrentSummary], ['st', searchTerms]] as const) {
      expect(aliasCols(q.text, alias).size).toBeGreaterThan(1);
      expect(notIn(aliasCols(q.text, alias), dbCols(table))).toEqual([]);
    }
  });
});

describe('productKeywordCountSql', () => {
  const q = productKeywordCountSql('B000000001');
  it('counts what the list can show: the same ASIN match and the same join to the current summary', () => {
    expect(q.values).toEqual(['B000000001']);
    expect(q.text).toMatch(/^SELECT count\(\*\)::int AS n\s/);
    expect(q.text).toContain('FROM keyword_top_asins k');
    expect(q.text).toContain('JOIN keyword_current_summary kcs ON kcs.search_term_id = k.search_term_id');
    expect(q.text).toContain('WHERE k.asin = $1');
  });
  it('names only real columns', () => {
    expect(notIn(aliasCols(q.text, 'k'), dbCols(keywordTopAsins))).toEqual([]);
    expect(notIn(aliasCols(q.text, 'kcs'), dbCols(keywordCurrentSummary))).toEqual([]);
  });
});

describe('loadProductKeywords', () => {
  it('maps the rows (numbers from the text columns) and takes the total from the count statement', async () => {
    const second = {
      ...RAW, search_term_raw: 'led lamp', search_term_id: ID_2, current_rank: 90210, estimated_monthly_volume_current: null,
      slot: 3, click_share: null, conversion_share: '0.00', weeks_in_top3: 1, streak_started_week: '2026-10-03',
    };
    const { run } = fakeRun([RAW, second], 731);
    const r = await loadProductKeywords(run, 'B000000001');
    expect(r.total).toBe(731);
    expect(r.rows).toEqual([
      ROW,
      {
        searchTermId: ID_2, searchTermRaw: 'led lamp', currentRank: 90210, estimatedMonthlySearches: null,
        slot: 3, clickSharePct: null, conversionSharePct: 0, weeksInTop3: 1, streakStartedWeek: '2026-10-03',
      },
    ]);
  });

  it('caps the list at 500 rows and counts all of them', async () => {
    const { run, calls } = fakeRun([RAW], 1);
    await loadProductKeywords(run, 'B000000001');
    expect(PRODUCT_KEYWORDS_CAP).toBe(500);
    expect(calls).toHaveLength(2);
    expect(calls.find((c) => !isCount(c.text))).toEqual(productKeywordsSql('B000000001', 500));
    expect(calls.find((c) => isCount(c.text))).toEqual(productKeywordCountSql('B000000001'));
  });

  it('takes a smaller cap (the research tool lists 100)', async () => {
    const { run, calls } = fakeRun([], 0);
    await loadProductKeywords(run, 'B000000001', 100);
    expect(calls.find((c) => !isCount(c.text))?.values).toEqual(['B000000001', 100]);
  });

  it('reads the volume whether the driver hands over text or a number', async () => {
    const { run } = fakeRun([{ ...RAW, estimated_monthly_volume_current: '4879000' }, { ...RAW, estimated_monthly_volume_current: 4879000 }], 2);
    const r = await loadProductKeywords(run, 'B000000001');
    expect(r.rows.map((x) => x.estimatedMonthlySearches)).toEqual([4879000, 4879000]);
  });

  it('treats a non-numeric volume or share as missing', async () => {
    const { run } = fakeRun([{ ...RAW, estimated_monthly_volume_current: 'NaN', click_share: 'NaN', conversion_share: 'NaN' }], 1);
    const [row] = (await loadProductKeywords(run, 'B000000001')).rows;
    expect(row).toMatchObject({ estimatedMonthlySearches: null, clickSharePct: null, conversionSharePct: null });
  });

  it('returns no rows and a zero total for an ASIN that is in no keyword\'s top 3', async () => {
    const { run } = fakeRun([], 0);
    await expect(loadProductKeywords(run, 'B000000001')).resolves.toEqual({ rows: [], total: 0 });
  });

  it('reads exactly the columns the keywords statement selects', async () => {
    const { row, read } = recordingRow(RAW);
    await loadProductKeywords(async (text) => (isCount(text) ? [{ n: 1 }] : [row]), 'B000000001');
    const selected = selectNames(productKeywordsSql('B000000001', 500).text);
    expect(notIn(read, selected)).toEqual([]); // read but never selected: it would silently map to null
    expect(notIn(selected, read)).toEqual([]); // selected but never read: wasted
  });
});
