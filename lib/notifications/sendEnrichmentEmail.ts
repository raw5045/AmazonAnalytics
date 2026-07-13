/**
 * Send the Keepa enrichment-completion email via Resend to all admin
 * users.
 *
 * Resilience (mirrors sendImportEmail):
 *   - Missing RESEND_API_KEY → warn and return. Allows local dev to
 *     work without a Resend setup.
 *   - Resend API error → log and return. We do NOT crash the Inngest
 *     run — the actual asin_weekly_data rows are already in Postgres,
 *     and a flaky email is not worth wiping the 19h of work.
 *   - Admin lookup failure → log and return (same reasoning).
 *
 * Recipient list: `SELECT email FROM users WHERE role='admin' AND email IS NOT NULL`.
 */
import { Resend } from 'resend';
import { db } from '@/db/client';
import { users } from '@/db/schema';
import { and, eq, isNotNull } from 'drizzle-orm';
import { buildEnrichmentEmail, type EnrichmentEmailInput } from './buildEnrichmentEmail';

export type SendEnrichmentEmailInput = Omit<EnrichmentEmailInput, 'appUrl'>;

export async function sendEnrichmentEmail(input: SendEnrichmentEmailInput): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM ?? 'onboarding@resend.dev';
  const appUrl = process.env.APP_PUBLIC_URL ?? 'https://keywordquarry.com';

  if (!apiKey) {
    console.warn(
      `[sendEnrichmentEmail] RESEND_API_KEY not set — skipping email for week ${input.weekEndDate}. Expected in local dev.`,
    );
    return;
  }

  const email = buildEnrichmentEmail({ ...input, appUrl });

  let recipients: string[] = [];
  try {
    const adminRows = await db
      .select({ email: users.email })
      .from(users)
      .where(and(eq(users.role, 'admin'), isNotNull(users.email)));
    recipients = adminRows.map((r) => r.email).filter((e): e is string => !!e);
  } catch (e) {
    console.error('[sendEnrichmentEmail] failed to look up admin recipients:', e);
    return;
  }

  if (recipients.length === 0) {
    console.warn('[sendEnrichmentEmail] no admin recipients found — skipping send.');
    return;
  }

  const resend = new Resend(apiKey);
  try {
    const result = await resend.emails.send({
      from,
      to: recipients,
      subject: email.subject,
      text: email.text,
      html: email.html,
    });
    if (result.error) {
      console.error('[sendEnrichmentEmail] Resend returned error:', result.error);
    } else {
      console.log(
        `[sendEnrichmentEmail] sent "${email.subject}" to ${recipients.length} admin(s). id=${result.data?.id}`,
      );
    }
  } catch (e) {
    console.error('[sendEnrichmentEmail] send threw:', e);
  }
}
