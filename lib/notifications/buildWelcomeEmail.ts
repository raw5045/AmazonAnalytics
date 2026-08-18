// lib/notifications/buildWelcomeEmail.ts
/**
 * Pure builder for the one-time welcome email sent at first signup
 * (fired from the Clerk user.created webhook when the app row is newly
 * created). Mirrors buildDigestEmail.ts: no network, returns
 * { subject, text, html } so it can be unit tested.
 */
interface WelcomeInput {
  /** Full name from Clerk; greeting uses the first word. Null → plain "Hi,". */
  name: string | null;
  appUrl: string;
}

interface BuiltEmail {
  subject: string;
  text: string;
  html: string;
}

export function buildWelcomeEmail(i: WelcomeInput): BuiltEmail {
  const first = i.name?.trim().split(/\s+/)[0] ?? null;
  const greeting = first ? `Hi ${first},` : 'Hi,';
  const helpUrl = `${i.appUrl}/help`;
  const subject = 'Welcome to KeywordQuarry — start here';

  const text = [
    'Welcome to KeywordQuarry',
    '',
    greeting,
    '',
    'You now have millions of Amazon keywords at your fingertips, updated every week. We highly recommend you watch our seven short tutorials which will walk you through the website, along with some of our favorite ways to filter for keywords.',
    '',
    '1. Understand the data and learn your way around (3 videos)',
    '2. Focus on your market with our category builder (1 video)',
    '3. Now the fun part — dig for winners with three of our favorite ways to filter (3 videos)',
    '',
    `Watch the tutorials: ${helpUrl}`,
    '',
    "We're in beta — just reply to this email with any question or idea and it comes straight to us.",
    '',
    '—',
    'You received this one-time email because you created a KeywordQuarry account.',
  ].join('\n');

  const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:640px;margin:0 auto;padding:24px;">
  <h1 style="margin:0 0 12px 0;font-size:20px;color:#111;">Welcome to KeywordQuarry</h1>
  <p style="margin:0 0 16px 0;color:#333;font-size:14px;">${escapeHtml(greeting)}</p>
  <p style="margin:0 0 16px 0;color:#333;font-size:14px;">
    You now have millions of Amazon keywords at your fingertips, updated every
    week. We highly recommend you watch our seven short tutorials which will
    walk you through the website, along with some of our favorite ways to
    filter for keywords.
  </p>
  <ol style="margin:0 0 20px 0;padding-left:20px;color:#333;font-size:14px;line-height:1.7;">
    <li><strong>Understand the data</strong> and learn your way around (3 videos)</li>
    <li><strong>Focus on your market</strong> with our category builder (1 video)</li>
    <li>Now the fun part — <strong>dig for winners</strong> with three of our favorite ways to filter (3 videos)</li>
  </ol>
  <a href="${helpUrl}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px;font-size:14px;">Watch the tutorials →</a>
  <p style="margin:20px 0 0 0;color:#333;font-size:14px;">
    We&#39;re in beta — just reply to this email with any question or idea and it
    comes straight to us.
  </p>
  <hr style="margin:28px 0 12px 0;border:none;border-top:1px solid #e5e7eb;">
  <p style="margin:0;color:#9ca3af;font-size:12px;">
    You received this one-time email because you created a KeywordQuarry account.
  </p>
</div>`.trim();

  return { subject, text, html };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
