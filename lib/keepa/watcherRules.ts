// lib/keepa/watcherRules.ts
/**
 * Pure decisions for the Keepa service watcher (spec 2026-10-05 §6.2). The cron function
 * (inngest/functions/keepaServiceWatcher.ts) reads the status row, calls this, then performs
 * the actions in order. No I/O here.
 */
import type { KeepaReadSource } from './readSource';

/** The service legitimately writes no heartbeat for up to ~10 minutes while it waits out a rejected Keepa request. */
export const DOWN_AFTER_MS = 15 * 60_000;
export const STALL_AFTER_MS = 2 * 60 * 60_000;
export const RECENT_BATCH_MS = 24 * 60 * 60_000;
/** A drained-lane sync waits until this long after the last sync: a deferral, not a drop (the drain stamp stays newer, so a later tick fires it). */
export const SYNC_MIN_GAP_MS = 6 * 60 * 60_000;
export const NIGHTLY_WINDOW = { hour: 3, fromMinute: 30, toMinute: 44 } as const;

export interface EasternClock {
  hour: number;
  minute: number;
  /** YYYY-MM-DD in America/New_York. */
  dateKey: string;
}

export interface WatcherInput {
  now: Date;
  /** False until the service has ever written its boot id (launch day): nothing has run yet. */
  serviceBooted: boolean;
  /** The weekly enqueue upsert holds the exclusive advisory lock; the service waits on it without heartbeats. */
  enqueueRunning: boolean;
  heartbeatAt: Date | null;
  lastBatchAt: Date | null;
  dueWorkExists: boolean;
  laneNewDrainedAt: Date | null;
  syncFiredAt: Date | null;
  /**
   * The explorer's current week has reached the catalog's scope week (true when either is unknown).
   * The import enqueues a new week before the ~4.5-hour explorer refresh, and the sync job reads the
   * explorer's week itself, so both explorer syncs wait for the refresh to swap the week in.
   */
  explorerCaughtUp: boolean;
  nightlySyncDate: string | null;
  downAlarmSentAt: Date | null;
  stallAlarmSentAt: Date | null;
  readSource: KeepaReadSource;
  et: EasternClock;
}

export type AlarmVariant = 'down' | 'stalled' | 'recovered';
export type StampField = 'down_alarm_sent_at' | 'stall_alarm_sent_at' | 'sync_fired_at' | 'nightly_sync_date';

export type WatcherAction =
  | { kind: 'email'; variant: AlarmVariant }
  | { kind: 'sync'; reason: 'new_lane_drained' | 'nightly' }
  | { kind: 'stamp'; field: StampField; value: Date | string | null };

export function easternClock(now: Date): EasternClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return { hour: Number(get('hour')) % 24, minute: Number(get('minute')), dateKey: `${get('year')}-${get('month')}-${get('day')}` };
}

export function decideWatcherActions(i: WatcherInput): WatcherAction[] {
  // Launch day: the service has never booted, so there is nothing to alarm about and nothing to sync.
  if (!i.serviceBooted) return [];
  const age = (d: Date | null) => (d ? i.now.getTime() - d.getTime() : Number.POSITIVE_INFINITY);

  const emails: AlarmVariant[] = [];
  const stamps: WatcherAction[] = [];
  // While the weekly enqueue holds its lock the service waits on it without heartbeats: no alarm,
  // no recovery, no stamp changes until it lets go.
  if (!i.enqueueRunning) {
    const down = age(i.heartbeatAt) > DOWN_AFTER_MS;
    const stalled = !down && i.dueWorkExists && age(i.lastBatchAt) > STALL_AFTER_MS;

    if (down && !i.downAlarmSentAt) {
      emails.push('down');
      stamps.push({ kind: 'stamp', field: 'down_alarm_sent_at', value: i.now });
    }
    if (!down && i.downAlarmSentAt) {
      emails.push('recovered');
      stamps.push({ kind: 'stamp', field: 'down_alarm_sent_at', value: null });
    }
    if (stalled && !i.stallAlarmSentAt) {
      emails.push('stalled');
      stamps.push({ kind: 'stamp', field: 'stall_alarm_sent_at', value: i.now });
    }
    if (!stalled && !down && i.stallAlarmSentAt) {
      if (!emails.includes('recovered')) emails.push('recovered');
      stamps.push({ kind: 'stamp', field: 'stall_alarm_sent_at', value: null });
    }
  }

  const actions: WatcherAction[] = [...emails.map((variant) => ({ kind: 'email' as const, variant })), ...stamps];

  if (i.readSource === 'products') {
    // The drained-lane waits (six hours since the last sync, the explorer on the scope week) are
    // deferrals: the drain stamp stays newer than sync_fired_at, so a later tick fires the sync. A
    // nightly window while the explorer is still on the previous week is skipped (a pending drain
    // fires after the swap; otherwise the next night syncs).
    if (
      i.laneNewDrainedAt &&
      (!i.syncFiredAt || i.laneNewDrainedAt > i.syncFiredAt) &&
      (!i.syncFiredAt || age(i.syncFiredAt) >= SYNC_MIN_GAP_MS) &&
      i.explorerCaughtUp
    ) {
      actions.push({ kind: 'sync', reason: 'new_lane_drained' }, { kind: 'stamp', field: 'sync_fired_at', value: i.now });
    } else if (
      i.et.hour === NIGHTLY_WINDOW.hour &&
      i.et.minute >= NIGHTLY_WINDOW.fromMinute &&
      i.et.minute <= NIGHTLY_WINDOW.toMinute &&
      age(i.lastBatchAt) <= RECENT_BATCH_MS &&
      i.nightlySyncDate !== i.et.dateKey &&
      i.explorerCaughtUp
    ) {
      actions.push(
        { kind: 'sync', reason: 'nightly' },
        { kind: 'stamp', field: 'nightly_sync_date', value: i.et.dateKey },
        { kind: 'stamp', field: 'sync_fired_at', value: i.now },
      );
    }
  }
  return actions;
}

/**
 * Whether either sync branch above could fire this tick, judged without the explorer and scope
 * weeks: catalog reads on, and a drain newer than the last sync or the nightly window. The watcher
 * reads those weeks only when this is true and passes explorerCaughtUp: true otherwise, which
 * cannot change a decision.
 */
export function syncCouldFire(i: Pick<WatcherInput, 'readSource' | 'laneNewDrainedAt' | 'syncFiredAt' | 'et'>): boolean {
  if (i.readSource !== 'products') return false;
  const drainPending = !!i.laneNewDrainedAt && (!i.syncFiredAt || i.laneNewDrainedAt > i.syncFiredAt);
  const inNightlyWindow =
    i.et.hour === NIGHTLY_WINDOW.hour && i.et.minute >= NIGHTLY_WINDOW.fromMinute && i.et.minute <= NIGHTLY_WINDOW.toMinute;
  return drainPending || inNightlyWindow;
}
