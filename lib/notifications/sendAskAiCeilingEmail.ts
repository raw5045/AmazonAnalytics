/**
 * Email the owner's ceiling alert via Resend. Mirrors sendFeedbackEmail.ts's structure and fail-soft
 * return shape exactly (process.env reads, warn on no key, try/catch around the send). Differs only
 * in what a failure logs: this file logs the Resend error's coded `name` and, on a thrown error,
 * `errFields(e)` — never the raw error object or `input.to` — so a console line here can never carry
 * the admin's email address (Task 10 implementer delta B).
 */
import { Resend } from 'resend';
import { buildAskAiCeilingEmail, type AskAiCeilingEmailInput } from './buildAskAiCeilingEmail';
import { errFields } from '@/lib/ask/logSafe';

export async function sendAskAiCeilingEmail(input: AskAiCeilingEmailInput & { to: string }): Promise<{ sent: boolean; reason?: string }> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM ?? 'KeywordQuarry <notifications@keywordquarry.com>';
  if (!apiKey) {
    console.warn('[sendAskAiCeilingEmail] RESEND_API_KEY not set — cannot deliver the ceiling alert.');
    return { sent: false, reason: 'email not configured' };
  }
  const { subject, text, html } = buildAskAiCeilingEmail(input);
  try {
    const result = await new Resend(apiKey).emails.send({ from, to: [input.to], subject, text, html });
    if (result.error) {
      console.error('[sendAskAiCeilingEmail]', JSON.stringify({ outcome: 'resend_error', code: result.error.name }));
      return { sent: false, reason: 'send failed' };
    }
    return { sent: true };
  } catch (e) {
    console.error('[sendAskAiCeilingEmail]', JSON.stringify({ outcome: 'send_threw', ...errFields(e) }));
    return { sent: false, reason: 'send failed' };
  }
}
