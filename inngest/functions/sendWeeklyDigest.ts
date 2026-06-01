// inngest/functions/sendWeeklyDigest.ts
/**
 * Weekly digest fan-out. Triggered by the admin "Send digest" button via
 * the `digest.send-weekly` event. The heavy lifting (idempotency gate,
 * chunked Resend batch, per-user status rows) is in
 * lib/notifications/digest/sendWeeklyDigest.ts; this wrapper just invokes
 * it inside a single step so Inngest's retry re-invokes safely (sends are
 * idempotent at the (week, user) grain).
 *
 * Event payload: { weekEndDate: string; triggeredBy?: string; retry?: boolean }
 */
import { inngest } from '../client';
import { sendWeeklyDigest } from '@/lib/notifications/digest/sendWeeklyDigest';

export const sendWeeklyDigestFn = inngest.createFunction(
  {
    id: 'send-weekly-digest',
    name: 'Send weekly digest',
    concurrency: { limit: 1, key: 'event.data.weekEndDate' },
    retries: 2,
    triggers: [{ event: 'digest.send-weekly' }],
  },
  async ({ event, step }) => {
    const { weekEndDate, triggeredBy, retry } = event.data as {
      weekEndDate: string;
      triggeredBy?: string;
      retry?: boolean;
    };
    return step.run('send', () =>
      sendWeeklyDigest({ weekEndDate, triggeredBy: triggeredBy ?? null, retry: retry ?? false }),
    );
  },
);
