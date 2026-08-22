/**
 * Email a contact-form submission to the support inbox via Resend.
 * Fail-soft logging — but RETURNS success/failure so the API route can tell
 * the submitter whether their message actually went through.
 *
 * Delivers to support@keywordquarry.com (Cloudflare Email Routing forwards
 * to the owner's inbox) rather than admin users' personal addresses, so
 * Gmail's "reply from the address the message was sent to" setting makes
 * every reply go out as support@ — the owner's personal identity never
 * reaches a user. If more admins need copies later, add forwarding rules
 * in Cloudflare rather than resurrecting the DB admin lookup here.
 */
import { Resend } from 'resend';
import type { ContactInput } from '@/lib/contact/validate';

const SUPPORT_INBOX = 'support@keywordquarry.com';

export async function sendContactEmail(input: ContactInput): Promise<{ sent: boolean; reason?: string }> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM ?? 'KeywordQuarry <notifications@keywordquarry.com>';
  if (!apiKey) {
    console.warn('[sendContactEmail] RESEND_API_KEY not set — cannot deliver contact form.');
    return { sent: false, reason: 'email not configured' };
  }

  const recipients = [SUPPORT_INBOX];

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
