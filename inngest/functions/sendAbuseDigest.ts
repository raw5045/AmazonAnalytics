// inngest/functions/sendAbuseDigest.ts
/**
 * Daily admin abuse-digest — 7:30am ET, covering the previous ET calendar
 * day. Runs on the Railway worker. The orchestrator's app_settings key
 * makes retry re-invocations safe (they exit 'already_sent'); retries
 * usefully cover pre-send transient errors (loader/Neon blips) and failed
 * Resend sends (the key only advances after a successful send).
 *
 * See docs/superpowers/specs/2026-07-13-abuse-digest-design.md.
 */
import { inngest } from '../client';
import { sendAbuseDigest } from '@/lib/notifications/abuseDigest/sendAbuseDigest';

export const sendAbuseDigestFn = inngest.createFunction(
  {
    id: 'send-abuse-digest',
    name: 'Send daily admin abuse digest',
    retries: 2,
    concurrency: { limit: 1 },
    triggers: [{ cron: 'TZ=America/New_York 30 7 * * *' }],
  },
  async ({ step }) => {
    return step.run('send', () => sendAbuseDigest());
  },
);
