// lib/notifications/sendKeepaServiceAlarmEmail.ts
/**
 * Send a Keepa service watcher email to every admin. Fail-soft, mirroring sendEnrichmentEmail:
 * no key → skip; Resend error / thrown / recipient lookup failed → log coded fields and return.
 */
import { Resend } from 'resend';
import { and, eq, isNotNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { users } from '@/db/schema';
import { logLookupFailed, logResendError, logSendThrew } from './logSendFailure';
import { buildKeepaServiceAlarmEmail, type KeepaAlarmEmailInput } from './buildKeepaServiceAlarmEmail';

export type SendKeepaServiceAlarmEmailInput = Omit<KeepaAlarmEmailInput, 'appUrl' | 'now'>;

export async function sendKeepaServiceAlarmEmail(input: SendKeepaServiceAlarmEmailInput): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM ?? 'KeywordQuarry <notifications@keywordquarry.com>';
  const appUrl = process.env.APP_PUBLIC_URL ?? 'https://keywordquarry.com';
  if (!apiKey) {
    console.warn(`[sendKeepaServiceAlarmEmail] RESEND_API_KEY not set — skipping "${input.variant}" email. Expected in local dev.`);
    return;
  }
  const email = buildKeepaServiceAlarmEmail({ ...input, appUrl, now: new Date() });

  let recipients: string[] = [];
  try {
    const rows = await db.select({ email: users.email }).from(users).where(and(eq(users.role, 'admin'), isNotNull(users.email)));
    recipients = rows.map((r) => r.email).filter((e): e is string => !!e);
  } catch (e) {
    logLookupFailed('[sendKeepaServiceAlarmEmail]', e);
    return;
  }
  if (recipients.length === 0) {
    console.warn('[sendKeepaServiceAlarmEmail] no admin recipients found — skipping send.');
    return;
  }
  try {
    const result = await new Resend(apiKey).emails.send({ from, to: recipients, subject: email.subject, text: email.text, html: email.html });
    if (result.error) logResendError('[sendKeepaServiceAlarmEmail]', result.error);
    else console.log(`[sendKeepaServiceAlarmEmail] sent "${email.subject}" to ${recipients.length} admin(s). id=${result.data?.id}`);
  } catch (e) {
    logSendThrew('[sendKeepaServiceAlarmEmail]', e);
  }
}
