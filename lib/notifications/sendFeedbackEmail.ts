/**
 * Email an in-app feedback submission to the support inbox via Resend.
 * Sibling of sendContactEmail.ts, deliberately not shared: the contact path
 * stays untouched (see docs/superpowers/specs/2026-09-15-feedback-button-
 * design.md). Fail-soft logging, but RETURNS success/failure so the API
 * route can tell the user whether their message actually went through.
 *
 * Delivers to support@keywordquarry.com with reply-to = the member's
 * account email, so a Gmail reply goes straight back to them as support@.
 */
import { Resend } from 'resend';
import { buildFeedbackEmail, type FeedbackEmailInput } from './buildFeedbackEmail';

const SUPPORT_INBOX = 'support@keywordquarry.com';

export async function sendFeedbackEmail(
  input: FeedbackEmailInput,
): Promise<{ sent: boolean; reason?: string }> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM ?? 'KeywordQuarry <notifications@keywordquarry.com>';
  if (!apiKey) {
    console.warn('[sendFeedbackEmail] RESEND_API_KEY not set — cannot deliver feedback.');
    return { sent: false, reason: 'email not configured' };
  }

  const { subject, text, html } = buildFeedbackEmail(input);

  try {
    const resend = new Resend(apiKey);
    const result = await resend.emails.send({
      from,
      to: [SUPPORT_INBOX],
      replyTo: input.user.email,
      subject,
      text,
      html,
    });
    if (result.error) {
      console.error('[sendFeedbackEmail] Resend error:', result.error);
      return { sent: false, reason: 'send failed' };
    }
    return { sent: true };
  } catch (e) {
    console.error('[sendFeedbackEmail] send threw:', e);
    return { sent: false, reason: 'send failed' };
  }
}
