// tests/integration/keepaWatcher.test.ts
/**
 * One Keepa watcher tick (runWatcherTick) against the real tables (migration 0050 applied), with
 * fake alarm and event senders: no email goes out and no Inngest event is sent. It proves the
 * tick's SQL runs against the real schema — the status read, both probes, the weeks query and any
 * stamp writes — which the fake-client tests cannot. The status row's stamp columns are read first
 * and put back as found.
 *
 * Preconditions: the Keepa service STOPPED (it writes the status row alongside the test), and the
 * worker's watcher cron not mid-tick (it writes the same stamp columns).
 *
 * Run (owner's go): RUN_INTEGRATION=1 pnpm vitest run tests/integration/keepaWatcher.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { runWatcherTick, type WatcherTickDeps } from '@/inngest/functions/keepaServiceWatcher';

const RUN = !!process.env.RUN_INTEGRATION;

/** The status-row columns a tick may write. */
interface Stamps {
  down_alarm_sent_at: Date | null;
  stall_alarm_sent_at: Date | null;
  sync_fired_at: Date | null;
  nightly_sync_date: string | null;
}

describe.skipIf(!RUN)('Keepa watcher tick (integration)', () => {
  let pool: Pool;
  let client: PoolClient;
  // undefined = there was no status row (a tick then skips and writes nothing).
  let stampsBefore: Stamps | undefined;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    pool.on('error', () => undefined);
    client = await pool.connect();
    client.on('error', () => undefined);
    const { rows } = await client.query<Stamps>(
      `SELECT down_alarm_sent_at, stall_alarm_sent_at, sync_fired_at, nightly_sync_date::text AS nightly_sync_date
       FROM keepa_service_status WHERE singleton`,
    );
    stampsBefore = rows[0];
  });

  afterAll(async () => {
    if (!pool) return;
    try {
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
      client?.release();
      await pool.end();
    }
  });

  /** Fake senders: alarms report "not sent" (so no alarm stamp gets set), events are only recorded. */
  function fakes() {
    const alarms: string[] = [];
    const events: Array<{ name: string; data: Record<string, unknown> }> = [];
    const sendAlarm: WatcherTickDeps['sendAlarm'] = async (input) => {
      alarms.push(input.variant);
      return false;
    };
    const sendEvent: WatcherTickDeps['sendEvent'] = async (name, data) => {
      events.push({ name, data });
      return {};
    };
    return { alarms, events, sendAlarm, sendEvent };
  }

  /** The real client, recording each statement's text. */
  function recording(texts: string[]): Pick<PoolClient, 'query'> {
    return {
      query: ((text: string, values?: unknown[]) => {
        texts.push(text);
        return client.query(text, values);
      }) as unknown as PoolClient['query'],
    };
  }

  it('runs a tick at the current time: the status read, both probes and the alarm decisions', async () => {
    const f = fakes();
    const texts: string[] = [];
    const result = await runWatcherTick(recording(texts), { now: new Date(), readSource: 'weekly', sendAlarm: f.sendAlarm, sendEvent: f.sendEvent });
    expect(result.ok).toBe(true);
    if (stampsBefore) expect(texts.length).toBeGreaterThanOrEqual(3);
  });

  it('runs a tick inside the nightly window with catalog reads: the weeks query and any sync stamps', async () => {
    const f = fakes();
    const texts: string[] = [];
    const today = new Date();
    // 08:45 UTC is 03:45 EST / 04:45 EDT: inside the 03:30–05:59 ET window either way.
    const now = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 8, 45));
    const result = await runWatcherTick(recording(texts), { now, readSource: 'products', sendAlarm: f.sendAlarm, sendEvent: f.sendEvent });
    expect(result.ok).toBe(true);
    if (stampsBefore) expect(texts.some((t) => t.includes('AS scope_week'))).toBe(true);
    for (const e of f.events) {
      expect(e.name).toBe('keepa/aggregates-sync-requested');
      expect(String(e.data.weekEndDate)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});
