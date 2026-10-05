// lib/keepa/watcherRules.test.ts
import { describe, it, expect } from 'vitest';
import {
  decideWatcherActions,
  drainPending,
  easternClock,
  heldReasons,
  inNightlyWindow,
  isExplorerCaughtUp,
  lockKeyHalves,
  syncCouldFire,
  type EasternClock,
  type WatcherInput,
} from './watcherRules';
import { ENQUEUE_LOCK_KEY } from './lanes';

const NOW = new Date('2026-10-06T12:00:00Z');
const min = (n: number) => new Date(NOW.getTime() - n * 60_000);
const NIGHT: EasternClock = { hour: 3, minute: 31, dateKey: '2026-10-06' };
const base: WatcherInput = {
  now: NOW,
  serviceBooted: true,
  enqueueRunning: false,
  heartbeatAt: min(1),
  lastBatchAt: min(2),
  dueWorkExists: true,
  laneNewDrainedAt: null,
  syncFiredAt: null,
  explorerCaughtUp: true,
  nightlySyncDate: null,
  downAlarmSentAt: null,
  stallAlarmSentAt: null,
  readSource: 'products',
  et: { hour: 8, minute: 0, dateKey: '2026-10-06' },
};
const nightlySync = [
  { kind: 'sync', reason: 'nightly' },
  { kind: 'stamp', field: 'nightly_sync_date', value: '2026-10-06' },
  { kind: 'stamp', field: 'sync_fired_at', value: NOW },
];

/** The base input at another instant: the clock agrees with `now`; the heartbeat and last batch stay fresh. */
function atInstant(iso: string): WatcherInput {
  const now = new Date(iso);
  return { ...base, now, heartbeatAt: new Date(now.getTime() - 60_000), lastBatchAt: new Date(now.getTime() - 120_000), et: easternClock(now) };
}

describe('decideWatcherActions', () => {
  it('does nothing while the service is healthy', () => {
    expect(decideWatcherActions(base)).toEqual([]);
  });

  it('does nothing before the service has ever booted', () => {
    expect(decideWatcherActions({ ...base, serviceBooted: false, heartbeatAt: min(40), laneNewDrainedAt: min(3) })).toEqual([]);
  });

  it('alarms once when the heartbeat is older than fifteen minutes, then recovers once', () => {
    const down = decideWatcherActions({ ...base, heartbeatAt: min(16) });
    expect(down).toEqual([{ kind: 'email', variant: 'down' }, { kind: 'stamp', field: 'down_alarm_sent_at', value: NOW, onlyIfSent: 'down' }]);
    // Still inside the fifteen-minute threshold: not down yet.
    expect(decideWatcherActions({ ...base, heartbeatAt: min(14) })).toEqual([]);
    expect(decideWatcherActions({ ...base, heartbeatAt: min(30), downAlarmSentAt: min(19) })).toEqual([]);
    // A plain recovery clears the stamp whether or not the email goes out.
    expect(decideWatcherActions({ ...base, downAlarmSentAt: min(19) })).toEqual([
      { kind: 'email', variant: 'recovered' },
      { kind: 'stamp', field: 'down_alarm_sent_at', value: null },
    ]);
  });

  it('a missing heartbeat counts as down', () => {
    expect(decideWatcherActions({ ...base, heartbeatAt: null })[0]).toEqual({ kind: 'email', variant: 'down' });
  });

  it('alarms on a stall: alive, work due, no batch for two hours — never while down, never without due work', () => {
    expect(decideWatcherActions({ ...base, lastBatchAt: min(121) })).toEqual([
      { kind: 'email', variant: 'stalled' },
      { kind: 'stamp', field: 'stall_alarm_sent_at', value: NOW, onlyIfSent: 'stalled' },
    ]);
    expect(decideWatcherActions({ ...base, lastBatchAt: min(121), dueWorkExists: false })).toEqual([]);
    expect(decideWatcherActions({ ...base, lastBatchAt: min(121), heartbeatAt: min(16) }).map((a) => a.kind === 'email' && a.variant)).toEqual(['down', false]);
    expect(decideWatcherActions({ ...base, stallAlarmSentAt: min(60) })).toEqual([
      { kind: 'email', variant: 'recovered' },
      { kind: 'stamp', field: 'stall_alarm_sent_at', value: null },
    ]);
  });

  it('a down alarm that clears into an ongoing stall reports the stall, never "recovered"', () => {
    // The stall alarm went out; then the service went down; then it came back with still no batch.
    const stalledOut = { ...base, lastBatchAt: min(180), stallAlarmSentAt: min(60) };
    expect(decideWatcherActions(stalledOut)).toEqual([]);
    expect(decideWatcherActions({ ...stalledOut, heartbeatAt: min(20) })).toEqual([
      { kind: 'email', variant: 'down' },
      { kind: 'stamp', field: 'down_alarm_sent_at', value: NOW, onlyIfSent: 'down' },
    ]);
    // The down alarm clears only once the stall update went out (a failed send is retried next tick).
    expect(decideWatcherActions({ ...stalledOut, downAlarmSentAt: min(10) })).toEqual([
      { kind: 'email', variant: 'stalled' },
      { kind: 'stamp', field: 'down_alarm_sent_at', value: null, onlyIfSent: 'stalled' },
    ]);
  });

  it('back after a long outage with work due and no batch since: the stall only, not "recovered" too', () => {
    expect(decideWatcherActions({ ...base, lastBatchAt: min(5 * 60), downAlarmSentAt: min(4 * 60) })).toEqual([
      { kind: 'email', variant: 'stalled' },
      { kind: 'stamp', field: 'down_alarm_sent_at', value: null, onlyIfSent: 'stalled' },
      { kind: 'stamp', field: 'stall_alarm_sent_at', value: NOW, onlyIfSent: 'stalled' },
    ]);
  });

  it('both alarms cleared at once: exactly one "recovered" and both stamps cleared', () => {
    expect(decideWatcherActions({ ...base, downAlarmSentAt: min(60), stallAlarmSentAt: min(120) })).toEqual([
      { kind: 'email', variant: 'recovered' },
      { kind: 'stamp', field: 'down_alarm_sent_at', value: null },
      { kind: 'stamp', field: 'stall_alarm_sent_at', value: null },
    ]);
  });

  it('skips alarms while the weekly enqueue holds the lock', () => {
    expect(decideWatcherActions({ ...base, enqueueRunning: true, heartbeatAt: min(40) })).toEqual([]);
    expect(decideWatcherActions({ ...base, enqueueRunning: true, downAlarmSentAt: min(19) })).toEqual([]);
    expect(decideWatcherActions({ ...base, enqueueRunning: true, heartbeatAt: min(40), laneNewDrainedAt: min(3) })).toEqual([
      { kind: 'sync', reason: 'new_lane_drained' },
      { kind: 'stamp', field: 'sync_fired_at', value: NOW },
    ]);
  });

  it('fires the explorer sync once per drained new lane, only when the app reads the catalog', () => {
    const drained = { ...base, laneNewDrainedAt: min(3) };
    expect(decideWatcherActions(drained)).toEqual([{ kind: 'sync', reason: 'new_lane_drained' }, { kind: 'stamp', field: 'sync_fired_at', value: NOW }]);
    expect(decideWatcherActions({ ...drained, syncFiredAt: min(2) })).toEqual([]);
    expect(decideWatcherActions({ ...drained, readSource: 'weekly' })).toEqual([]);
  });

  it('defers the drained-lane sync until six hours after the last sync', () => {
    const drained = { ...base, laneNewDrainedAt: min(3) };
    expect(decideWatcherActions({ ...drained, syncFiredAt: min(120) })).toEqual([]);
    expect(decideWatcherActions({ ...drained, syncFiredAt: min(7 * 60) })).toEqual([
      { kind: 'sync', reason: 'new_lane_drained' },
      { kind: 'stamp', field: 'sync_fired_at', value: NOW },
    ]);
  });

  it('defers the drained-lane sync while the explorer is still on the previous week', () => {
    const drained = { ...base, laneNewDrainedAt: min(3) };
    expect(decideWatcherActions({ ...drained, explorerCaughtUp: false })).toEqual([]);
    expect(decideWatcherActions({ ...drained, explorerCaughtUp: true })).toEqual([
      { kind: 'sync', reason: 'new_lane_drained' },
      { kind: 'stamp', field: 'sync_fired_at', value: NOW },
    ]);
  });

  it('fires the nightly sync in the 03:30–05:59 ET window once per date when something was fetched today', () => {
    const night = { ...base, et: NIGHT };
    expect(decideWatcherActions(night)).toEqual(nightlySync);
    expect(decideWatcherActions({ ...night, nightlySyncDate: '2026-10-06' })).toEqual([]);
    expect(decideWatcherActions({ ...night, et: { ...NIGHT, minute: 29 } })).toEqual([]);
    expect(decideWatcherActions({ ...night, et: { ...NIGHT, hour: 6, minute: 0 } })).toEqual([]);
    expect(decideWatcherActions({ ...night, lastBatchAt: min(25 * 60), dueWorkExists: false })).toEqual([]);
  });

  it('a missed 03:30 tick does not skip the night: any tick until 05:59 ET fires it', () => {
    expect(decideWatcherActions({ ...base, et: { ...NIGHT, hour: 5, minute: 59 } })).toEqual(nightlySync);
  });

  it("a recent sync whose six-hour gap cannot close inside the window counts as the night's: the date is stamped, no second sync", () => {
    // 03:31 ET, synced at 01:31 ET: the gap closes at 07:31, after the window.
    const at0331 = { ...atInstant('2026-10-06T07:31:00Z'), syncFiredAt: new Date('2026-10-06T05:31:00Z') };
    expect(decideWatcherActions(at0331)).toEqual([{ kind: 'stamp', field: 'nightly_sync_date', value: '2026-10-06' }]);
    expect(heldReasons(at0331)).toEqual([]);
  });

  it('a recent sync holds the night until its gap closes, when that happens by 05:59 ET', () => {
    const drainedSyncAt = new Date('2026-10-06T02:00:00Z'); // 22:00 ET the evening before
    const at0330 = { ...atInstant('2026-10-06T07:30:00Z'), syncFiredAt: drainedSyncAt };
    expect(decideWatcherActions(at0330)).toEqual([]);
    expect(heldReasons(at0330)).toEqual(['sync_gap']);
    const at0400 = { ...atInstant('2026-10-06T08:00:00Z'), syncFiredAt: drainedSyncAt };
    expect(decideWatcherActions(at0400)).toEqual([
      { kind: 'sync', reason: 'nightly' },
      { kind: 'stamp', field: 'nightly_sync_date', value: '2026-10-06' },
      { kind: 'stamp', field: 'sync_fired_at', value: at0400.now },
    ]);
    // The boundary at 03:30: a gap closing at 05:59 still holds; one closing at 06:00 stamps the date.
    const minutesBefore = (n: number) => new Date(at0330.now.getTime() - n * 60_000);
    expect(decideWatcherActions({ ...at0330, syncFiredAt: minutesBefore(211) })).toEqual([]);
    expect(decideWatcherActions({ ...at0330, syncFiredAt: minutesBefore(210) })).toEqual([
      { kind: 'stamp', field: 'nightly_sync_date', value: '2026-10-06' },
    ]);
  });

  it('skips the nightly sync while the explorer is still on the previous week', () => {
    const night = { ...base, et: NIGHT };
    expect(decideWatcherActions({ ...night, explorerCaughtUp: false })).toEqual([]);
    // A drain pending in the window mid-refresh is held too; it fires after the swap.
    expect(decideWatcherActions({ ...night, explorerCaughtUp: false, laneNewDrainedAt: min(3) })).toEqual([]);
  });
});

describe('isExplorerCaughtUp', () => {
  it('holds while the explorer week is unknown or behind; an empty catalog has nothing to wait for', () => {
    expect(isExplorerCaughtUp('2026-10-03', '2026-10-03')).toBe(true);
    expect(isExplorerCaughtUp('2026-10-03', '2026-10-10')).toBe(true);
    expect(isExplorerCaughtUp('2026-10-03', '2026-09-26')).toBe(false);
    expect(isExplorerCaughtUp('2026-10-03', null)).toBe(false);
    expect(isExplorerCaughtUp(null, '2026-10-03')).toBe(true);
    expect(isExplorerCaughtUp(null, null)).toBe(false);
  });
});

describe('lockKeyHalves', () => {
  it('splits a bigint advisory-lock key the way pg_locks shows it', () => {
    expect(lockKeyHalves(ENQUEUE_LOCK_KEY)).toEqual([0, 20261005]);
    expect(lockKeyHalves(2 ** 32 + 5)).toEqual([1, 5]);
  });
});

describe('drainPending and inNightlyWindow', () => {
  it('a drain is pending only when it is newer than the last sync', () => {
    expect(drainPending({ laneNewDrainedAt: null, syncFiredAt: null })).toBe(false);
    expect(drainPending({ laneNewDrainedAt: min(3), syncFiredAt: null })).toBe(true);
    expect(drainPending({ laneNewDrainedAt: min(3), syncFiredAt: min(10) })).toBe(true);
    expect(drainPending({ laneNewDrainedAt: min(3), syncFiredAt: min(2) })).toBe(false);
  });

  it('the window runs from 03:30 through 05:59 ET', () => {
    expect(inNightlyWindow({ ...NIGHT, hour: 3, minute: 29 })).toBe(false);
    expect(inNightlyWindow({ ...NIGHT, hour: 3, minute: 30 })).toBe(true);
    expect(inNightlyWindow({ ...NIGHT, hour: 5, minute: 59 })).toBe(true);
    expect(inNightlyWindow({ ...NIGHT, hour: 6, minute: 0 })).toBe(false);
  });
});

describe('syncCouldFire', () => {
  it('is true only with catalog reads and either a drain newer than the last sync or the nightly window', () => {
    expect(syncCouldFire(base)).toBe(false);
    expect(syncCouldFire({ ...base, laneNewDrainedAt: min(3) })).toBe(true);
    expect(syncCouldFire({ ...base, laneNewDrainedAt: min(3), syncFiredAt: min(2) })).toBe(false);
    expect(syncCouldFire({ ...base, et: NIGHT })).toBe(true);
    expect(syncCouldFire({ ...base, et: { ...NIGHT, hour: 6, minute: 0 } })).toBe(false);
    expect(syncCouldFire({ ...base, readSource: 'weekly', laneNewDrainedAt: min(3), et: NIGHT })).toBe(false);
  });

  it('when false, the explorer week cannot change a decision, so the watcher may skip reading it', () => {
    const grid = (['products', 'weekly'] as const).flatMap((readSource) =>
      [null, min(3), min(500)].flatMap((laneNewDrainedAt) =>
        [null, min(2), min(120), min(7 * 60)].flatMap((syncFiredAt) =>
          [base.et, NIGHT, { ...NIGHT, hour: 5, minute: 59 }, { ...NIGHT, hour: 6, minute: 0 }].flatMap((et) =>
            [null, NIGHT.dateKey].flatMap((nightlySyncDate) =>
              [min(2), min(25 * 60)].map((lastBatchAt): WatcherInput => ({ ...base, readSource, laneNewDrainedAt, syncFiredAt, et, nightlySyncDate, lastBatchAt })),
            ),
          ),
        ),
      ),
    );
    let differing = 0;
    for (const i of grid) {
      const behind = decideWatcherActions({ ...i, explorerCaughtUp: false });
      const caughtUp = decideWatcherActions({ ...i, explorerCaughtUp: true });
      if (!syncCouldFire(i)) expect(behind, JSON.stringify(i)).toEqual(caughtUp);
      else if (JSON.stringify(behind) !== JSON.stringify(caughtUp)) differing += 1;
    }
    expect(differing).toBeGreaterThan(0);
  });
});

describe('heldReasons', () => {
  // Tonight's sync already ran, so the night adds no reason unless a case asks for one.
  const done = { ...base, nightlySyncDate: base.et.dateKey };

  it('names suppressed alarms', () => {
    expect(heldReasons({ ...done, serviceBooted: false, laneNewDrainedAt: min(3) })).toEqual(['not_booted']);
    expect(heldReasons({ ...done, enqueueRunning: true })).toEqual(['enqueue_running']);
  });

  it("names why a pending drain or tonight's sync was not sent", () => {
    expect(heldReasons(done)).toEqual([]);
    expect(heldReasons({ ...done, laneNewDrainedAt: min(3), syncFiredAt: min(120) })).toEqual(['sync_gap']);
    expect(heldReasons({ ...done, laneNewDrainedAt: min(3), explorerCaughtUp: false })).toEqual(['explorer_behind']);
    // Owed but before the window: nothing to report yet.
    expect(heldReasons({ ...base, et: { ...NIGHT, hour: 2, minute: 0 } })).toEqual([]);
    // Owed once the window has closed: the night was missed.
    expect(heldReasons(base)).toEqual(['night_missed']);
    expect(heldReasons({ ...base, et: NIGHT, explorerCaughtUp: false })).toEqual(['explorer_behind']);
    expect(heldReasons({ ...base, et: NIGHT })).toEqual([]);
    expect(heldReasons({ ...base, readSource: 'weekly' })).toEqual([]);
  });
});

describe('easternClock', () => {
  it('converts UTC to America/New_York fields', () => {
    expect(easternClock(new Date('2026-10-06T07:31:00Z'))).toEqual({ hour: 3, minute: 31, dateKey: '2026-10-06' });
    expect(easternClock(new Date('2026-10-06T03:10:00Z'))).toEqual({ hour: 23, minute: 10, dateKey: '2026-10-05' });
    // January is EST (UTC−5), not EDT.
    expect(easternClock(new Date('2026-01-15T08:31:00Z'))).toEqual({ hour: 3, minute: 31, dateKey: '2026-01-15' });
  });
});
