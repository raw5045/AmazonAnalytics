// lib/admin/keepaServiceOverview.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
const dbm = vi.hoisted(() => ({ execute: vi.fn(), select: vi.fn(), from: vi.fn(), limit: vi.fn() }));
vi.mock('@/db/client', () => ({ db: { execute: dbm.execute, select: dbm.select } }));
import { keepaServiceStatus } from '@/db/schema';
import { loadKeepaServiceOverview } from './keepaServiceOverview';

/** One aggregate row keyed by the SQL aliases. Every value is distinct, so a swapped alias shows. */
const AGG: Record<string, unknown> = {
  tier1_in_scope: 1_003_344, tier1_never_fetched: 715_083, tier1_due: 12, tier1_stale: 4, tier1_erroring: 3,
  tier2_in_scope: 1_307_312, tier2_never_fetched: 1_239_033, tier2_due: 7,
  fetched_last_24h: 160_000, fetched_last_7d: 900_000, oldest_tier1_fetched_at: new Date('2026-09-28T09:39:00Z'), claimed: 100,
  scope_week: '2026-10-03',
};
/** The status row as drizzle's typed select returns it: timestamps are Date | null, nightlySyncDate is a string. */
const STATUS_ROW = {
  singleton: true, bootId: 'abcdef12-0000', bootedAt: new Date('2026-10-06T08:00:00Z'), heartbeatAt: new Date('2026-10-06T11:57:30Z'),
  lastBatchAt: new Date('2026-10-06T11:57:00Z'), lastBatchLane: 'due', tokensLeft: 180, refillRate: 250, tailEnabled: true,
  lastErrorCode: 'keepa_http_429', lastErrorAt: new Date('2026-10-06T10:00:00Z'), laneNewDrainedAt: new Date('2026-10-05T06:00:00Z'),
  syncFiredAt: new Date('2026-10-06T07:00:00Z'), nightlySyncDate: '2026-10-06', downAlarmSentAt: null, stallAlarmSentAt: null,
};

function arrange(aggRow: Record<string, unknown> | undefined, statusRows: unknown[] = [STATUS_ROW]) {
  dbm.execute.mockResolvedValue({ rows: aggRow ? [aggRow] : [] });
  dbm.limit.mockResolvedValue(statusRows);
  dbm.from.mockReturnValue({ limit: dbm.limit });
  dbm.select.mockReturnValue({ from: dbm.from });
}

describe('loadKeepaServiceOverview', () => {
  beforeEach(() => vi.clearAllMocks());

  it('maps every aggregate alias and the typed status row; the explorer week comes from the caller', async () => {
    arrange(AGG);
    await expect(loadKeepaServiceOverview('2026-10-03')).resolves.toEqual({
      status: {
        bootId: 'abcdef12-0000', bootedAt: new Date('2026-10-06T08:00:00Z'), heartbeatAt: new Date('2026-10-06T11:57:30Z'),
        lastBatchAt: new Date('2026-10-06T11:57:00Z'), lastBatchLane: 'due', tokensLeft: 180, refillRate: 250, tailEnabled: true,
        lastErrorCode: 'keepa_http_429', lastErrorAt: new Date('2026-10-06T10:00:00Z'), laneNewDrainedAt: new Date('2026-10-05T06:00:00Z'),
        syncFiredAt: new Date('2026-10-06T07:00:00Z'),
      },
      counts: {
        tier1InScope: 1_003_344, tier1NeverFetched: 715_083, tier1Due: 12, tier1Stale: 4, tier1Erroring: 3,
        tier2InScope: 1_307_312, tier2NeverFetched: 1_239_033, tier2Due: 7,
        fetchedLast24h: 160_000, fetchedLast7d: 900_000, oldestTier1FetchedAt: new Date('2026-09-28T09:39:00Z'), claimed: 100,
        scopeWeek: '2026-10-03', kcsWeek: '2026-10-03',
      },
    });
  });

  it('reads one aggregate pass over asin_products and the status row through the typed select', async () => {
    arrange(AGG);
    await loadKeepaServiceOverview(null);
    expect(dbm.execute).toHaveBeenCalledTimes(1);
    const s = JSON.stringify(dbm.execute.mock.calls[0][0]);
    expect(s.split('asin_products')).toHaveLength(2); // named exactly once
    expect(s.split("enrichment_status IS DISTINCT FROM 'delisted'")).toHaveLength(3); // stale count + oldest fetch
    expect(s).toContain("last_fetched_at < now() - interval '8 days'");
    expect(s).toContain('consecutive_errors > 0');
    expect(s).not.toContain('keyword_current_summary_meta'); // the page passes the explorer week in
    expect(dbm.from).toHaveBeenCalledWith(keepaServiceStatus);
    expect(dbm.limit).toHaveBeenCalledWith(1);
  });

  it('reads Postgres text timestamps from the raw aggregate, and an unparseable or null one as null', async () => {
    arrange({ ...AGG, oldest_tier1_fetched_at: '2026-09-28 09:39:00.123456+00' });
    expect((await loadKeepaServiceOverview(null)).counts.oldestTier1FetchedAt).toEqual(new Date('2026-09-28T09:39:00.123Z'));
    arrange({ ...AGG, oldest_tier1_fetched_at: 'not a timestamp' });
    expect((await loadKeepaServiceOverview(null)).counts.oldestTier1FetchedAt).toBeNull();
    arrange({ ...AGG, oldest_tier1_fetched_at: null, scope_week: null });
    const { counts } = await loadKeepaServiceOverview(null);
    expect(counts.oldestTier1FetchedAt).toBeNull();
    expect(counts.scopeWeek).toBeNull();
    expect(counts.kcsWeek).toBeNull();
  });

  it('selects exactly the aliases the mapping reads, so an alias renamed in the SQL alone fails here', async () => {
    arrange(AGG);
    await loadKeepaServiceOverview(null);
    const text = JSON.stringify(dbm.execute.mock.calls[0][0]);
    const aliases = [...text.matchAll(/ AS (\w+)/g)].map((m) => m[1]).sort();
    // AGG's keys are the mapping's keys: the mapping test reads every one of them (distinct values),
    // and a key the mapping wanted but AGG lacked would throw overview_missing.
    expect(aliases).toEqual(Object.keys(AGG).sort());
  });

  it('throws a coded error on a missing alias instead of reading it as 0 or null', async () => {
    for (const alias of Object.keys(AGG)) {
      const row = { ...AGG };
      delete row[alias];
      arrange(row);
      const err = await loadKeepaServiceOverview(null).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).toHaveProperty('code', `overview_missing:${alias}`);
      expect(`overview_missing:${alias}`.length).toBeLessThan(64);
    }
    arrange(undefined); // no aggregate row at all
    await expect(loadKeepaServiceOverview(null)).rejects.toHaveProperty('code', 'overview_missing:tier1_in_scope');
  });

  it('returns a null status before the service has written its row', async () => {
    arrange(AGG, []);
    const overview = await loadKeepaServiceOverview('2026-10-03');
    expect(overview.status).toBeNull();
    expect(overview.counts.tier1InScope).toBe(1_003_344);
  });
});
