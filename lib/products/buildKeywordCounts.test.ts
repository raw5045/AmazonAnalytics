// lib/products/buildKeywordCounts.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asinProducts, keywordTopAsins } from '@/db/schema';
import { ENQUEUE_LOCK_KEY } from '@/lib/keepa/lanes';
import { aliasCols, dbCols, notIn } from '@/lib/products/testHelpers';
import { SET_COUNTS_SQL, ZERO_DROPPED_SQL, buildKeywordCounts, type KeywordCountsClient } from './buildKeywordCounts';

type Answer = { rowCount?: number | null; throws?: Error };

/** Answers by statement head (the first match wins, so an override goes before ANSWERS) and records every call in order. */
function fakeClient(answers: Array<[head: string, answer: Answer]> = []) {
  const calls: Array<{ text: string; values?: unknown[] }> = [];
  async function query(text: string, values?: unknown[]) {
    calls.push({ text, values });
    const a = answers.find(([head]) => text.startsWith(head))?.[1];
    if (a?.throws) throw a.throws;
    return { rowCount: a && a.rowCount !== undefined ? a.rowCount : 0, rows: [] };
  }
  // The fake answers only the (text, values) form the builder calls; pg's overloaded query type is cast away, as in
  // tests/integration/keepaWatcher.test.ts.
  const client: KeywordCountsClient = { query: query as unknown as KeywordCountsClient['query'] };
  return { client, calls, texts: () => calls.map((c) => c.text) };
}
const ANSWERS: Array<[string, Answer]> = [
  [SET_COUNTS_SQL, { rowCount: 1234 }],
  [ZERO_DROPPED_SQL, { rowCount: 56 }],
];
const LOCK = 'SELECT pg_advisory_xact_lock($1)';
const OPENING = ['BEGIN', "SET LOCAL statement_timeout = '600s'", LOCK];

describe('the statements (spec 2026-10-23 §5)', () => {
  it("sets the count of every product in the pair table whose stored count differs; no week filter (the table holds the current week only)", () => {
    expect(SET_COUNTS_SQL.replace(/\s+/g, ' ')).toBe(
      'UPDATE asin_products a SET keyword_count = c.n FROM (SELECT asin, count(*)::int AS n FROM keyword_top_asins GROUP BY asin) c WHERE a.asin = c.asin AND a.keyword_count IS DISTINCT FROM c.n',
    );
    expect(SET_COUNTS_SQL).toContain('IS DISTINCT FROM'); // only the changed rows are written
    expect(SET_COUNTS_SQL).not.toContain('week_end_date');
  });

  it('zeroes only the products that dropped out of the pair table', () => {
    expect(ZERO_DROPPED_SQL.replace(/\s+/g, ' ')).toBe(
      'UPDATE asin_products a SET keyword_count = 0 WHERE a.keyword_count <> 0 AND NOT EXISTS (SELECT 1 FROM keyword_top_asins k WHERE k.asin = a.asin)',
    );
    expect(ZERO_DROPPED_SQL).toContain('NOT EXISTS');
    expect(ZERO_DROPPED_SQL).toContain('a.keyword_count <> 0'); // a product already at zero is not rewritten
  });

  it('names only real columns of the two tables', () => {
    const both = `${SET_COUNTS_SQL}\n${ZERO_DROPPED_SQL}`;
    expect([...aliasCols(both, 'a')].sort()).toEqual(['asin', 'keyword_count']);
    expect(notIn(aliasCols(both, 'a'), dbCols(asinProducts))).toEqual([]);
    expect([...aliasCols(ZERO_DROPPED_SQL, 'k')]).toEqual(['asin']);
    expect(notIn(aliasCols(ZERO_DROPPED_SQL, 'k'), dbCols(keywordTopAsins))).toEqual([]);
    // The bare names: the SET target on asin_products, the grouped column of keyword_top_asins.
    expect(dbCols(asinProducts).has('keyword_count')).toBe(true);
    expect(dbCols(keywordTopAsins).has('asin')).toBe(true);
  });
});

describe('buildKeywordCounts', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs one transaction: BEGIN, the 600 s limit, the Keepa service's lock, the two UPDATEs in order, COMMIT; returns their row counts and the seconds", async () => {
    vi.spyOn(Date, 'now').mockReturnValueOnce(1_000_000).mockReturnValue(1_061_500);
    const { client, calls, texts } = fakeClient(ANSWERS);
    await expect(buildKeywordCounts(client)).resolves.toEqual({ updated: 1234, zeroed: 56, seconds: 61.5 });
    expect(texts()).toEqual([...OPENING, SET_COUNTS_SQL, ZERO_DROPPED_SQL, 'COMMIT']);
    // The exclusive form, before any row lock: the service's batch writes take the shared form first and wait.
    expect(calls[2].values).toEqual([ENQUEUE_LOCK_KEY]);
    expect(calls.filter((c) => c.values !== undefined)).toHaveLength(1); // nothing else takes parameters
  });

  it('a null rowCount reads as zero', async () => {
    const { client } = fakeClient([
      [SET_COUNTS_SQL, { rowCount: null }],
      [ZERO_DROPPED_SQL, { rowCount: null }],
    ]);
    await expect(buildKeywordCounts(client)).resolves.toMatchObject({ updated: 0, zeroed: 0 });
  });

  it('a failing first UPDATE rolls back and rethrows the original error unchanged; the second never runs', async () => {
    const failure = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
    const { client, texts } = fakeClient([[SET_COUNTS_SQL, { throws: failure }], ...ANSWERS]);
    await expect(buildKeywordCounts(client)).rejects.toBe(failure);
    expect(texts()).toEqual([...OPENING, SET_COUNTS_SQL, 'ROLLBACK']);
  });

  it('a failing second UPDATE rolls the first one back with it', async () => {
    const failure = Object.assign(new Error('connection lost'), { code: '08006' });
    const { client, texts } = fakeClient([[ZERO_DROPPED_SQL, { throws: failure }], ...ANSWERS]);
    await expect(buildKeywordCounts(client)).rejects.toBe(failure);
    expect(texts()).toEqual([...OPENING, SET_COUNTS_SQL, ZERO_DROPPED_SQL, 'ROLLBACK']);
  });

  it('a lock wait past the statement limit rolls back before any row is written', async () => {
    const failure = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
    const { client, texts } = fakeClient([[LOCK, { throws: failure }], ...ANSWERS]);
    await expect(buildKeywordCounts(client)).rejects.toBe(failure);
    expect(texts()).toEqual([...OPENING, 'ROLLBACK']);
  });

  it('a failing COMMIT rolls back and rethrows', async () => {
    const failure = Object.assign(new Error('commit failed'), { code: '08006' });
    const { client, texts } = fakeClient([['COMMIT', { throws: failure }], ...ANSWERS]);
    await expect(buildKeywordCounts(client)).rejects.toBe(failure);
    expect(texts().slice(-2)).toEqual(['COMMIT', 'ROLLBACK']);
  });

  it('a failing ROLLBACK does not mask the original error', async () => {
    const failure = new Error('update failed');
    const { client } = fakeClient([
      [SET_COUNTS_SQL, { throws: failure }],
      ['ROLLBACK', { throws: new Error('rollback failed') }],
      ...ANSWERS,
    ]);
    await expect(buildKeywordCounts(client)).rejects.toBe(failure);
  });

  it('a failing BEGIN is rethrown with no ROLLBACK: no transaction was opened', async () => {
    const failure = Object.assign(new Error('connection lost'), { code: '08006' });
    const { client, texts } = fakeClient([['BEGIN', { throws: failure }], ...ANSWERS]);
    await expect(buildKeywordCounts(client)).rejects.toBe(failure);
    expect(texts()).toEqual(['BEGIN']);
  });
});
