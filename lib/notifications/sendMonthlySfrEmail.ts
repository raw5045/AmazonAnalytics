/**
 * Send the monthly-SFR upload outcome email via Resend.
 *
 * Mirrors sendCalibrationEmail's fail-soft, admin-recipient pattern (missing
 * RESEND_API_KEY → log + return; Resend error → log + return; never crashes the
 * Inngest run). Previously processMonthlySfr only logged, so a silent 1h timeout
 * went completely unnoticed — this closes that gap for the BA SFR ingest.
 */
import { Resend } from 'resend';
import { db } from '@/db/client';
import { users } from '@/db/schema';
import { and, eq, isNotNull } from 'drizzle-orm';

export interface SendMonthlySfrEmailInput {
  outcome: 'completed' | 'failed' | 'timeout';
  monthEndDate: string;
  filename: string;
  rowsUpserted?: number | null;
  error?: string | null;
}

export async function sendMonthlySfrEmail(input: SendMonthlySfrEmailInput): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM ?? 'KeywordQuarry <notifications@keywordquarry.com>';
  const appUrl = process.env.APP_PUBLIC_URL ?? 'https://keywordquarry.com';

  if (!apiKey) {
    console.warn(
      `[sendMonthlySfrEmail] RESEND_API_KEY not set — skipping email for ${input.monthEndDate}.`,
    );
    return;
  }

  const email = buildEmail(input, appUrl);

  let recipients: string[] = [];
  try {
    const adminRows = await db
      .select({ email: users.email })
      .from(users)
      .where(and(eq(users.role, 'admin'), isNotNull(users.email)));
    recipients = adminRows.map((r) => r.email).filter((e): e is string => !!e);
  } catch (e) {
    console.error('[sendMonthlySfrEmail] admin recipient lookup failed:', e);
    return;
  }

  if (recipients.length === 0) {
    console.warn('[sendMonthlySfrEmail] no admin recipients — skipping send.');
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
      console.error('[sendMonthlySfrEmail] Resend returned error:', result.error);
    } else {
      console.log(
        `[sendMonthlySfrEmail] sent "${email.subject}" to ${recipients.length} admin(s). id=${result.data?.id}`,
      );
    }
  } catch (e) {
    console.error('[sendMonthlySfrEmail] send threw:', e);
  }
}

function buildEmail(
  input: SendMonthlySfrEmailInput,
  appUrl: string,
): { subject: string; text: string; html: string } {
  const label = { completed: '✅ completed', failed: '❌ failed', timeout: '⏱️ timed out' }[
    input.outcome
  ];
  const subject = `Monthly SFR upload ${input.outcome} — ${input.monthEndDate}`;

  const lines = [
    `Monthly BA SFR upload ${label}.`,
    '',
    `Month: ${input.monthEndDate}`,
    `File: ${input.filename}`,
  ];
  if (input.rowsUpserted != null) lines.push(`Rows upserted: ${input.rowsUpserted.toLocaleString()}`);
  if (input.error) lines.push('', `Error: ${input.error}`);
  if (input.outcome === 'timeout') {
    lines.push(
      '',
      'Processing did not complete within 1h. The worker may have died — check Railway logs and the Inngest dashboard.',
    );
  }
  lines.push('', `${appUrl}/admin`);

  const text = lines.join('\n');
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;color:#111">${lines
    .map((l) => (l === '' ? '<br>' : `<div>${escapeHtml(l)}</div>`))
    .join('')}</div>`;
  return { subject, text, html };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
