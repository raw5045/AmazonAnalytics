import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/env', () => ({ env: { DATABASE_URL: 'postgres://test' } }));

import { countMatches, runSearch } from './search';
import { loadSnapshotMeta, SNAPSHOT_META_SQL } from './snapshot';
import type { CompiledSearch } from './query';
import type { TxClient } from '@/lib/db/tcpPool';

const META = { week: '2026-09-12', snap: 'snap-a', refreshed: '2026-09-13T06:12:01.500Z', fit_id: 'fit-1', cal_month: '2026-06-30', extrapolated: false };
const compiled: CompiledSearch = { sql: 'SELECT rows', args: ['x'], countSql: 'SELECT COUNT', countArgs: ['x'], orderBy: '' };

/** A pool whose single client answers by SQL text; `fail` makes one statement raise. */
function pool(answers: Record<string, unknown[]>, fail?: { sql: string; code?: string }) {
  const log: string[] = [];
  const client = {
    query: vi.fn(async (sql: string) => {
      log.push(sql);
      if (fail && sql === fail.sql) throw Object.assign(new Error('boom'), fail.code ? { code: fail.code } : {});
      const key = Object.keys(answers).find((k) => sql.includes(k));
      return { rows: key ? answers[key] : [] };
    }),
    release: vi.fn(),
    // withReadOnlyTx (lib/db/tcpPool.ts) attaches a no-op 'error' listener to the checked-out
    // client for the duration of the transaction and removes it in `finally` — the fake client
    // needs both so that plumbing doesn't throw.
    on: vi.fn(),
    removeListener: vi.fn(),
  };
  return { pool: { connect: async () => client } as never, log, client };
}

describe('loadSnapshotMeta', () => {
  it('maps the singleton row to ISO strings and nulls, or null when absent', async () => {
    const p = pool({ keyword_current_summary_meta: [META] });
    // Cast through TxClient directly (not an ad-hoc inline shape): PoolClient['query'] is a
    // real overloaded signature, so a simple mock only satisfies it via the same
    // as-unknown-as-TxClient convention categories.test.ts's fake CategoryTxRunner already uses.
    const client = await (p.pool as { connect: () => Promise<TxClient> }).connect();
    expect(await loadSnapshotMeta(client)).toEqual({
      currentWeekEndDate: '2026-09-12', snapshotVersion: 'snap-a', refreshedAt: '2026-09-13T06:12:01.500Z',
      volumeFitRunId: 'fit-1', calibrationMonthEndDate: '2026-06-30', isExtrapolated: false,
    });
    const empty = await (pool({}).pool as { connect: () => Promise<TxClient> }).connect();
    expect(await loadSnapshotMeta(empty)).toBeNull();
  });

  it('is null when week, snap, or refreshed is individually missing, even with the rest of the row present', async () => {
    for (const partial of [{ ...META, week: null }, { ...META, snap: null }, { ...META, refreshed: null }]) {
      const p = pool({ keyword_current_summary_meta: [partial] });
      const client = await (p.pool as { connect: () => Promise<TxClient> }).connect();
      expect(await loadSnapshotMeta(client)).toBeNull();
    }
  });

  it('maps a missing fit_id/cal_month/extrapolated to null/null/false', async () => {
    const p = pool({ keyword_current_summary_meta: [{ ...META, fit_id: null, cal_month: null, extrapolated: null }] });
    const client = await (p.pool as { connect: () => Promise<TxClient> }).connect();
    expect(await loadSnapshotMeta(client)).toEqual({
      currentWeekEndDate: '2026-09-12', snapshotVersion: 'snap-a', refreshedAt: '2026-09-13T06:12:01.500Z',
      volumeFitRunId: null, calibrationMonthEndDate: null, isExtrapolated: false,
    });
  });
});

describe('runSearch', () => {
  it('reads meta then the page inside one transaction and compiles with the meta week', async () => {
    const p = pool({ keyword_current_summary_meta: [META], 'SELECT rows': [{ search_term_id: 'a' }] });
    const compile = vi.fn(() => compiled);
    const out = await runSearch(p.pool, 10_000, compile, { expectedSnapshot: null });
    expect(compile).toHaveBeenCalledWith(expect.objectContaining({ currentWeekEndDate: '2026-09-12', snapshotVersion: 'snap-a' }));
    expect(out.rows).toEqual([{ search_term_id: 'a' }]);
    expect(p.log[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(p.log.at(-1)).toBe('COMMIT');
  });

  it('is DATA_UNAVAILABLE without meta, SEARCH_EXPIRED on a snapshot change, QUERY_TIMEOUT (budget in the message) on 57014', async () => {
    await expect(runSearch(pool({}).pool, 10_000, () => compiled, { expectedSnapshot: null })).rejects.toMatchObject({ code: 'DATA_UNAVAILABLE', retryable: true });
    await expect(runSearch(pool({ keyword_current_summary_meta: [META] }).pool, 10_000, () => compiled, { expectedSnapshot: 'snap-old' })).rejects.toMatchObject({ code: 'SEARCH_EXPIRED' });
    await expect(runSearch(pool({ keyword_current_summary_meta: [META] }, { sql: 'SELECT rows', code: '57014' }).pool, 10_000, () => compiled, { expectedSnapshot: null }))
      .rejects.toMatchObject({ code: 'QUERY_TIMEOUT', retryable: true, message: expect.stringContaining('10-second') });
  });

  it('rolls back without ever running the page query on SEARCH_EXPIRED, and releases the client exactly once', async () => {
    const p = pool({ keyword_current_summary_meta: [META] });
    await expect(runSearch(p.pool, 10_000, () => compiled, { expectedSnapshot: 'snap-old' })).rejects.toMatchObject({ code: 'SEARCH_EXPIRED' });
    expect(p.log).not.toContain('SELECT rows');
    expect(p.log.at(-1)).toBe('ROLLBACK');
    expect(p.client.release).toHaveBeenCalledTimes(1);
  });

  it('releases the client exactly once on a timeout too', async () => {
    const p = pool({ keyword_current_summary_meta: [META] }, { sql: 'SELECT rows', code: '57014' });
    await expect(runSearch(p.pool, 10_000, () => compiled, { expectedSnapshot: null })).rejects.toMatchObject({ code: 'QUERY_TIMEOUT' });
    expect(p.client.release).toHaveBeenCalledTimes(1);
  });

  it('a 57014 on the meta SQL itself is QUERY_TIMEOUT too, not only on the page query', async () => {
    const p = pool({}, { sql: SNAPSHOT_META_SQL, code: '57014' });
    await expect(runSearch(p.pool, 10_000, () => compiled, { expectedSnapshot: null })).rejects.toMatchObject({ code: 'QUERY_TIMEOUT', retryable: true });
  });
});

describe('countMatches', () => {
  it('is exact up to the cap, at_least beyond it, still exact right at the cap boundary, unknown on timeout', async () => {
    expect(await countMatches(pool({ 'SELECT COUNT': [{ total: 137 }] }).pool, 3_000, compiled)).toEqual({ kind: 'exact', value: 137 });
    expect(await countMatches(pool({ 'SELECT COUNT': [{ total: 10001 }] }).pool, 3_000, compiled)).toEqual({ kind: 'at_least', value: 10000 });
    expect(await countMatches(pool({ 'SELECT COUNT': [{ total: 10_000 }] }).pool, 3_000, compiled)).toEqual({ kind: 'exact', value: 10000 });
    expect(await countMatches(pool({}, { sql: 'SELECT COUNT', code: '57014' }).pool, 3_000, compiled)).toEqual({ kind: 'unknown', value: null });
  });

  it('checks the snapshot before counting when expectedSnapshot is given: a moved or missing snapshot is unknown without ever issuing the count SQL; a matching snapshot counts normally', async () => {
    const moved = pool({ keyword_current_summary_meta: [{ ...META, snap: 'snap-b' }], 'SELECT COUNT': [{ total: 137 }] });
    expect(await countMatches(moved.pool, 3_000, compiled, { expectedSnapshot: 'snap-a' })).toEqual({ kind: 'unknown', value: null });
    expect(moved.log).not.toContain('SELECT COUNT');

    const missingMeta = pool({ 'SELECT COUNT': [{ total: 137 }] });
    expect(await countMatches(missingMeta.pool, 3_000, compiled, { expectedSnapshot: 'snap-a' })).toEqual({ kind: 'unknown', value: null });
    expect(missingMeta.log).not.toContain('SELECT COUNT');

    const same = pool({ keyword_current_summary_meta: [META], 'SELECT COUNT': [{ total: 137 }] });
    expect(await countMatches(same.pool, 3_000, compiled, { expectedSnapshot: 'snap-a' })).toEqual({ kind: 'exact', value: 137 });
  });
});
