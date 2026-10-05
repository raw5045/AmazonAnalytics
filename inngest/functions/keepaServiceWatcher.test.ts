// inngest/functions/keepaServiceWatcher.test.ts
/**
 * SQL-shape tests for one watcher tick with a recording fake client that answers by statement
 * text. The decisions themselves are covered in lib/keepa/watcherRules.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spyOnConsole } from '@/tests/unit/consoleLines';

// The alarm sender is injected; its module graph still imports the database client.
vi.mock('@/db/client', () => ({ db: {} }));

import { lockKeyHalves, runWatcherTick, type WatcherTickDeps } from './keepaServiceWatcher';
import { ENQUEUE_LOCK_KEY } from '@/lib/keepa/lanes';

const NOW = new Date('2026-10-06T12:00:00Z'); // 08:00 ET: outside the nightly window
const min = (n: number) => new Date(NOW.getTime() - n * 60_000);

interface Status {
  boot_id: string | null;
  heartbeat_at: Date | null;
  last_batch_at: Date | null;
  tail_enabled: boolean;
  lane_new_drained_at: Date | null;
  sync_fired_at: Date | null;
  nightly_sync_date: string | null;
  down_alarm_sent_at: Date | null;
  stall_alarm_sent_at: Date | null;
}

const healthy: Status = {
  boot_id: 'boot-1',
  heartbeat_at: min(1),
  last_batch_at: min(2),
  tail_enabled: false,
  lane_new_drained_at: null,
  sync_fired_at: null,
  nightly_sync_date: null,
  down_alarm_sent_at: null,
  stall_alarm_sent_at: null,
};

interface Call { text: string; values: unknown[] | undefined }

function fakeClient(opts: { status?: Status | null; scopeWeek?: string | null; kcsWeek?: string | null } = {}) {
  const calls: Call[] = [];
  const scopeWeek = opts.scopeWeek === undefined ? '2026-10-03' : opts.scopeWeek;
  const kcsWeek = opts.kcsWeek === undefined ? '2026-10-03' : opts.kcsWeek;
  const query = async (text: string, values?: unknown[]) => {
    calls.push({ text, values });
    if (text.includes('FROM keepa_service_status')) return { rows: opts.status === null ? [] : [opts.status ?? healthy] };
    if (text.includes(') AS due')) return { rows: [{ due: true }] };
    if (text.includes('FROM pg_locks')) return { rows: [{ running: false }] };
    if (text.includes('AS scope_week')) return { rows: [{ scope_week: scopeWeek, kcs_week: kcsWeek }] };
    if (text.includes('AS cw')) return { rows: [{ cw: kcsWeek }] };
    if (text.startsWith('UPDATE keepa_service_status SET ')) return { rows: [] };
    throw new Error(`unexpected statement: ${text}`);
  };
  return { client: { query } as never, calls, texts: () => calls.map((c) => c.text) };
}

function deps(over: Partial<WatcherTickDeps> = {}) {
  const sendAlarm = vi.fn<WatcherTickDeps['sendAlarm']>(async () => {});
  const sendEvent = vi.fn<WatcherTickDeps['sendEvent']>(async () => ({}));
  return { deps: { now: NOW, readSource: 'products' as const, sendAlarm, sendEvent, ...over }, sendAlarm, sendEvent };
}

const flat = (text: string) => text.replace(/\s+/g, ' ');
const readsWeeks = (texts: string[]) => texts.some((t) => t.includes('AS scope_week'));

describe('lockKeyHalves', () => {
  it('splits a bigint advisory-lock key the way pg_locks shows it', () => {
    expect(lockKeyHalves(ENQUEUE_LOCK_KEY)).toEqual([0, 20261005]);
    expect(lockKeyHalves(2 ** 32 + 5)).toEqual([1, 5]);
  });
});

describe('runWatcherTick', () => {
  beforeEach(() => {
    spyOnConsole();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads every status column the rules need, including boot_id, and does nothing on a healthy tick', async () => {
    const f = fakeClient();
    const d = deps();
    await expect(runWatcherTick(f.client, d.deps)).resolves.toEqual({ ok: true, actions: [] });
    for (const col of ['boot_id', 'heartbeat_at', 'last_batch_at', 'tail_enabled', 'lane_new_drained_at', 'sync_fired_at', 'nightly_sync_date', 'down_alarm_sent_at', 'stall_alarm_sent_at']) {
      expect(f.calls[0].text).toContain(col);
    }
    // The status row, the due probe and the lock probe: no weeks query, no writes.
    expect(f.calls).toHaveLength(3);
    expect(d.sendAlarm).not.toHaveBeenCalled();
    expect(d.sendEvent).not.toHaveBeenCalled();
  });

  it("probes due work with both lanes' literal partial-index predicates and the tail flag", async () => {
    const f = fakeClient({ status: { ...healthy, tail_enabled: true } });
    await runWatcherTick(f.client, deps().deps);
    const probe = flat(f.calls[1].text);
    expect(probe).toContain('WHERE in_scope AND claimed_at IS NULL AND last_fetched_at IS NULL AND next_due_at <= now() AND (tier = 1 OR $1::boolean)');
    expect(probe).toContain('WHERE in_scope AND claimed_at IS NULL AND last_fetched_at IS NOT NULL AND next_due_at <= now() AND (tier = 1 OR $1::boolean)');
    expect(f.calls[1].values).toEqual([true]);
  });

  it('probes the enqueue lock with both key halves as parameters', async () => {
    const f = fakeClient();
    await runWatcherTick(f.client, deps().deps);
    expect(flat(f.calls[2].text)).toContain(
      "WHERE locktype = 'advisory' AND classid = $1::oid AND objid = $2::oid AND objsubid = 1 AND mode = 'ExclusiveLock' AND granted",
    );
    expect(f.calls[2].values).toEqual([0, 20261005]);
  });

  it('reads the scope and explorer weeks only when a sync decision needs them', async () => {
    const quiet = fakeClient();
    await runWatcherTick(quiet.client, deps().deps);
    expect(readsWeeks(quiet.texts())).toBe(false);

    const drained = fakeClient({ status: { ...healthy, lane_new_drained_at: min(3) } });
    await runWatcherTick(drained.client, deps().deps);
    expect(readsWeeks(drained.texts())).toBe(true);

    const weekly = fakeClient({ status: { ...healthy, lane_new_drained_at: min(3) } });
    await runWatcherTick(weekly.client, deps({ readSource: 'weekly' }).deps);
    expect(readsWeeks(weekly.texts())).toBe(false);

    const night = fakeClient();
    await runWatcherTick(night.client, deps({ now: new Date('2026-10-06T07:31:00Z') }).deps); // 03:31 ET
    expect(readsWeeks(night.texts())).toBe(true);
  });

  it('a stale heartbeat sends the down alarm and stamps it through the whitelist', async () => {
    const f = fakeClient({ status: { ...healthy, heartbeat_at: min(40) } });
    const d = deps();
    await expect(runWatcherTick(f.client, d.deps)).resolves.toEqual({ ok: true, actions: ['email:down', 'stamp:down_alarm_sent_at'] });
    expect(d.sendAlarm).toHaveBeenCalledWith({ variant: 'down', heartbeatAt: min(40), lastBatchAt: min(2) });
    expect(f.calls.at(-1)).toEqual({ text: 'UPDATE keepa_service_status SET down_alarm_sent_at = $1 WHERE singleton', values: [NOW] });
  });

  it('a drained lane with the explorer caught up requests the sync for the explorer week and stamps it', async () => {
    const f = fakeClient({ status: { ...healthy, lane_new_drained_at: min(3) } });
    const d = deps();
    await expect(runWatcherTick(f.client, d.deps)).resolves.toEqual({ ok: true, actions: ['sync:new_lane_drained', 'stamp:sync_fired_at'] });
    expect(d.sendEvent).toHaveBeenCalledWith('keepa/aggregates-sync-requested', { weekEndDate: '2026-10-03' });
    expect(f.calls.at(-1)).toEqual({ text: 'UPDATE keepa_service_status SET sync_fired_at = $1 WHERE singleton', values: [NOW] });
  });

  it('holds the drained-lane sync while the explorer is still on the previous week', async () => {
    const f = fakeClient({ status: { ...healthy, lane_new_drained_at: min(3) }, scopeWeek: '2026-10-03', kcsWeek: '2026-09-26' });
    const d = deps();
    await expect(runWatcherTick(f.client, d.deps)).resolves.toEqual({ ok: true, actions: [] });
    expect(d.sendEvent).not.toHaveBeenCalled();
    expect(f.texts().some((t) => t.startsWith('UPDATE'))).toBe(false);
  });

  it('before the first boot: only the reads, no actions', async () => {
    const f = fakeClient({ status: { ...healthy, boot_id: null, heartbeat_at: null, last_batch_at: null, lane_new_drained_at: min(3) } });
    const d = deps();
    await expect(runWatcherTick(f.client, d.deps)).resolves.toEqual({ ok: true, actions: [] });
    expect(f.texts().every((t) => t.trimStart().startsWith('SELECT'))).toBe(true);
    expect(d.sendAlarm).not.toHaveBeenCalled();
    expect(d.sendEvent).not.toHaveBeenCalled();
  });

  it('skips the tick when the status row is missing', async () => {
    const f = fakeClient({ status: null });
    await expect(runWatcherTick(f.client, deps().deps)).resolves.toEqual({ ok: true, skipped: 'no status row' });
    expect(f.calls).toHaveLength(1);
  });
});
