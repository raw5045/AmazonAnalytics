// lib/notifications/sendWelcomeEmail.ts
import { Resend } from 'resend';
import { buildWelcomeEmail } from './buildWelcomeEmail';

/**
 * One-time welcome email at first signup. Fail-soft by contract: never
 * throws — a failed welcome email must not 500 the Clerk webhook into a
 * Svix retry loop (the user row already exists by the time this runs, so
 * a retry would take the update path and correctly skip the email).
 */
export async function sendWelcomeEmail(input: {
  to: string;
  name: string | null;
}): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('[welcome email] RESEND_API_KEY not set — skipping send');
    return false;
  }
  // Fallback MUST be the verified production domain, never resend.dev
  // (sandbox delivers only to the account owner's inbox — see the
  // matching note in digest/sendWeeklyDigest.ts).
  const from = process.env.RESEND_FROM ?? 'KeywordQuarry <notifications@keywordquarry.com>';
  const appUrl = process.env.APP_PUBLIC_URL ?? 'https://keywordquarry.com';

  try {
    const { subject, text, html } = buildWelcomeEmail({ name: input.name, appUrl });
    const resend = new Resend(apiKey);
    const result = await resend.emails.send({
      from,
      to: input.to,
      // Replies route to the owner's inbox via Cloudflare Email Routing.
      replyTo: 'support@keywordquarry.com',
      subject,
      text,
      html,
    });
    if (result.error) {
      console.error('[welcome email] Resend error:', result.error);
      return false;
    }
    return true;
  } catch (e) {
    console.error('[welcome email] send threw:', e);
    return false;
  }
}
