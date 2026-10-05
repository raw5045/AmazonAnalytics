// lib/notifications/sendKeepaServiceAlarmEmail.ts
/**
 * Send a Keepa service watcher email to every admin. Fail-soft, mirroring sendEnrichmentEmail:
 * no key → skip; Resend error / thrown / recipient lookup failed → log coded fields and return.
 * Resolves true only when Resend accepted the send: the watcher stamps an alarm as sent only then,
 * so a failed send is retried on the next tick.
 */
import { Resend } from 'resend';
import { and, eq, isNotNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { users } from '@/db/schema';
import { logLookupFailed, logResendError, logSendThrew } from './logSendFailure';
import { buildKeepaServiceAlarmEmail, type KeepaAlarmEmailInput } from './buildKeepaServiceAlarmEmail';

export type SendKeepaServiceAlarmEmailInput = Omit<KeepaAlarmEmailInput, 'appUrl' | 'now'>;

export async function sendKeepaServiceAlarmEmail(input: SendKeepaServiceAlarmEmailInput): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM ?? 'KeywordQuarry <notifications@keywordquarry.com>';
  const appUrl = process.env.APP_PUBLIC_URL ?? 'https://keywordquarry.com';
  if (!apiKey) {
    console.warn(`[sendKeepaServiceAlarmEmail] RESEND_API_KEY not set — skipping "${input.variant}" email. Expected in local dev.`);
    return false;
  }
  const email = buildKeepaServiceAlarmEmail({ ...input, appUrl, now: new Date() });

  let recipients: string[] = [];
  try {
    const rows = await db.select({ email: users.email }).from(users).where(and(eq(users.role, 'admin'), isNotNull(users.email)));
    recipients = rows.map((r) => r.email).filter((e): e is string => !!e);
  } catch (e) {
    logLookupFailed('[sendKeepaServiceAlarmEmail]', e);
    return false;
  }
  if (recipients.length === 0) {
    console.warn('[sendKeepaServiceAlarmEmail] no admin recipients found — skipping send.');
    return false;
  }
  try {
    const result = await new Resend(apiKey).emails.send({ from, to: recipients, subject: email.subject, text: email.text, html: email.html });
    if (result.error) {
      logResendError('[sendKeepaServiceAlarmEmail]', result.error);
      return false;
    }
    console.log(`[sendKeepaServiceAlarmEmail] sent "${email.subject}" to ${recipients.length} admin(s). id=${result.data?.id}`);
    return true;
  } catch (e) {
    logSendThrew('[sendKeepaServiceAlarmEmail]', e);
    return false;
  }
}
