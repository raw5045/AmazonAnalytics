// inngest/functions/sendAbuseDigest.ts
/**
 * Daily admin abuse-digest — 7:30am ET, covering the previous ET calendar
 * day. Runs on the Railway worker. The orchestrator's app_settings key
 * makes retry re-invocations safe (they exit 'already_sent'); retries
 * usefully cover pre-send transient errors (loader/Neon blips) and failed
 * Resend sends (the key only advances after a successful send).
 *
 * After the send, a second step prunes slow_queries to its last 90 days
 * (spec 2026-10-23 §5b: the digest read the day's rows first). It never fails
 * the run: a failure is logged with coded fields and the rows wait for
 * tomorrow's run, so a prune problem can never cost a digest or re-send one.
 *
 * See docs/superpowers/specs/2026-07-13-abuse-digest-design.md.
 */
import { lt } from 'drizzle-orm';
import { inngest } from '../client';
import { db } from '@/db/client';
import { slowQueries } from '@/db/schema';
import { errFields } from '@/lib/ask/logSafe';
import { sendAbuseDigest } from '@/lib/notifications/abuseDigest/sendAbuseDigest';

/** slow_queries keeps this many days of rows (spec 2026-10-23 §5b). */
export const SLOW_QUERIES_RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * One DELETE of the slow_queries rows older than SLOW_QUERIES_RETENTION_DAYS; returns how many went. Fail-soft: any
 * failure warns with the error class and code only (never a DB error's message, which can carry the statement and
 * its params) and returns 0.
 */
async function pruneSlowQueries(): Promise<number> {
  try {
    const cutoff = new Date(Date.now() - SLOW_QUERIES_RETENTION_DAYS * DAY_MS);
    const result = await db.delete(slowQueries).where(lt(slowQueries.happenedAt, cutoff));
    // node-postgres on the worker (neon-http elsewhere): both report the deleted rows as rowCount.
    const pruned = result.rowCount ?? 0;
    console.log(`[abuse-digest] pruned ${pruned} slow_queries rows older than ${SLOW_QUERIES_RETENTION_DAYS} days`);
    return pruned;
  } catch (e) {
    const { error, code } = errFields(e);
    console.warn('[abuse-digest] slow_queries prune failed (rows kept until the next run)', JSON.stringify({ error, code }));
    return 0;
  }
}

export const sendAbuseDigestFn = inngest.createFunction(
  {
    id: 'send-abuse-digest',
    name: 'Send daily admin abuse digest',
    retries: 2,
    concurrency: { limit: 1 },
    triggers: [{ cron: 'TZ=America/New_York 30 7 * * *' }],
  },
  async ({ step }) => {
    const sent = await step.run('send', () => sendAbuseDigest());
    const slowQueriesPruned = await step.run('prune-slow-queries', () => pruneSlowQueries());
    return { ...sent, slowQueriesPruned };
  },
);
