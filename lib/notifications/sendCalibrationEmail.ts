/**
 * Send the calibration-upload outcome email via Resend.
 *
 * Same fail-soft pattern as sendImportEmail / sendEnrichmentEmail:
 * missing RESEND_API_KEY → log + return; Resend API error → log +
 * return; admin lookup failure → log + return. Never crashes the
 * Inngest run.
 */
import { Resend } from 'resend';
import { db } from '@/db/client';
import { users } from '@/db/schema';
import { and, eq, isNotNull } from 'drizzle-orm';
import {
  buildCalibrationEmail,
  type CalibrationEmailInput,
} from './buildCalibrationEmail';

export type SendCalibrationEmailInput = Omit<CalibrationEmailInput, 'appUrl'>;

export async function sendCalibrationEmail(input: SendCalibrationEmailInput): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM ?? 'onboarding@resend.dev';
  const appUrl = process.env.APP_PUBLIC_URL ?? 'https://amazon-analytics-beta.vercel.app';

  if (!apiKey) {
    console.warn(
      `[sendCalibrationEmail] RESEND_API_KEY not set — skipping email for ${input.monthEndDate}.`,
    );
    return;
  }

  const email = buildCalibrationEmail({ ...input, appUrl });

  let recipients: string[] = [];
  try {
    const adminRows = await db
      .select({ email: users.email })
      .from(users)
      .where(and(eq(users.role, 'admin'), isNotNull(users.email)));
    recipients = adminRows.map((r) => r.email).filter((e): e is string => !!e);
  } catch (e) {
    console.error('[sendCalibrationEmail] admin recipient lookup failed:', e);
    return;
  }

  if (recipients.length === 0) {
    console.warn('[sendCalibrationEmail] no admin recipients — skipping send.');
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
      console.error('[sendCalibrationEmail] Resend returned error:', result.error);
    } else {
      console.log(
        `[sendCalibrationEmail] sent "${email.subject}" to ${recipients.length} admin(s). id=${result.data?.id}`,
      );
    }
  } catch (e) {
    console.error('[sendCalibrationEmail] send threw:', e);
  }
}
