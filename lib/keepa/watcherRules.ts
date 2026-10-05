// lib/keepa/watcherRules.ts
/**
 * Pure decisions for the Keepa service watcher (spec 2026-10-05 §6.2). The cron function
 * (inngest/functions/keepaServiceWatcher.ts) reads the status row, calls this, then performs
 * the actions in order. No I/O here.
 */
import type { KeepaReadSource } from './readSource';

/**
 * The service's independent heartbeat ticker (startHeartbeat in services/keepa/loop.ts) beats every
 * minute, through enqueue-lock and Keepa waits, so a stale heartbeat means the process or its
 * database connection is gone. Fifteen minutes is extra caution on top of that ticker.
 */
export const DOWN_AFTER_MS = 15 * 60_000;
export const STALL_AFTER_MS = 2 * 60 * 60_000;
export const RECENT_BATCH_MS = 24 * 60 * 60_000;
/** A drained-lane sync waits until this long after the last sync: a deferral, not a drop (the drain stamp stays newer, so a later tick fires it). */
export const SYNC_MIN_GAP_MS = 6 * 60 * 60_000;
/**
 * The nightly sync's window in ET minutes of the day, 03:30 through 05:59: wide enough that a missed
 * tick does not skip the night. nightly_sync_date keeps it to once per ET date.
 */
export const NIGHTLY_WINDOW = { fromMinute: 3 * 60 + 30, toMinute: 5 * 60 + 59 } as const;

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
  /**
   * The weekly enqueue upsert holds the exclusive advisory lock. The service's heartbeat ticker keeps
   * beating while its batch writes wait on it, so suppressing alarms meanwhile is extra caution.
   */
  enqueueRunning: boolean;
  heartbeatAt: Date | null;
  lastBatchAt: Date | null;
  dueWorkExists: boolean;
  laneNewDrainedAt: Date | null;
  syncFiredAt: Date | null;
  /**
   * The explorer's week is known and has reached the catalog's scope week (isExplorerCaughtUp).
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
  /** `onlyIfSent`: write the stamp only once this tick's email of that variant was delivered, so a failed send is retried next tick. */
  | { kind: 'stamp'; field: StampField; value: Date | string | null; onlyIfSent?: AlarmVariant };

/** Why a tick held something back, for the tick log (see heldReasons). */
export type HeldReason = 'not_booted' | 'enqueue_running' | 'explorer_behind' | 'sync_gap' | 'night_missed';

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

/** A non-negative bigint advisory-lock key as pg_locks shows it: the high 32 bits in classid, the low 32 bits in objid (objsubid = 1). */
export function lockKeyHalves(key: number): [classid: number, objid: number] {
  const k = BigInt(key);
  return [Number(k >> BigInt(32)), Number(k & BigInt(0xffffffff))];
}

/**
 * The explorer has reached the catalog's scope week. An unknown explorer week holds the sync (that
 * week is what the sync job would sync); a catalog without a scope week has nothing to wait for.
 * ISO dates compare correctly as text.
 */
export function isExplorerCaughtUp(scopeWeek: string | null, kcsWeek: string | null): boolean {
  return kcsWeek !== null && (scopeWeek === null || kcsWeek >= scopeWeek);
}

/** The never-fetched lane drained after the last sync. */
export function drainPending(i: Pick<WatcherInput, 'laneNewDrainedAt' | 'syncFiredAt'>): boolean {
  return !!i.laneNewDrainedAt && (!i.syncFiredAt || i.laneNewDrainedAt > i.syncFiredAt);
}

function minuteOfDay(et: EasternClock): number {
  return et.hour * 60 + et.minute;
}

export function inNightlyWindow(et: EasternClock): boolean {
  const m = minuteOfDay(et);
  return m >= NIGHTLY_WINDOW.fromMinute && m <= NIGHTLY_WINDOW.toMinute;
}

function ageMs(now: Date, d: Date | null): number {
  return d ? now.getTime() - d.getTime() : Number.POSITIVE_INFINITY;
}

/** Whole minutes until the six-hour gap since the last sync closes; 0 once it has, or before any sync. */
function gapMinutesLeft(i: Pick<WatcherInput, 'now' | 'syncFiredAt'>): number {
  if (!i.syncFiredAt) return 0;
  const leftMs = SYNC_MIN_GAP_MS - ageMs(i.now, i.syncFiredAt);
  return leftMs > 0 ? Math.ceil(leftMs / 60_000) : 0;
}

/** The last sync is under SYNC_MIN_GAP_MS old. */
function syncGapOpen(i: Pick<WatcherInput, 'now' | 'syncFiredAt'>): boolean {
  return gapMinutesLeft(i) > 0;
}

/** The gap closes by 05:59 ET, so a later tick in tonight's window can still sync. */
function gapClosesInWindow(i: Pick<WatcherInput, 'now' | 'syncFiredAt' | 'et'>): boolean {
  return minuteOfDay(i.et) + gapMinutesLeft(i) <= NIGHTLY_WINDOW.toMinute;
}

/** Tonight's sync is still owed: something was fetched in the last day and today's date is not stamped. */
function nightlyOwed(i: Pick<WatcherInput, 'now' | 'lastBatchAt' | 'nightlySyncDate' | 'et'>): boolean {
  return ageMs(i.now, i.lastBatchAt) <= RECENT_BATCH_MS && i.nightlySyncDate !== i.et.dateKey;
}

export function decideWatcherActions(i: WatcherInput): WatcherAction[] {
  // Launch day: the service has never booted, so there is nothing to alarm about and nothing to sync.
  if (!i.serviceBooted) return [];
  const age = (d: Date | null) => ageMs(i.now, d);

  const emails: AlarmVariant[] = [];
  const stamps: WatcherAction[] = [];
  // While the weekly enqueue holds its lock: no alarm, no recovery, no stamp changes until it lets
  // go. Extra caution on top of the service's independent heartbeat ticker, which keeps beating.
  if (!i.enqueueRunning) {
    const down = age(i.heartbeatAt) > DOWN_AFTER_MS;
    const stalled = !down && i.dueWorkExists && age(i.lastBatchAt) > STALL_AFTER_MS;
    // Back up after a down alarm. If a stall is still on, the stall is what gets reported, never "recovered".
    const backUp = !down && !!i.downAlarmSentAt;
    if (down && !i.downAlarmSentAt) {
      emails.push('down');
      stamps.push({ kind: 'stamp', field: 'down_alarm_sent_at', value: i.now, onlyIfSent: 'down' });
    }
    if (backUp) {
      // Into an ongoing stall the down alarm clears only once the stall update went out; a plain
      // recovery clears it regardless.
      stamps.push(
        stalled
          ? { kind: 'stamp', field: 'down_alarm_sent_at', value: null, onlyIfSent: 'stalled' }
          : { kind: 'stamp', field: 'down_alarm_sent_at', value: null },
      );
    }
    if (stalled && (!i.stallAlarmSentAt || backUp)) {
      emails.push('stalled');
      if (!i.stallAlarmSentAt) stamps.push({ kind: 'stamp', field: 'stall_alarm_sent_at', value: i.now, onlyIfSent: 'stalled' });
    }
    if (!down && !stalled && (backUp || i.stallAlarmSentAt)) {
      emails.push('recovered');
      if (i.stallAlarmSentAt) stamps.push({ kind: 'stamp', field: 'stall_alarm_sent_at', value: null });
    }
  }

  const actions: WatcherAction[] = [...emails.map((variant) => ({ kind: 'email' as const, variant })), ...stamps];

  if (i.readSource === 'products') {
    // The drained-lane waits (six hours since the last sync, the explorer on the scope week) are
    // deferrals: the drain stamp stays newer than sync_fired_at, so a later tick fires the sync. A
    // night whose window passes while the explorer is still on the previous week is skipped (a
    // pending drain fires after the swap; otherwise the next night syncs).
    if (drainPending(i) && !syncGapOpen(i) && i.explorerCaughtUp) {
      actions.push({ kind: 'sync', reason: 'new_lane_drained' }, { kind: 'stamp', field: 'sync_fired_at', value: i.now });
    } else if (inNightlyWindow(i.et) && nightlyOwed(i) && i.explorerCaughtUp) {
      if (!syncGapOpen(i)) {
        actions.push(
          { kind: 'sync', reason: 'nightly' },
          { kind: 'stamp', field: 'nightly_sync_date', value: i.et.dateKey },
          { kind: 'stamp', field: 'sync_fired_at', value: i.now },
        );
      } else if (!gapClosesInWindow(i)) {
        // A recent sync whose gap cannot close inside the window counts as tonight's: record the
        // date without a second sync.
        actions.push({ kind: 'stamp', field: 'nightly_sync_date', value: i.et.dateKey });
      }
      // Otherwise hold: a later tick in the window syncs once the gap has closed.
    }
  }
  return actions;
}

/**
 * Whether either sync branch above could fire this tick, judged without the explorer and scope
 * weeks: catalog reads on, and a drain newer than the last sync or the nightly window. The watcher
 * reads those weeks only when this is true; otherwise the explorerCaughtUp it passes cannot change
 * a decision.
 */
export function syncCouldFire(i: Pick<WatcherInput, 'readSource' | 'laneNewDrainedAt' | 'syncFiredAt' | 'et'>): boolean {
  return i.readSource === 'products' && (drainPending(i) || inNightlyWindow(i.et));
}

/**
 * Why this tick held something back — for the tick log only; decideWatcherActions decides. Alarms
 * suppressed: not_booted, enqueue_running. A pending drain not synced: sync_gap (under six hours
 * since the last sync) and/or explorer_behind. Tonight's sync owed: nothing before 03:30 ET; inside
 * the window, explorer_behind, or sync_gap (a recent sync's gap closes later in the window); after
 * 05:59 with the date still unstamped, night_missed.
 */
export function heldReasons(i: WatcherInput): HeldReason[] {
  if (!i.serviceBooted) return ['not_booted'];
  const held = new Set<HeldReason>();
  if (i.enqueueRunning) held.add('enqueue_running');
  if (i.readSource === 'products') {
    if (drainPending(i)) {
      if (syncGapOpen(i)) held.add('sync_gap');
      if (!i.explorerCaughtUp) held.add('explorer_behind');
    }
    if (nightlyOwed(i)) {
      const m = minuteOfDay(i.et);
      if (m > NIGHTLY_WINDOW.toMinute) held.add('night_missed');
      else if (m >= NIGHTLY_WINDOW.fromMinute) {
        if (!i.explorerCaughtUp) held.add('explorer_behind');
        else if (syncGapOpen(i) && gapClosesInWindow(i)) held.add('sync_gap');
      }
    }
  }
  return [...held];
}
