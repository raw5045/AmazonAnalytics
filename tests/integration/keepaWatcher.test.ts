// tests/integration/keepaWatcher.test.ts
/**
 * Keepa watcher ticks (runWatcherTick) against the real tables (migration 0050 applied), with fake
 * alarm and event senders: no email goes out and no Inngest event is sent. It proves the tick's SQL
 * runs against the real schema — the status read, both probes, the weeks query and the stamp
 * writes — which the fake-client tests cannot.
 *
 * Rollback-safe: each tick runs inside BEGIN … ROLLBACK on this file's own client (runWatcherTick
 * only runs plain statements on the client it is given), after seeding the status row to known
 * values, so nothing a tick writes survives. A killed connection rolls back server-side, and
 * concurrent real writes to the row just wait. afterAll still puts the stamp columns back as read,
 * belt and braces (a no-op when the rollbacks worked).
 *
 * Precondition: run between quarter-hours, so no real watcher tick (every 15 minutes) overlaps.
 *
 * Run (owner's go): RUN_INTEGRATION=1 pnpm vitest run tests/integration/keepaWatcher.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { runWatcherTick, type WatcherTickDeps } from '@/inngest/functions/keepaServiceWatcher';
import { easternClock } from '@/lib/keepa/watcherRules';

const RUN = !!process.env.RUN_INTEGRATION;
const TIMEOUT_MS = 60_000;
/** Every stamp column back to "never", so each tick's stamp SQL runs from a known state. */
const RESET_STAMPS = 'down_alarm_sent_at = NULL, stall_alarm_sent_at = NULL, sync_fired_at = NULL, nightly_sync_date = NULL';

/** The status-row columns a tick may write. */
interface Stamps {
  down_alarm_sent_at: Date | null;
  stall_alarm_sent_at: Date | null;
  sync_fired_at: Date | null;
  nightly_sync_date: string | null;
}

const STAMPS_SQL = `SELECT down_alarm_sent_at, stall_alarm_sent_at, sync_fired_at, nightly_sync_date::text AS nightly_sync_date
                    FROM keepa_service_status WHERE singleton`;

describe.skipIf(!RUN)('Keepa watcher tick (integration)', () => {
  let pool: Pool;
  let client: PoolClient;
  // undefined = there was no status row before the test (each transaction then adds one and rolls it back).
  let stampsBefore: Stamps | undefined;
  let tearingDown = false;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    pool.on('error', () => undefined);
    client = await pool.connect();
    client.on('error', () => undefined);
    const { rows } = await client.query<Stamps>(STAMPS_SQL);
    stampsBefore = rows[0];
  });

  afterAll(async () => {
    tearingDown = true;
    if (!client) {
      await pool?.end();
      return;
    }
    try {
      // Belt and braces: end any transaction a failed test left open, then put the stamps back as read.
      await client.query('ROLLBACK');
      if (stampsBefore) {
        const s = stampsBefore;
        await client.query(
          `UPDATE keepa_service_status
           SET down_alarm_sent_at = $1, stall_alarm_sent_at = $2, sync_fired_at = $3, nightly_sync_date = $4::date
           WHERE singleton`,
          [s.down_alarm_sent_at, s.stall_alarm_sent_at, s.sync_fired_at, s.nightly_sync_date],
        );
      }
    } finally {
      client.release();
      await pool.end();
    }
  });

  /** BEGIN, make sure the status row exists, seed it, run `fn`, ROLLBACK — whatever happens. */
  async function inRolledBackTick(seedSql: string, seedValues: unknown[], fn: () => Promise<void>): Promise<void> {
    await client.query('BEGIN');
    try {
      await client.query('INSERT INTO keepa_service_status (singleton) VALUES (true) ON CONFLICT (singleton) DO NOTHING');
      await client.query(seedSql, seedValues);
      await fn();
    } finally {
      await client.query('ROLLBACK');
    }
  }

  /** The stamp columns as this transaction sees them. */
  async function stampsNow(): Promise<Stamps> {
    const { rows } = await client.query<Stamps>(STAMPS_SQL);
    return rows[0];
  }

  /** Fake senders: alarms count as delivered (their stamps roll back with the rest), events are only recorded. */
  function fakes() {
    const alarms: string[] = [];
    const events: Array<{ name: string; data: Record<string, unknown> }> = [];
    const sendAlarm: WatcherTickDeps['sendAlarm'] = async (input) => {
      alarms.push(input.variant);
      return true;
    };
    const sendEvent: WatcherTickDeps['sendEvent'] = async (name, data) => {
      events.push({ name, data });
      return {};
    };
    return { alarms, events, sendAlarm, sendEvent };
  }

  /** The real client, recording each statement's text; refuses everything once teardown has started. */
  function recording(texts: string[]): Pick<PoolClient, 'query'> {
    return {
      query: ((text: string, values?: unknown[]) => {
        if (tearingDown) return Promise.reject(new Error('keepa_watcher_itest_torn_down'));
        texts.push(text);
        return client.query(text, values);
      }) as unknown as PoolClient['query'],
    };
  }

  it(
    'alarm path: a stale heartbeat sends the down alarm and stamps it',
    async () => {
      const tickNow = new Date();
      const f = fakes();
      const texts: string[] = [];
      await inRolledBackTick(
        `UPDATE keepa_service_status
         SET ${RESET_STAMPS}, boot_id = coalesce(boot_id, 'integration-test'),
             heartbeat_at = $1::timestamptz - interval '40 minutes', last_batch_at = $1::timestamptz - interval '2 minutes'
         WHERE singleton`,
        [tickNow],
        async () => {
          const result = await runWatcherTick(recording(texts), { now: tickNow, readSource: 'weekly', sendAlarm: f.sendAlarm, sendEvent: f.sendEvent });
          expect(texts.length).toBeGreaterThanOrEqual(3);
          if (f.alarms.length > 0) {
            expect(result).toEqual({ ok: true, actions: ['email:down', 'stamp:down_alarm_sent_at'] });
            expect((await stampsNow()).down_alarm_sent_at?.getTime()).toBe(tickNow.getTime());
          } else {
            // A weekly enqueue holding its lock right now suppresses alarms (the tick logs enqueueRunning).
            expect(result).toEqual({ ok: true, actions: [] });
          }
        },
      );
    },
    TIMEOUT_MS,
  );

  it(
    'sync path: a drained lane reads the weeks and, with the explorer caught up, requests the sync and stamps it',
    async () => {
      const tickNow = new Date();
      const f = fakes();
      const texts: string[] = [];
      await inRolledBackTick(
        `UPDATE keepa_service_status
         SET ${RESET_STAMPS}, boot_id = coalesce(boot_id, 'integration-test'),
             heartbeat_at = $1::timestamptz - interval '1 minute', last_batch_at = $1::timestamptz - interval '2 minutes',
             lane_new_drained_at = $1::timestamptz - interval '3 minutes'
         WHERE singleton`,
        [tickNow],
        async () => {
          const result = await runWatcherTick(recording(texts), { now: tickNow, readSource: 'products', sendAlarm: f.sendAlarm, sendEvent: f.sendEvent });
          expect(texts.some((t) => t.includes('AS scope_week'))).toBe(true);
          if (f.events.length > 0) {
            expect(result).toEqual({ ok: true, actions: ['sync:new_lane_drained', 'stamp:sync_fired_at'] });
            expect(f.events[0].name).toBe('keepa/aggregates-sync-requested');
            expect(String(f.events[0].data.weekEndDate)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
            expect((await stampsNow()).sync_fired_at?.getTime()).toBe(tickNow.getTime());
          } else {
            // The explorer is behind the catalog's scope week (mid-refresh) or its week is unknown: held.
            expect(result).toEqual({ ok: true, actions: [] });
          }
        },
      );
    },
    TIMEOUT_MS,
  );

  it(
    'nightly path: inside the window, with the explorer caught up, the sync and both nightly stamps',
    async () => {
      const today = new Date();
      // 08:45 UTC is 03:45 EST / 04:45 EDT: inside the 03:30–05:59 ET window either way.
      const tickNow = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 8, 45));
      const f = fakes();
      const texts: string[] = [];
      await inRolledBackTick(
        `UPDATE keepa_service_status
         SET ${RESET_STAMPS}, boot_id = coalesce(boot_id, 'integration-test'),
             heartbeat_at = $1::timestamptz - interval '1 minute', last_batch_at = $1::timestamptz - interval '2 minutes',
             lane_new_drained_at = NULL
         WHERE singleton`,
        [tickNow],
        async () => {
          const result = await runWatcherTick(recording(texts), { now: tickNow, readSource: 'products', sendAlarm: f.sendAlarm, sendEvent: f.sendEvent });
          expect(texts.some((t) => t.includes('AS scope_week'))).toBe(true);
          if (f.events.length > 0) {
            expect(result).toEqual({ ok: true, actions: ['sync:nightly', 'stamp:nightly_sync_date', 'stamp:sync_fired_at'] });
            const after = await stampsNow();
            expect(after.nightly_sync_date).toBe(easternClock(tickNow).dateKey);
            expect(after.sync_fired_at?.getTime()).toBe(tickNow.getTime());
          } else {
            expect(result).toEqual({ ok: true, actions: [] });
          }
        },
      );
    },
    TIMEOUT_MS,
  );
});
