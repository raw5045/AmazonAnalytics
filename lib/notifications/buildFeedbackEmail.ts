// lib/notifications/buildFeedbackEmail.ts
/**
 * Pure builder for the in-app feedback email delivered to the support inbox.
 * Mirrors buildWelcomeEmail.ts: no network, returns { subject, text, html }
 * so it can be unit tested. The sender sets reply-to = the account email so
 * the owner answers straight from Gmail (as support@).
 */
export interface FeedbackEmailInput {
  message: string;
  page: string | null;                                     // validated relative path or null
  user: { id: string; email: string; name: string | null };
  appUrl: string;                                          // e.g. https://keywordquarry.com
}

interface BuiltEmail {
  subject: string;
  text: string;
  html: string;
}

export function buildFeedbackEmail(i: FeedbackEmailInput): BuiltEmail {
  // The name lands in the subject line — collapse control characters so an
  // embedded newline can't spoof inbox previews (same guard as the contact
  // validator).
  const name = i.user.name?.replace(/[\r\n\t]+/g, ' ').trim() || null;
  const from = name ? `${name} <${i.user.email}>` : i.user.email;
  const pageUrl = i.page ? `${i.appUrl}${i.page}` : null;
  const subject = `💬 Feedback from ${name ?? i.user.email}`;

  const text = [
    `From: ${from}`,
    `Account: ${i.user.id}`,
    `Page: ${pageUrl ?? '(not captured)'}`,
    '',
    i.message,
    '',
    '—',
    'Reply to this email to answer them directly.',
  ].join('\n');

  const pageHtml = pageUrl
    ? `<a href="${escapeHtml(pageUrl)}" style="color:#2563eb;">${escapeHtml(pageUrl)}</a>`
    : '(not captured)';

  const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:640px;margin:0 auto;padding:24px;">
  <p style="margin:0 0 4px 0;color:#333;font-size:14px;"><strong>From:</strong> ${escapeHtml(from)}</p>
  <p style="margin:0 0 4px 0;color:#333;font-size:14px;"><strong>Account:</strong> ${escapeHtml(i.user.id)}</p>
  <p style="margin:0 0 16px 0;color:#333;font-size:14px;"><strong>Page:</strong> ${pageHtml}</p>
  <p style="margin:0;color:#111;font-size:14px;white-space:pre-wrap;">${escapeHtml(i.message)}</p>
  <hr style="margin:28px 0 12px 0;border:none;border-top:1px solid #e5e7eb;">
  <p style="margin:0;color:#9ca3af;font-size:12px;">Reply to this email to answer them directly.</p>
</div>`.trim();

  return { subject, text, html };
}

// Matches buildWelcomeEmail.ts's escapeHtml (incl. quotes) — values are
// interpolated into an href attribute above, so quotes must be escaped.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
