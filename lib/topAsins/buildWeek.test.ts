// lib/topAsins/buildWeek.test.ts
import { describe, it, expect } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { keywordTopAsins, keywordWeeklyMetrics } from '@/db/schema';
import { buildTopAsinsStatements, buildTopAsinsWeek, TopAsinsBuildError, type Queryable } from './buildWeek';

const dbCols = (t: Parameters<typeof getTableColumns>[0]) => new Set(Object.values(getTableColumns(t)).map((c) => c.name));

describe('buildTopAsinsStatements', () => {
  const s = buildTopAsinsStatements('2026-10-03');
  it('reads the week from its year partition, three slots, well-formed ASINs only', () => {
    expect(s.insert.text).toContain('FROM keyword_weekly_metrics_2026');
    expect(s.insert.text.match(/top_clicked_product_[123]_asin ~ '\^\[A-Z0-9\]\{10\}\$'/g)).toHaveLength(3);
    expect(s.insert.values).toEqual(['2026-10-03']);
  });
  it('carries the streak from the previous build: prev + 1, else 1 with this week as the start', () => {
    expect(s.insert.text).toContain('COALESCE(prev.weeks_in_top3, 0) + 1');
    expect(s.insert.text).toContain('COALESCE(prev.streak_started_week, $1::date)');
    expect(s.insert.text).toContain('LEFT JOIN LATERAL');
  });
  it('builds into _next and swaps by rename inside the transaction', () => {
    expect(s.createNext.text).toContain('CREATE TABLE keyword_top_asins_next (LIKE keyword_top_asins INCLUDING ALL)');
    expect(s.swap.map((x) => x.text).join('\n')).toContain('ALTER TABLE keyword_top_asins_next RENAME TO keyword_top_asins');
    expect(s.swap.map((x) => x.text).join('\n')).toContain('DROP TABLE keyword_top_asins');
    // LIKE ... INCLUDING ALL gives the copied index and primary key generated names; the swap restores the canonical ones.
    expect(s.swap.map((x) => x.text).join('\n')).toContain('ALTER INDEX keyword_top_asins_next_asin_search_term_id_idx RENAME TO keyword_top_asins_asin_idx');
    expect(s.swap.map((x) => x.text).join('\n')).toContain('RENAME CONSTRAINT keyword_top_asins_next_pkey TO keyword_top_asins_pkey');
  });
  it('names only real columns', () => {
    const kwmCols = new Set([...s.insert.text.matchAll(/\b(top_clicked_product_[123]_(?:asin|click_share|conversion_share)|search_term_id|week_end_date)\b/g)].map((m) => m[1]));
    expect([...kwmCols].filter((c) => !dbCols(keywordWeeklyMetrics).has(c))).toEqual([]);
    const insertCols = s.insert.text.slice(s.insert.text.indexOf('(') + 1, s.insert.text.indexOf(')')).split(',').map((c) => c.trim());
    expect(insertCols.filter((c) => !dbCols(keywordTopAsins).has(c))).toEqual([]);
  });
  it('rejects a malformed week', () => {
    expect(() => buildTopAsinsStatements('2026/10/03')).toThrow(TopAsinsBuildError);
  });
});

describe('buildTopAsinsWeek', () => {
  function fakeClient(answers: Record<string, { rowCount: number | null; rows: unknown[] }>): Queryable & { calls: string[]; args: unknown[][] } {
    const calls: string[] = [];
    const args: unknown[][] = [];
    return {
      calls,
      args,
      async query(text: string, values?: unknown[]) {
        calls.push(text.trim().split(/\s+/).slice(0, 3).join(' '));
        args.push(values ?? []);
        const key = Object.keys(answers).find((k) => text.includes(k));
        return key ? answers[key] : { rowCount: 0, rows: [] };
      },
    };
  }
  it('refuses a week older than the meta week unless forced', async () => {
    const c = fakeClient({ 'FROM keyword_top_asins_meta': { rowCount: 1, rows: [{ week_end_date: '2026-10-03' }] } });
    await expect(buildTopAsinsWeek(c, '2026-09-26')).rejects.toMatchObject({ code: 'top_asins_older_than_meta' });
    expect(c.calls.some((x) => x.startsWith('CREATE TABLE'))).toBe(false);
  });
  it('builds a week older than the meta week when forced', async () => {
    const c = fakeClient({ 'FROM keyword_top_asins_meta': { rowCount: 1, rows: [{ week_end_date: '2026-10-03' }] }, 'INSERT INTO keyword_top_asins_next': { rowCount: 5, rows: [] } });
    await expect(buildTopAsinsWeek(c, '2026-09-26', { force: true })).resolves.toEqual({ rows: 5, previousWeek: '2026-10-03' });
  });
  it('refuses to swap when the insert wrote zero rows, rolling back', async () => {
    const c = fakeClient({ 'FROM keyword_top_asins_meta': { rowCount: 1, rows: [{ week_end_date: null }] }, 'INSERT INTO keyword_top_asins_next': { rowCount: 0, rows: [] } });
    await expect(buildTopAsinsWeek(c, '2026-10-03')).rejects.toMatchObject({ code: 'top_asins_no_rows' });
    expect(c.calls).toContain('ROLLBACK');
    expect(c.calls.some((x) => x.startsWith('ALTER TABLE'))).toBe(false);
    // The live table is never touched and nothing commits.
    expect(c.calls.some((x) => x.startsWith('DROP TABLE'))).toBe(false);
    expect(c.calls).not.toContain('COMMIT');
  });
  it('builds, swaps, records meta and analyzes; returns the counts', async () => {
    const c = fakeClient({ 'FROM keyword_top_asins_meta': { rowCount: 1, rows: [{ week_end_date: '2026-09-26' }] }, 'INSERT INTO keyword_top_asins_next': { rowCount: 7, rows: [] } });
    const r = await buildTopAsinsWeek(c, '2026-10-03');
    expect(r).toEqual({ rows: 7, previousWeek: '2026-09-26' });
    // The guard reads the meta row first, outside the transaction; every write sits between BEGIN and COMMIT;
    // ANALYZE runs after the COMMIT. (Each entry is the statement's first three words.)
    expect(c.calls).toEqual([
      'SELECT week_end_date::text AS',
      'BEGIN',
      'SET LOCAL statement_timeout',
      'CREATE TABLE keyword_top_asins_next',
      'INSERT INTO keyword_top_asins_next',
      'DROP TABLE keyword_top_asins',
      'ALTER TABLE keyword_top_asins_next',
      'ALTER INDEX keyword_top_asins_next_asin_search_term_id_idx',
      'ALTER TABLE keyword_top_asins',
      'INSERT INTO keyword_top_asins_meta',
      'COMMIT',
      'ANALYZE keyword_top_asins',
    ]);
    // The meta row records the week and the inserted row count, not the statement's placeholder count.
    expect(c.args[c.calls.indexOf('INSERT INTO keyword_top_asins_meta')]).toEqual(['2026-10-03', 7]);
  });
});
