/**
 * Email the owner's ceiling alert via Resend. Mirrors sendFeedbackEmail.ts's structure and fail-soft
 * return shape exactly (process.env reads, warn on no key, try/catch around the send). Differs only
 * in what a failure logs: this file logs the Resend error's coded `name` and `statusCode` (never its
 * `.message`, which some validation errors echo the invalid field's value into — e.g. an invalid
 * `to` address), and on a thrown error, only `errFields(e)`'s `error`/`code` — never its `detail`
 * (the thrown error's own `.message`, which for a generic network/client error could in principle
 * embed request data) — so a console line here can never carry the admin's email address (Task 10
 * implementer delta B; tightened further, Task 10 review C-m8).
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
      console.error('[sendAskAiCeilingEmail]', JSON.stringify({ outcome: 'resend_error', code: result.error.name, statusCode: result.error.statusCode }));
      return { sent: false, reason: 'send failed' };
    }
    return { sent: true };
  } catch (e) {
    const { error, code } = errFields(e);
    console.error('[sendAskAiCeilingEmail]', JSON.stringify({ outcome: 'send_threw', error, code }));
    return { sent: false, reason: 'send failed' };
  }
}
