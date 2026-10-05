// lib/keepa/watcherRules.test.ts
import { describe, it, expect } from 'vitest';
import { decideWatcherActions, easternClock, type WatcherInput } from './watcherRules';

const NOW = new Date('2026-10-06T12:00:00Z');
const min = (n: number) => new Date(NOW.getTime() - n * 60_000);
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

describe('decideWatcherActions', () => {
  it('does nothing while the service is healthy', () => {
    expect(decideWatcherActions(base)).toEqual([]);
  });

  it('does nothing before the service has ever booted', () => {
    expect(decideWatcherActions({ ...base, serviceBooted: false, heartbeatAt: min(40), laneNewDrainedAt: min(3) })).toEqual([]);
  });

  it('alarms once when the heartbeat is older than fifteen minutes, then recovers once', () => {
    const down = decideWatcherActions({ ...base, heartbeatAt: min(16) });
    expect(down).toEqual([{ kind: 'email', variant: 'down' }, { kind: 'stamp', field: 'down_alarm_sent_at', value: NOW }]);
    // ~10 minutes of silence while the service waits out a rejected Keepa request is not down.
    expect(decideWatcherActions({ ...base, heartbeatAt: min(14) })).toEqual([]);
    expect(decideWatcherActions({ ...base, heartbeatAt: min(30), downAlarmSentAt: min(19) })).toEqual([]);
    expect(decideWatcherActions({ ...base, downAlarmSentAt: min(19) })).toEqual([
      { kind: 'email', variant: 'recovered' },
      { kind: 'stamp', field: 'down_alarm_sent_at', value: null },
    ]);
  });

  it('a missing heartbeat counts as down', () => {
    expect(decideWatcherActions({ ...base, heartbeatAt: null })[0]).toEqual({ kind: 'email', variant: 'down' });
  });

  it('alarms on a stall: alive, work due, no batch for two hours — never while down, never without due work', () => {
    expect(decideWatcherActions({ ...base, lastBatchAt: min(121) })).toEqual([{ kind: 'email', variant: 'stalled' }, { kind: 'stamp', field: 'stall_alarm_sent_at', value: NOW }]);
    expect(decideWatcherActions({ ...base, lastBatchAt: min(121), dueWorkExists: false })).toEqual([]);
    expect(decideWatcherActions({ ...base, lastBatchAt: min(121), heartbeatAt: min(16) }).map((a) => a.kind === 'email' && a.variant)).toEqual(['down', false]);
    expect(decideWatcherActions({ ...base, stallAlarmSentAt: min(60) })).toEqual([
      { kind: 'email', variant: 'recovered' },
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

  it('fires the nightly sync in the 03:30–03:44 ET window once per date when something was fetched today', () => {
    const night = { ...base, et: { hour: 3, minute: 31, dateKey: '2026-10-06' } };
    expect(decideWatcherActions(night)).toEqual([
      { kind: 'sync', reason: 'nightly' },
      { kind: 'stamp', field: 'nightly_sync_date', value: '2026-10-06' },
      { kind: 'stamp', field: 'sync_fired_at', value: NOW },
    ]);
    expect(decideWatcherActions({ ...night, nightlySyncDate: '2026-10-06' })).toEqual([]);
    expect(decideWatcherActions({ ...night, et: { ...night.et, minute: 45 } })).toEqual([]);
    expect(decideWatcherActions({ ...night, lastBatchAt: min(25 * 60), dueWorkExists: false })).toEqual([]);
  });
});

describe('easternClock', () => {
  it('converts UTC to America/New_York fields', () => {
    expect(easternClock(new Date('2026-10-06T07:31:00Z'))).toEqual({ hour: 3, minute: 31, dateKey: '2026-10-06' });
    expect(easternClock(new Date('2026-10-06T03:10:00Z'))).toEqual({ hour: 23, minute: 10, dateKey: '2026-10-05' });
  });
});
