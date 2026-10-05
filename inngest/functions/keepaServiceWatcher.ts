// inngest/functions/keepaServiceWatcher.ts
/**
 * Keepa service watcher (spec 2026-10-05 §6.2) — every 15 minutes on the Railway worker:
 * down/stall alarms from the status row's heartbeat and last batch, and the explorer aggregate
 * sync when the never-fetched lane drains after an import or nightly at 03:30 ET. All decisions
 * live in lib/keepa/watcherRules.ts; this function only reads, decides, and acts.
 */
import { Pool } from 'pg';
import { inngest } from '../client';
import { decideWatcherActions, easternClock, syncCouldFire, type StampField } from '@/lib/keepa/watcherRules';
import { keepaReadSource } from '@/lib/keepa/readSource';
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
    try {
      const c = await pool.connect();
      try {
        const { rows } = await c.query<StatusRow>(
          `SELECT boot_id, heartbeat_at, last_batch_at, tail_enabled, lane_new_drained_at, sync_fired_at,
                  nightly_sync_date::text AS nightly_sync_date, down_alarm_sent_at, stall_alarm_sent_at
           FROM keepa_service_status WHERE singleton`,
        );
        const s = rows[0];
        if (!s) return { ok: true, skipped: 'no status row' };
        // One EXISTS per lane, each carrying its partial index's literal predicate (never fetched /
        // fetched before), so both probes are index lookups rather than a catalog scan.
        const { rows: due } = await c.query<{ due: boolean }>(
          `SELECT (
             EXISTS (SELECT 1 FROM asin_products
                     WHERE in_scope AND claimed_at IS NULL AND last_fetched_at IS NULL
                       AND next_due_at <= now() AND (tier = 1 OR $1::boolean))
             OR EXISTS (SELECT 1 FROM asin_products
                     WHERE in_scope AND claimed_at IS NULL AND last_fetched_at IS NOT NULL
                       AND next_due_at <= now() AND (tier = 1 OR $1::boolean))
           ) AS due`,
          [s.tail_enabled],
        );
        // Is the weekly enqueue upsert holding ENQUEUE_LOCK_KEY exclusively? The service waits on it
        // without heartbeats. pg_locks is server-wide, so this works through Neon's pooler; the
        // single-bigint-key lock shows the key's low 32 bits in objid and 0 in classid.
        const { rows: lock } = await c.query<{ running: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_locks
             WHERE locktype = 'advisory' AND classid = 0 AND objid = $1::oid AND objsubid = 1
               AND mode = 'ExclusiveLock' AND granted
           ) AS running`,
          [ENQUEUE_LOCK_KEY],
        );
        const running = lock[0]?.running ?? false;
        const now = new Date();
        const et = easternClock(now);
        const readSource = keepaReadSource();
        // The scope/explorer weeks matter only to the two sync branches, so they are read only when a
        // sync could fire this tick (otherwise explorerCaughtUp: true cannot change a decision). The
        // import enqueues a new week before the ~4.5-hour explorer refresh, and the sync job syncs
        // whatever week the explorer is on, so a sync waits until the refresh has swapped the week in.
        let weeks: { scope: string | null; kcs: string | null } | null = null;
        if (syncCouldFire({ readSource, laneNewDrainedAt: s.lane_new_drained_at, syncFiredAt: s.sync_fired_at, et })) {
          const { rows: weekRows } = await c.query<{ scope_week: string | null; kcs_week: string | null }>(
            `SELECT (SELECT max(scope_week)::text FROM asin_products) AS scope_week,
                    (SELECT current_week_end_date::text FROM keyword_current_summary_meta WHERE singleton = true) AS kcs_week`,
          );
          weeks = { scope: weekRows[0]?.scope_week ?? null, kcs: weekRows[0]?.kcs_week ?? null };
        }
        // ISO dates compare correctly as text; an unknown week never holds a sync back.
        const explorerCaughtUp = !weeks || !weeks.scope || !weeks.kcs || weeks.kcs >= weeks.scope;
        const actions = decideWatcherActions({
          now,
          serviceBooted: s.boot_id !== null,
          enqueueRunning: running,
          heartbeatAt: s.heartbeat_at,
          lastBatchAt: s.last_batch_at,
          dueWorkExists: due[0]?.due ?? false,
          laneNewDrainedAt: s.lane_new_drained_at,
          syncFiredAt: s.sync_fired_at,
          explorerCaughtUp,
          nightlySyncDate: s.nightly_sync_date,
          downAlarmSentAt: s.down_alarm_sent_at,
          stallAlarmSentAt: s.stall_alarm_sent_at,
          readSource,
          et,
        });
        for (const a of actions) {
          if (a.kind === 'email') {
            await sendKeepaServiceAlarmEmail({ variant: a.variant, heartbeatAt: s.heartbeat_at, lastBatchAt: s.last_batch_at });
          } else if (a.kind === 'sync') {
            // The weeks are read whenever a sync can fire; the single meta read only guards that.
            let week = weeks ? weeks.kcs : null;
            if (!weeks) {
              const { rows: meta } = await c.query<{ cw: string }>(
                `SELECT current_week_end_date::text AS cw FROM keyword_current_summary_meta WHERE singleton = true`,
              );
              week = meta[0]?.cw ?? null;
            }
            if (week) await inngest.send({ name: 'keepa/aggregates-sync-requested', data: { weekEndDate: week } });
          } else {
            await c.query(STAMP_SQL[a.field], [a.value]);
          }
        }
        const summary = actions.map((a) => (a.kind === 'email' ? `email:${a.variant}` : a.kind === 'sync' ? `sync:${a.reason}` : `stamp:${a.field}`));
        console.log(`[keepa-watcher] ${JSON.stringify({ actions: summary })}`);
        return { ok: true, actions: summary };
      } finally {
        c.release();
      }
    } finally {
      await pool.end();
    }
  },
);
