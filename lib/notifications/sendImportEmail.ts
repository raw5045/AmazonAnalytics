/**
 * Send an import-outcome email via Resend to all admin users.
 *
 * Resilience:
 *   - Missing RESEND_API_KEY → log a warning and return (don't fail the
 *     import). Allows local dev to work without Resend setup.
 *   - Resend API error → log and return. The header banner is the
 *     redundant in-app surface; we don't want a flaky email service to
 *     mark the import as failed.
 *
 * Recipient list = `SELECT email FROM users WHERE role='admin' AND email IS NOT NULL`.
 * Each admin gets their own email (via Resend's bcc behavior, or a
 * loop — see implementation note below).
 */
import { Resend } from 'resend';
import { db } from '@/db/client';
import { users } from '@/db/schema';
import { and, eq, isNotNull } from 'drizzle-orm';
import { buildImportEmail, type ImportEmailInput } from './buildImportEmail';

export type SendImportEmailInput = Omit<ImportEmailInput, 'appUrl'>;

export async function sendImportEmail(input: SendImportEmailInput): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM ?? 'KeywordQuarry <notifications@keywordquarry.com>';
  const appUrl = process.env.APP_PUBLIC_URL ?? 'https://keywordquarry.com';

  if (!apiKey) {
    console.warn(
      `[sendImportEmail] RESEND_API_KEY not set — skipping email for "${input.filename}" (${input.outcome}). This is expected in local dev.`,
    );
    return;
  }

  // Build the email content once.
  const email = buildImportEmail({ ...input, appUrl });

  // Look up admin recipients. Fail soft on DB error so a transient
  // Neon hiccup doesn't break the import.
  let recipients: string[] = [];
  try {
    const adminRows = await db
      .select({ email: users.email })
      .from(users)
      .where(and(eq(users.role, 'admin'), isNotNull(users.email)));
    recipients = adminRows.map((r) => r.email).filter((e): e is string => !!e);
  } catch (e) {
    console.error('[sendImportEmail] failed to look up admin recipients:', e);
    return;
  }

  if (recipients.length === 0) {
    console.warn('[sendImportEmail] no admin recipients found — skipping send.');
    return;
  }

  // Send. Resend supports an array of recipient addresses on `to`,
  // delivering as separate per-recipient emails (no inter-admin BCC
  // privacy leak).
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
      console.error('[sendImportEmail] Resend returned error:', result.error);
    } else {
      console.log(
        `[sendImportEmail] sent "${email.subject}" to ${recipients.length} admin(s). id=${result.data?.id}`,
      );
    }
  } catch (e) {
    console.error('[sendImportEmail] send threw:', e);
  }
}
