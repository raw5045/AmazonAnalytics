// lib/products/buildKeywordCounts.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asinProducts, keywordTopAsins } from '@/db/schema';
import { ENQUEUE_LOCK_KEY } from '@/lib/keepa/lanes';
import { aliasCols, dbCols, notIn } from '@/lib/products/testHelpers';
import {
  HAS_PAIRS_SQL,
  KeywordCountsBuildError,
  SET_COUNTS_SQL,
  ZERO_DROPPED_SQL,
  buildKeywordCounts,
  type KeywordCountsClient,
} from './buildKeywordCounts';

type Answer = { rowCount?: number | null; rows?: unknown[]; throws?: Error };

/** Answers by statement head (the first match wins, so an override goes before ANSWERS) and records every call in order. */
function fakeClient(answers: Array<[head: string, answer: Answer]> = []) {
  const calls: Array<{ text: string; values?: unknown[] }> = [];
  async function query(text: string, values?: unknown[]) {
    calls.push({ text, values });
    const a = answers.find(([head]) => text.startsWith(head))?.[1];
    if (a?.throws) throw a.throws;
    return { rowCount: a && a.rowCount !== undefined ? a.rowCount : 0, rows: a?.rows ?? [] };
  }
  // The fake answers only the (text, values) form the builder calls; pg's overloaded query type is cast away, as in
  // tests/integration/keepaWatcher.test.ts.
  const client: KeywordCountsClient = { query: query as unknown as KeywordCountsClient['query'] };
  return { client, calls, texts: () => calls.map((c) => c.text) };
}
const ANSWERS: Array<[string, Answer]> = [
  [HAS_PAIRS_SQL, { rows: [{ any: true }] }],
  [SET_COUNTS_SQL, { rowCount: 1234 }],
  [ZERO_DROPPED_SQL, { rowCount: 56 }],
];
const LOCK = 'SELECT pg_advisory_xact_lock($1)';
const VACUUM = 'VACUUM (ANALYZE) asin_products';
const OPENING = ['BEGIN', "SET LOCAL statement_timeout = '600s'", "SET LOCAL work_mem = '256MB'", LOCK];
const WRITE = [...OPENING, HAS_PAIRS_SQL, SET_COUNTS_SQL, ZERO_DROPPED_SQL, 'COMMIT'];

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

  it('checks that the pair table holds any row at all', () => {
    expect(HAS_PAIRS_SQL).toBe('SELECT EXISTS (SELECT 1 FROM keyword_top_asins) AS any');
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

  it("runs one transaction: BEGIN, the 600 s default limit, work_mem, the Keepa service's lock, the empty-table check, the two UPDATEs in order, COMMIT; then the VACUUM (ANALYZE) outside it; returns the row counts, the seconds and vacuumed", async () => {
    vi.spyOn(Date, 'now').mockReturnValueOnce(1_000_000).mockReturnValue(1_061_500);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { client, calls, texts } = fakeClient(ANSWERS);
    await expect(buildKeywordCounts(client)).resolves.toEqual({ updated: 1234, zeroed: 56, seconds: 61.5, vacuumed: true });
    expect(texts()).toEqual([...WRITE, VACUUM]);
    // The exclusive form, before any row lock: the service's batch writes take the shared form first and wait.
    expect(calls[3].values).toEqual([ENQUEUE_LOCK_KEY]);
    expect(calls.filter((c) => c.values !== undefined)).toHaveLength(1); // nothing else takes parameters
    expect(warn).not.toHaveBeenCalled();
  });

  it('a longer statement limit, when passed, is the one the transaction sets', async () => {
    const { client, texts } = fakeClient(ANSWERS);
    await expect(buildKeywordCounts(client, { statementTimeoutSeconds: 1800 })).resolves.toMatchObject({ vacuumed: true });
    expect(texts()).toEqual([
      'BEGIN',
      "SET LOCAL statement_timeout = '1800s'",
      "SET LOCAL work_mem = '256MB'",
      LOCK,
      HAS_PAIRS_SQL,
      SET_COUNTS_SQL,
      ZERO_DROPPED_SQL,
      'COMMIT',
      VACUUM,
    ]);
  });

  it.each([0, -600, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses a statement limit of %s with a plain Error before BEGIN',
    async (bad) => {
      const { client, calls } = fakeClient(ANSWERS);
      const err = await buildKeywordCounts(client, { statementTimeoutSeconds: bad }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(Object.getPrototypeOf(err)).toBe(Error.prototype); // a plain Error, not a coded one
      expect((err as Error).message).toBe('buildKeywordCounts: statementTimeoutSeconds must be a positive integer');
      expect(calls).toEqual([]); // no BEGIN, nothing issued
    },
  );

  it.each([
    ['answers false', [{ any: false }]],
    ['answers no row', []],
  ])('an empty pair table (the check %s) rolls back before any UPDATE with keyword_counts_no_rows', async (_how, rows) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { client, texts } = fakeClient([[HAS_PAIRS_SQL, { rows }], ...ANSWERS]);
    const err = await buildKeywordCounts(client).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KeywordCountsBuildError);
    expect(err).toMatchObject({
      name: 'KeywordCountsBuildError',
      code: 'keyword_counts_no_rows',
      message: 'keyword_top_asins is empty; refusing to zero every count',
    });
    expect(texts()).toEqual([...OPENING, HAS_PAIRS_SQL, 'ROLLBACK']); // no UPDATE, no COMMIT, no VACUUM
    expect(warn).not.toHaveBeenCalled();
  });

  it('a null rowCount reads as zero', async () => {
    const { client } = fakeClient([
      [SET_COUNTS_SQL, { rowCount: null }],
      [ZERO_DROPPED_SQL, { rowCount: null }],
      ...ANSWERS,
    ]);
    await expect(buildKeywordCounts(client)).resolves.toMatchObject({ updated: 0, zeroed: 0, vacuumed: true });
  });

  it('a failing first UPDATE rolls back and rethrows the original error unchanged; the second never runs', async () => {
    const failure = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
    const { client, texts } = fakeClient([[SET_COUNTS_SQL, { throws: failure }], ...ANSWERS]);
    await expect(buildKeywordCounts(client)).rejects.toBe(failure);
    expect(texts()).toEqual([...OPENING, HAS_PAIRS_SQL, SET_COUNTS_SQL, 'ROLLBACK']);
  });

  it('a failing second UPDATE rolls the first one back with it', async () => {
    const failure = Object.assign(new Error('connection lost'), { code: '08006' });
    const { client, texts } = fakeClient([[ZERO_DROPPED_SQL, { throws: failure }], ...ANSWERS]);
    await expect(buildKeywordCounts(client)).rejects.toBe(failure);
    expect(texts()).toEqual([...OPENING, HAS_PAIRS_SQL, SET_COUNTS_SQL, ZERO_DROPPED_SQL, 'ROLLBACK']);
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

  it.each([
    ['the empty-table check', HAS_PAIRS_SQL],
    ['the first UPDATE', SET_COUNTS_SQL],
    ['the second UPDATE', ZERO_DROPPED_SQL],
    ['the lock wait', LOCK],
    ['the COMMIT', 'COMMIT'],
  ])('a rolled-back build (%s fails) never runs the VACUUM', async (_what, head) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const failure = Object.assign(new Error('failed'), { code: '57014' });
    const { client, texts } = fakeClient([[head, { throws: failure }], ...ANSWERS]);
    await expect(buildKeywordCounts(client)).rejects.toBe(failure);
    expect(texts().slice(-1)).toEqual(['ROLLBACK']);
    expect(texts()).not.toContain(VACUUM);
    expect(warn).not.toHaveBeenCalled();
  });

  it('a failing VACUUM after the COMMIT warns once with the coded fields only; the committed counts are still returned, with vacuumed: false', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const failure = Object.assign(new Error('SECRET canceling statement due to statement timeout'), { code: '57014' });
    const { client, texts } = fakeClient([[VACUUM, { throws: failure }], ...ANSWERS]);
    await expect(buildKeywordCounts(client)).resolves.toMatchObject({ updated: 1234, zeroed: 56, vacuumed: false });
    expect(texts()).toEqual([...WRITE, VACUUM]); // no ROLLBACK: the write was already committed
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[keyword-counts] vacuum failed', JSON.stringify({ outcome: 'vacuum_failed', error: 'Error', code: '57014' }));
    expect(warn.mock.calls.flat().join(' ')).not.toContain('SECRET'); // never the message
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
