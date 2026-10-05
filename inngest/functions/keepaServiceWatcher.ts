// inngest/functions/keepaServiceWatcher.ts
/**
 * Keepa service watcher (spec 2026-10-05 §6.2) — every 15 minutes on the Railway worker:
 * down/stall alarms from the status row's heartbeat and last batch, and the explorer aggregate
 * sync when the never-fetched lane drains after an import or nightly from 03:30 ET. All decisions
 * live in lib/keepa/watcherRules.ts; runWatcherTick only reads, decides, and acts (tested with a
 * recording fake client), and the Inngest handler only supplies the client, the clock and the senders.
 */
import { Pool, type PoolClient } from 'pg';
import { inngest } from '../client';
import {
  decideWatcherActions,
  easternClock,
  heldReasons,
  isExplorerCaughtUp,
  lockKeyHalves,
  syncCouldFire,
  type AlarmVariant,
  type StampField,
  type WatcherInput,
} from '@/lib/keepa/watcherRules';
import { keepaReadSource, type KeepaReadSource } from '@/lib/keepa/readSource';
import { ENQUEUE_LOCK_KEY } from '@/lib/keepa/lanes';
import { sendKeepaServiceAlarmEmail } from '@/lib/notifications/sendKeepaServiceAlarmEmail';

interface StatusRow {
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

const STAMP_SQL: Record<StampField, string> = {
  down_alarm_sent_at: 'UPDATE keepa_service_status SET down_alarm_sent_at = $1 WHERE singleton',
  stall_alarm_sent_at: 'UPDATE keepa_service_status SET stall_alarm_sent_at = $1 WHERE singleton',
  sync_fired_at: 'UPDATE keepa_service_status SET sync_fired_at = $1 WHERE singleton',
  nightly_sync_date: 'UPDATE keepa_service_status SET nightly_sync_date = $1 WHERE singleton',
};

export interface WatcherTickDeps {
  now: Date;
  readSource: KeepaReadSource;
  sendAlarm: typeof sendKeepaServiceAlarmEmail;
  sendEvent: (name: string, data: Record<string, unknown>) => Promise<unknown>;
}

export type WatcherTickResult = { ok: true; skipped: 'no status row' } | { ok: true; actions: string[] };

type Queryable = Pick<PoolClient, 'query'>;

async function readWeeks(client: Queryable): Promise<{ scope: string | null; kcs: string | null }> {
  const { rows } = await client.query<{ scope_week: string | null; kcs_week: string | null }>(
    `SELECT (SELECT max(scope_week)::text FROM asin_products) AS scope_week,
            (SELECT current_week_end_date::text FROM keyword_current_summary_meta WHERE singleton = true) AS kcs_week`,
  );
  return { scope: rows[0]?.scope_week ?? null, kcs: rows[0]?.kcs_week ?? null };
}

/** One watcher tick on a checked-out client: read the status, decide (lib/keepa/watcherRules.ts), act. */
export async function runWatcherTick(client: Queryable, deps: WatcherTickDeps): Promise<WatcherTickResult> {
  const { now, readSource } = deps;
  const { rows } = await client.query<StatusRow>(
    `SELECT boot_id, heartbeat_at, last_batch_at, tail_enabled, lane_new_drained_at, sync_fired_at,
            nightly_sync_date::text AS nightly_sync_date, down_alarm_sent_at, stall_alarm_sent_at
     FROM keepa_service_status WHERE singleton`,
  );
  const s = rows[0];
  if (!s) return { ok: true, skipped: 'no status row' };
  // One EXISTS per lane, each carrying its partial index's literal predicate (never fetched /
  // fetched before), so both probes are index lookups rather than a catalog scan. Work counts as
  // due only once it has been due for five minutes: a tick landing between "the first row came
  // due" and the service's next claim must not read as a stall.
  const { rows: due } = await client.query<{ due: boolean }>(
    `SELECT (
       EXISTS (SELECT 1 FROM asin_products
               WHERE in_scope AND claimed_at IS NULL AND last_fetched_at IS NULL
                 AND next_due_at <= now() - interval '5 minutes' AND (tier = 1 OR $1::boolean))
       OR EXISTS (SELECT 1 FROM asin_products
               WHERE in_scope AND claimed_at IS NULL AND last_fetched_at IS NOT NULL
                 AND next_due_at <= now() - interval '5 minutes' AND (tier = 1 OR $1::boolean))
     ) AS due`,
    [s.tail_enabled],
  );
  const dueWorkExists = due[0]?.due ?? false;
  // Is the weekly enqueue upsert holding ENQUEUE_LOCK_KEY exclusively? The rules suppress alarms
  // meanwhile as extra caution: the service's heartbeat ticker keeps beating while its batch writes
  // wait on the lock. pg_locks is server-wide (this works through Neon's pooler), hence the
  // database filter.
  const { rows: lock } = await client.query<{ running: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_locks
       WHERE locktype = 'advisory' AND classid = $1::oid AND objid = $2::oid AND objsubid = 1
         AND mode = 'ExclusiveLock' AND granted
         AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
     ) AS running`,
    lockKeyHalves(ENQUEUE_LOCK_KEY),
  );
  const enqueueRunning = lock[0]?.running ?? false;
  const et = easternClock(now);
  // The scope/explorer weeks matter only to the two sync branches, so they are read only when a
  // sync could fire this tick. Unread weeks count as unknown, which holds every sync — harmless,
  // since no sync could fire then. The import enqueues a new week before the ~4.5-hour explorer
  // refresh, and the sync job syncs whatever week the explorer is on, so a sync waits for the swap.
  const weeks = syncCouldFire({ readSource, laneNewDrainedAt: s.lane_new_drained_at, syncFiredAt: s.sync_fired_at, et }) ? await readWeeks(client) : null;
  const explorerCaughtUp = weeks !== null && isExplorerCaughtUp(weeks.scope, weeks.kcs);
  const input: WatcherInput = {
    now,
    serviceBooted: s.boot_id !== null,
    enqueueRunning,
    heartbeatAt: s.heartbeat_at,
    lastBatchAt: s.last_batch_at,
    dueWorkExists,
    laneNewDrainedAt: s.lane_new_drained_at,
    syncFiredAt: s.sync_fired_at,
    explorerCaughtUp,
    nightlySyncDate: s.nightly_sync_date,
    downAlarmSentAt: s.down_alarm_sent_at,
    stallAlarmSentAt: s.stall_alarm_sent_at,
    readSource,
    et,
  };
  const delivered = new Set<AlarmVariant>();
  const summary: string[] = [];
  for (const a of decideWatcherActions(input)) {
    if (a.kind === 'email') {
      const sent = await deps.sendAlarm({ variant: a.variant, heartbeatAt: s.heartbeat_at, lastBatchAt: s.last_batch_at });
      if (sent) delivered.add(a.variant);
      summary.push(sent ? `email:${a.variant}` : `email:${a.variant}:unsent`);
    } else if (a.kind === 'sync') {
      // Unreachable without a known explorer week: isExplorerCaughtUp holds every sync until then.
      if (!weeks?.kcs) throw new Error('keepa_watcher_sync_without_week');
      await deps.sendEvent('keepa/aggregates-sync-requested', { weekEndDate: weeks.kcs });
      summary.push(`sync:${a.reason}`);
    } else {
      // A stamp tied to an email (onlyIfSent) is written only once Resend accepted that email: a
      // failed send leaves the row as it was, so the next tick retries. Untied stamps never wait.
      if (a.onlyIfSent && !delivered.has(a.onlyIfSent)) {
        summary.push(`stamp:${a.field}:skipped`);
        continue;
      }
      await client.query(STAMP_SQL[a.field], [a.value]);
      summary.push(`stamp:${a.field}`);
    }
  }
  const minutesAgo = (d: Date | null) => (d ? Math.round((now.getTime() - d.getTime()) / 60_000) : null);
  console.log(
    `[keepa-watcher] ${JSON.stringify({
      actions: summary,
      heartbeatAgeMin: minutesAgo(s.heartbeat_at),
      lastBatchAgeMin: minutesAgo(s.last_batch_at),
      due: dueWorkExists,
      enqueueRunning,
      explorerCaughtUp: weeks ? explorerCaughtUp : null,
      held: heldReasons(input),
    })}`,
  );
  return { ok: true, actions: summary };
}

export const keepaServiceWatcherFn = inngest.createFunction(
  {
    id: 'keepa-service-watcher',
    name: 'Keepa service watcher (alarms + explorer sync)',
    retries: 0,
    concurrency: { limit: 1 },
    triggers: [{ cron: '*/15 * * * *' }],
  },
  async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 30_000, statement_timeout: 60_000 });
    // Dropped-socket guards: pg-pool re-emits an idle client's 'error' on the pool but unhooks its
    // listener at checkout, and an unhandled 'error' crashes the worker; the failed query still rejects.
    pool.on('error', () => undefined);
    try {
      const c = await pool.connect();
      c.on('error', () => undefined);
      try {
        // `return await`: the client must stay checked out until the tick has finished.
        return await runWatcherTick(c, {
          now: new Date(),
          readSource: keepaReadSource(),
          sendAlarm: sendKeepaServiceAlarmEmail,
          sendEvent: (name, data) => inngest.send({ name, data }),
        });
      } finally {
        c.release();
      }
    } finally {
      await pool.end();
    }
  },
);
