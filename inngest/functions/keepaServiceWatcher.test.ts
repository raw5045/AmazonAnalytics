// inngest/functions/keepaServiceWatcher.test.ts
/**
 * One watcher tick against a recording fake client that answers by statement text. The alarm and
 * event senders write into the same ordered trace as the SQL, so "send, then stamp" is pinned. The
 * decisions themselves are covered in lib/keepa/watcherRules.test.ts; the real schema in
 * tests/integration/keepaWatcher.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { consoleLines, spyOnConsole } from '@/tests/unit/consoleLines';

// The alarm sender is injected; its module graph still imports the database client.
vi.mock('@/db/client', () => ({ db: {} }));

import { runWatcherTick, type WatcherTickDeps } from './keepaServiceWatcher';

const NOW = new Date('2026-10-06T12:00:00Z'); // 08:00 ET: outside the nightly window
const NIGHT_NOW = new Date('2026-10-06T07:31:00Z'); // 03:31 ET
const ago = (n: number, from: Date = NOW) => new Date(from.getTime() - n * 60_000);

interface Status {
  boot_id: string | null;
  booted_at: Date | null;
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
  booted_at: ago(24 * 60),
  heartbeat_at: ago(1),
  last_batch_at: ago(2),
  tail_enabled: false,
  lane_new_drained_at: null,
  sync_fired_at: null,
  nightly_sync_date: null,
  down_alarm_sent_at: null,
  stall_alarm_sent_at: null,
};

interface FakeOpts {
  /** Overrides on the healthy status row; null = no status row. */
  status?: Partial<Status> | null;
  due?: boolean;
  running?: boolean;
  scopeWeek?: string | null;
  kcsWeek?: string | null;
  /** What sendAlarm reports: true = Resend accepted the email. */
  delivered?: boolean;
  /** An old per-week enrichment run (keepa_enrichment_runs) heartbeat in the last thirty minutes, any status. */
  oldJob?: boolean;
}

function orDefault<T>(v: T | undefined, d: T): T {
  return v === undefined ? d : v;
}

function harness(opts: FakeOpts = {}, over: Partial<Pick<WatcherTickDeps, 'now' | 'readSource'>> = {}) {
  /** Every interaction in order: `sql:<text>`, `alarm:<variant>`, `event:<name>`. */
  const trace: string[] = [];
  const calls: Array<{ text: string; values: unknown[] | undefined }> = [];
  const query = async (text: string, values?: unknown[]) => {
    calls.push({ text, values });
    trace.push(`sql:${text}`);
    if (text.includes('FROM keepa_service_status')) return { rows: opts.status === null ? [] : [{ ...healthy, ...opts.status }] };
    if (text.includes(') AS due')) return { rows: [{ due: orDefault(opts.due, true) }] };
    if (text.includes('FROM pg_locks')) return { rows: [{ running: orDefault(opts.running, false) }] };
    if (text.includes('FROM keepa_enrichment_runs')) return { rows: [{ running: orDefault(opts.oldJob, false) }] };
    if (text.includes('AS scope_week')) {
      return { rows: [{ scope_week: orDefault(opts.scopeWeek, '2026-10-03'), kcs_week: orDefault(opts.kcsWeek, '2026-10-03') }] };
    }
    if (text.startsWith('UPDATE keepa_service_status SET ')) return { rows: [] };
    throw new Error(`unexpected statement: ${text}`);
  };
  const sendAlarm = vi.fn<WatcherTickDeps['sendAlarm']>(async (input) => {
    trace.push(`alarm:${input.variant}`);
    return orDefault(opts.delivered, true);
  });
  const sendEvent = vi.fn<WatcherTickDeps['sendEvent']>(async (name) => {
    trace.push(`event:${name}`);
    return {};
  });
  const deps: WatcherTickDeps = { now: NOW, readSource: 'products', sendAlarm, sendEvent, ...over };
  return {
    client: { query } as never,
    deps,
    calls,
    trace,
    sendAlarm,
    sendEvent,
    texts: () => calls.map((c) => c.text),
    updates: () => calls.filter((c) => c.text.startsWith('UPDATE')),
    /** Everything after the reads, in order: alarms, events and writes. */
    effects: () => trace.filter((t) => !t.startsWith('sql:SELECT')),
  };
}

const flat = (text: string) => text.replace(/\s+/g, ' ');
const readsWeeks = (texts: string[]) => texts.some((t) => t.includes('AS scope_week'));
const stampSql = (field: string) => `UPDATE keepa_service_status SET ${field} = $1 WHERE singleton`;

describe('runWatcherTick', () => {
  let spies: ReturnType<typeof spyOnConsole>;
  beforeEach(() => {
    spies = spyOnConsole();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** The tick's one log line, parsed. */
  function tickLog(): Record<string, unknown> {
    const line = consoleLines(...spies).find((l) => l.startsWith('[keepa-watcher] '));
    if (!line) throw new Error('no tick log line');
    return JSON.parse(line.slice('[keepa-watcher] '.length)) as Record<string, unknown>;
  }

  it('reads every status column the rules need, including boot_id, and does nothing on a healthy tick', async () => {
    const h = harness();
    await expect(runWatcherTick(h.client, h.deps)).resolves.toEqual({ ok: true, actions: [] });
    for (const col of ['boot_id', 'booted_at', 'heartbeat_at', 'last_batch_at', 'tail_enabled', 'lane_new_drained_at', 'sync_fired_at', 'nightly_sync_date', 'down_alarm_sent_at', 'stall_alarm_sent_at']) {
      expect(h.calls[0].text).toContain(col);
    }
    // The status row, the due probe, the lock probe and the old-job probe: no weeks query, no writes.
    expect(h.calls).toHaveLength(4);
    expect(h.sendAlarm).not.toHaveBeenCalled();
    expect(h.sendEvent).not.toHaveBeenCalled();
  });

  it("probes due work with both lanes' literal partial-index predicates, five minutes of grace and the tail flag", async () => {
    const h = harness({ status: { tail_enabled: true } });
    await runWatcherTick(h.client, h.deps);
    const probe = flat(h.calls[1].text);
    expect(probe).toContain(
      "WHERE in_scope AND claimed_at IS NULL AND last_fetched_at IS NULL AND next_due_at <= now() - interval '5 minutes' AND (tier = 1 OR $1::boolean)",
    );
    expect(probe).toContain(
      "WHERE in_scope AND claimed_at IS NULL AND last_fetched_at IS NOT NULL AND next_due_at <= now() - interval '5 minutes' AND (tier = 1 OR $1::boolean)",
    );
    expect(h.calls[1].values).toEqual([true]);
  });

  it('probes the enqueue lock in this database with both key halves as parameters', async () => {
    const h = harness();
    await runWatcherTick(h.client, h.deps);
    expect(flat(h.calls[2].text)).toContain(
      "WHERE locktype = 'advisory' AND classid = $1::oid AND objid = $2::oid AND objsubid = 1 AND mode = 'ExclusiveLock' AND granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())",
    );
    expect(h.calls[2].values).toEqual([0, 20261005]);
  });

  it('reads the scope and explorer weeks only when a sync decision needs them', async () => {
    const quiet = harness();
    await runWatcherTick(quiet.client, quiet.deps);
    expect(readsWeeks(quiet.texts())).toBe(false);

    const drained = harness({ status: { lane_new_drained_at: ago(3) } });
    await runWatcherTick(drained.client, drained.deps);
    expect(readsWeeks(drained.texts())).toBe(true);

    const weekly = harness({ status: { lane_new_drained_at: ago(3) } }, { readSource: 'weekly' });
    await runWatcherTick(weekly.client, weekly.deps);
    expect(readsWeeks(weekly.texts())).toBe(false);

    const night = harness({}, { now: NIGHT_NOW });
    await runWatcherTick(night.client, night.deps);
    expect(readsWeeks(night.texts())).toBe(true);
  });

  it('work due and a three-hour-old last batch: the stall alarm goes out, then its stamp', async () => {
    const h = harness({ status: { last_batch_at: ago(180) }, due: true });
    await expect(runWatcherTick(h.client, h.deps)).resolves.toEqual({ ok: true, actions: ['email:stalled', 'stamp:stall_alarm_sent_at'] });
    expect(h.effects()).toEqual(['alarm:stalled', `sql:${stampSql('stall_alarm_sent_at')}`]);
    expect(h.updates()).toEqual([{ text: stampSql('stall_alarm_sent_at'), values: [NOW] }]);
  });

  it('no due work: a three-hour-old last batch is not a stall', async () => {
    const h = harness({ status: { last_batch_at: ago(180) }, due: false });
    await expect(runWatcherTick(h.client, h.deps)).resolves.toEqual({ ok: true, actions: [] });
    expect(h.sendAlarm).not.toHaveBeenCalled();
    expect(h.updates()).toEqual([]);
  });

  it('while the weekly enqueue holds its lock, a stale heartbeat raises nothing', async () => {
    const h = harness({ status: { heartbeat_at: ago(40) }, running: true });
    await expect(runWatcherTick(h.client, h.deps)).resolves.toEqual({ ok: true, actions: [] });
    expect(h.sendAlarm).not.toHaveBeenCalled();
    expect(h.updates()).toEqual([]);
  });

  it("within thirty minutes of an old enrichment run's heartbeat the stall alarm is held, but a down alarm still goes out", async () => {
    // Tonight's sync already ran, so the log's held list carries only the job.
    const held = harness({ status: { last_batch_at: ago(180), nightly_sync_date: '2026-10-06' }, oldJob: true });
    await expect(runWatcherTick(held.client, held.deps)).resolves.toEqual({ ok: true, actions: [] });
    // Any status: a run marked orphaned or completed can still have the service yielding to it.
    expect(flat(held.calls[3].text)).toContain("FROM keepa_enrichment_runs WHERE heartbeat_at > now() - interval '30 minutes'");
    expect(held.calls[3].text).not.toContain('status');
    expect(held.sendAlarm).not.toHaveBeenCalled();
    expect(held.updates()).toEqual([]);
    expect(tickLog().held).toEqual(['old_job_recent']);

    const down = harness({ status: { heartbeat_at: ago(40) }, oldJob: true });
    await expect(runWatcherTick(down.client, down.deps)).resolves.toEqual({ ok: true, actions: ['email:down', 'stamp:down_alarm_sent_at'] });
  });

  it('before the first batch the stall clock runs from boot', async () => {
    const young = harness({ status: { last_batch_at: null, booted_at: ago(30) } });
    await expect(runWatcherTick(young.client, young.deps)).resolves.toEqual({ ok: true, actions: [] });
    const old = harness({ status: { last_batch_at: null, booted_at: ago(130) } });
    await expect(runWatcherTick(old.client, old.deps)).resolves.toEqual({ ok: true, actions: ['email:stalled', 'stamp:stall_alarm_sent_at'] });
  });

  it('a stale heartbeat sends the down alarm, then stamps it through the whitelist', async () => {
    const h = harness({ status: { heartbeat_at: ago(40) } });
    await expect(runWatcherTick(h.client, h.deps)).resolves.toEqual({ ok: true, actions: ['email:down', 'stamp:down_alarm_sent_at'] });
    expect(h.sendAlarm).toHaveBeenCalledWith({ variant: 'down', heartbeatAt: ago(40), lastBatchAt: ago(2) });
    expect(h.effects()).toEqual(['alarm:down', `sql:${stampSql('down_alarm_sent_at')}`]);
    expect(h.updates()).toEqual([{ text: stampSql('down_alarm_sent_at'), values: [NOW] }]);
  });

  it('a failed alarm send leaves its stamp unset so the next tick retries; clearing a stamp does not wait on the send', async () => {
    const failed = harness({ status: { heartbeat_at: ago(40) }, delivered: false });
    await expect(runWatcherTick(failed.client, failed.deps)).resolves.toEqual({
      ok: true,
      actions: ['email:down:unsent', 'stamp:down_alarm_sent_at:skipped'],
    });
    expect(failed.updates()).toEqual([]);

    const back = harness({ status: { down_alarm_sent_at: ago(30) }, delivered: false });
    await expect(runWatcherTick(back.client, back.deps)).resolves.toEqual({ ok: true, actions: ['email:recovered:unsent', 'stamp:down_alarm_sent_at'] });
    expect(back.updates()).toEqual([{ text: stampSql('down_alarm_sent_at'), values: [null] }]);
  });

  it('back up but still stalled: the down alarm clears only once the stall update went out, else the next tick retries', async () => {
    const status = { down_alarm_sent_at: ago(30), stall_alarm_sent_at: ago(90), last_batch_at: ago(180) };
    const failed = harness({ status, delivered: false });
    await expect(runWatcherTick(failed.client, failed.deps)).resolves.toEqual({
      ok: true,
      actions: ['email:stalled:unsent', 'stamp:down_alarm_sent_at:skipped'],
    });
    expect(failed.updates()).toEqual([]);
    // Nothing was written, so the next tick sees the same row and sends the update again.
    const retry = harness({ status, delivered: true });
    await expect(runWatcherTick(retry.client, retry.deps)).resolves.toEqual({ ok: true, actions: ['email:stalled', 'stamp:down_alarm_sent_at'] });
    expect(retry.effects()).toEqual(['alarm:stalled', `sql:${stampSql('down_alarm_sent_at')}`]);
    expect(retry.updates()).toEqual([{ text: stampSql('down_alarm_sent_at'), values: [null] }]);
  });

  it('a drained lane with the explorer caught up requests the sync for the explorer week, then stamps it', async () => {
    const h = harness({ status: { lane_new_drained_at: ago(3) } });
    await expect(runWatcherTick(h.client, h.deps)).resolves.toEqual({ ok: true, actions: ['sync:new_lane_drained', 'stamp:sync_fired_at'] });
    expect(h.sendEvent).toHaveBeenCalledWith('keepa/aggregates-sync-requested', { weekEndDate: '2026-10-03' });
    expect(h.effects()).toEqual(['event:keepa/aggregates-sync-requested', `sql:${stampSql('sync_fired_at')}`]);
    expect(h.updates()).toEqual([{ text: stampSql('sync_fired_at'), values: [NOW] }]);
  });

  it('03:31 ET with a batch today: the nightly sync, then the ET date and the sync time stamped', async () => {
    const h = harness({ status: { heartbeat_at: ago(1, NIGHT_NOW), last_batch_at: ago(20, NIGHT_NOW) } }, { now: NIGHT_NOW });
    await expect(runWatcherTick(h.client, h.deps)).resolves.toEqual({
      ok: true,
      actions: ['sync:nightly', 'stamp:nightly_sync_date', 'stamp:sync_fired_at'],
    });
    expect(h.sendEvent).toHaveBeenCalledWith('keepa/aggregates-sync-requested', { weekEndDate: '2026-10-03' });
    expect(h.effects()).toEqual([
      'event:keepa/aggregates-sync-requested',
      `sql:${stampSql('nightly_sync_date')}`,
      `sql:${stampSql('sync_fired_at')}`,
    ]);
    expect(h.updates()).toEqual([
      { text: stampSql('nightly_sync_date'), values: ['2026-10-06'] },
      { text: stampSql('sync_fired_at'), values: [NIGHT_NOW] },
    ]);
  });

  it('holds the drained-lane sync while the explorer is behind or its week is unknown', async () => {
    for (const kcsWeek of ['2026-09-26', null]) {
      const h = harness({ status: { lane_new_drained_at: ago(3) }, scopeWeek: '2026-10-03', kcsWeek });
      await expect(runWatcherTick(h.client, h.deps)).resolves.toEqual({ ok: true, actions: [] });
      expect(h.sendEvent).not.toHaveBeenCalled();
      expect(h.updates()).toEqual([]);
    }
  });

  it('before the first boot: only the reads, no actions', async () => {
    const h = harness({ status: { boot_id: null, heartbeat_at: null, last_batch_at: null, lane_new_drained_at: ago(3) } });
    await expect(runWatcherTick(h.client, h.deps)).resolves.toEqual({ ok: true, actions: [] });
    expect(h.texts().every((t) => t.trimStart().startsWith('SELECT'))).toBe(true);
    expect(h.sendAlarm).not.toHaveBeenCalled();
    expect(h.sendEvent).not.toHaveBeenCalled();
    expect(tickLog().held).toEqual(['not_booted']);
  });

  it('skips the tick when the status row is missing', async () => {
    const h = harness({ status: null });
    await expect(runWatcherTick(h.client, h.deps)).resolves.toEqual({ ok: true, skipped: 'no status row' });
    expect(h.calls).toHaveLength(1);
  });

  it('logs compact context: ages, probe results, the explorer state and why something was held', async () => {
    const h = harness({ status: { lane_new_drained_at: ago(3), sync_fired_at: ago(120) } });
    await runWatcherTick(h.client, h.deps);
    expect(tickLog()).toEqual({
      actions: [],
      heartbeatAgeMin: 1,
      lastBatchAgeMin: 2,
      due: true,
      enqueueRunning: false,
      explorerCaughtUp: true,
      held: ['sync_gap', 'night_missed'],
    });
  });

  it('logs the explorer state as unknown when the weeks were not read', async () => {
    const h = harness();
    await runWatcherTick(h.client, h.deps);
    expect(tickLog().explorerCaughtUp).toBeNull();
  });
});
