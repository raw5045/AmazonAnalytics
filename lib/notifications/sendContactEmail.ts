/**
 * Email a contact-form submission to all admin users via Resend.
 * Mirrors sendImportEmail's pattern: admin recipients from the DB, fail-soft
 * logging — but RETURNS success/failure so the API route can tell the
 * submitter whether their message actually went through.
 */
import { Resend } from 'resend';
import { db } from '@/db/client';
import { users } from '@/db/schema';
import { and, eq, isNotNull } from 'drizzle-orm';
import type { ContactInput } from '@/lib/contact/validate';

export async function sendContactEmail(input: ContactInput): Promise<{ sent: boolean; reason?: string }> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM ?? 'onboarding@resend.dev';
  if (!apiKey) {
    console.warn('[sendContactEmail] RESEND_API_KEY not set — cannot deliver contact form.');
    return { sent: false, reason: 'email not configured' };
  }

  let recipients: string[] = [];
  try {
    const adminRows = await db
      .select({ email: users.email })
      .from(users)
      .where(and(eq(users.role, 'admin'), isNotNull(users.email)));
    recipients = adminRows.map((r) => r.email).filter((e): e is string => !!e);
  } catch (e) {
    console.error('[sendContactEmail] admin lookup failed:', e);
    return { sent: false, reason: 'lookup failed' };
  }
  if (recipients.length === 0) return { sent: false, reason: 'no admin recipients' };

  const subject = `📨 Contact form: ${input.name}`;
  const text = `From: ${input.name} <${input.email}>\n\n${input.message}`;
  const html = `<p><strong>From:</strong> ${escapeHtml(input.name)} &lt;${escapeHtml(input.email)}&gt;</p><p style="white-space:pre-wrap">${escapeHtml(input.message)}</p>`;

  try {
    const resend = new Resend(apiKey);
    const result = await resend.emails.send({
      from,
      to: recipients,
      replyTo: input.email,
      subject,
      text,
      html,
    });
    if (result.error) {
      console.error('[sendContactEmail] Resend error:', result.error);
      return { sent: false, reason: 'send failed' };
    }
    return { sent: true };
  } catch (e) {
    console.error('[sendContactEmail] send threw:', e);
    return { sent: false, reason: 'send failed' };
  }
}

// Matches buildImportEmail.ts's escapeHtml (incl. single quotes) so a future
// refactor that interpolates these values into an HTML attribute stays safe.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
