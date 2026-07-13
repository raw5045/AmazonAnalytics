// lib/notifications/abuseDigest/buildAbuseDigestEmail.ts
// Pure builder for the daily admin abuse-digest email. Mirrors
// buildDigestEmail.ts: no network, returns { subject, text, html }.
// The subject line IS the quiet-day pulse — flags, signups, active users,
// and total reads are readable without opening the email.
import type { AbuseDigestStats, Flag } from './types';

export const ACTIVE_USER_ROW_CAP = 25;
// Render caps guard the body against pathological days (Gmail clips bodies
// around ~102KB). The subject and section headings always carry the TRUE
// counts; only the rendered lists truncate — the DB has the rest.
export const SIGNUP_ROW_CAP = 50;
export const FLAG_ROW_CAP = 50;

const AMBER_BG = '#fef3c7';
const AMBER_BORDER = '#f59e0b';
const RED_BG = '#fee2e2';
const RED_BORDER = '#dc2626';

export interface BuiltAbuseDigestEmail {
  subject: string;
  text: string;
  html: string;
}

export function buildAbuseDigestEmail(stats: AbuseDigestStats, flags: Flag[]): BuiltAbuseDigestEmail {
  const appUrl = process.env.APP_PUBLIC_URL ?? 'https://keywordquarry.com';
  const totalReads = stats.activeUsers.reduce((s, u) => s + u.explorerQueries + u.detailViews, 0);

  const pulse = `${stats.signups.length} signup${plural(stats.signups.length)} · ${stats.activeUsers.length} active · ${totalReads.toLocaleString()} reads`;
  const subject = flags.length
    ? `⚠️ ${flags.length} flag${plural(flags.length)} — KeywordQuarry daily — ${pulse}`
    : `KeywordQuarry daily — ${pulse}`;

  const quiet = stats.signups.length === 0 && stats.activeUsers.length === 0;
  const shownUsers = stats.activeUsers.slice(0, ACTIVE_USER_ROW_CAP);
  const droppedUsers = stats.activeUsers.length - shownUsers.length;
  const shownSignups = stats.signups.slice(0, SIGNUP_ROW_CAP);
  const droppedSignups = stats.signups.length - shownSignups.length;
  const shownFlags = flags.slice(0, FLAG_ROW_CAP);
  const droppedFlags = flags.length - shownFlags.length;

  // ---------- text ----------
  const textLines: string[] = [`KeywordQuarry daily digest — ${stats.day}`, ''];
  if (flags.length) {
    textLines.push('FLAGS:');
    for (const f of shownFlags) textLines.push(`  [${f.severity.toUpperCase()}] ${f.message}`);
    if (droppedFlags > 0) textLines.push(`  ...and ${droppedFlags} more flags`);
    textLines.push('');
  }
  if (quiet) {
    textLines.push('All quiet — no signups and no user activity.');
  } else {
    textLines.push(`Signups (${stats.signups.length}) — total users now ${stats.totalUsers}:`);
    for (const s of shownSignups) textLines.push(`  ${s.email}${s.name ? ` (${s.name})` : ''} at ${s.createdAt}`);
    if (droppedSignups > 0) textLines.push(`  ...and ${droppedSignups} more signups`);
    textLines.push('');
    textLines.push(`Active users (${stats.activeUsers.length}):`);
    for (const u of shownUsers) {
      textLines.push(
        `  ${u.email}: ${u.explorerQueries} queries, ${u.detailViews} detail views, ` +
          `${u.watchlistAdds} watchlist adds, ${u.savedViewsCreated} views, ${u.customCategoriesCreated} categories`,
      );
    }
    if (droppedUsers > 0) textLines.push(`  ...and ${droppedUsers} more active users`);
  }
  textLines.push('');
  textLines.push(`Sign-ins: ${stats.signIns.count}${stats.signIns.emails.length ? ` (${stats.signIns.emails.join(', ')})` : ''}`);
  textLines.push(`Contact form: ${stats.contact.submissions} submissions, ${stats.contact.honeypotTrips} honeypot trips`);
  textLines.push('');
  textLines.push(`Admin: ${appUrl}/admin/abuse-digest`);
  const text = textLines.join('\n');

  // ---------- html ----------
  const flagsHtml = shownFlags
    .map((f) => {
      const bg = f.severity === 'red' ? RED_BG : AMBER_BG;
      const border = f.severity === 'red' ? RED_BORDER : AMBER_BORDER;
      return `<div style="background:${bg};border-left:4px solid ${border};padding:8px 12px;margin:0 0 8px 0;font-size:13px;color:#111;">${escapeHtml(f.message)}</div>`;
    })
    .join('')
    .concat(
      droppedFlags > 0
        ? `<p style="margin:4px 0 0 0;font-size:12px;color:#6b7280;">…and ${droppedFlags} more flags</p>`
        : '',
    );

  const signupsHtml = stats.signups.length
    ? `<ul style="margin:0 0 4px 0;padding-left:18px;font-size:13px;color:#333;">${shownSignups
        .map((s) => `<li><strong>${escapeHtml(s.email)}</strong>${s.name ? ` (${escapeHtml(s.name)})` : ''} — ${escapeHtml(fmtTime(s.createdAt))}</li>`)
        .join('')}</ul>${
        droppedSignups > 0
          ? `<p style="margin:2px 0 0 0;font-size:12px;color:#6b7280;">…and ${droppedSignups} more signups</p>`
          : ''
      }`
    : `<p style="margin:0;font-size:13px;color:#6b7280;">No signups.</p>`;

  const activityHtml = stats.activeUsers.length
    ? `<table style="border-collapse:collapse;width:100%;font-size:12px;">
        <thead><tr style="text-align:left;color:#555;border-bottom:1px solid #e5e7eb;">
          <th style="padding:5px 8px 5px 0;">User</th>
          <th style="padding:5px 8px;text-align:right;">Queries</th>
          <th style="padding:5px 8px;text-align:right;">Detail views</th>
          <th style="padding:5px 8px;text-align:right;">Watchlist adds</th>
          <th style="padding:5px 8px;text-align:right;">Saved views</th>
          <th style="padding:5px 0 5px 8px;text-align:right;">Categories</th>
        </tr></thead>
        <tbody>${shownUsers
          .map(
            (u) => `<tr style="border-bottom:1px solid #f3f4f6;">
          <td style="padding:5px 8px 5px 0;">${escapeHtml(u.email)}</td>
          <td style="padding:5px 8px;text-align:right;">${u.explorerQueries.toLocaleString()}</td>
          <td style="padding:5px 8px;text-align:right;">${u.detailViews.toLocaleString()}</td>
          <td style="padding:5px 8px;text-align:right;">${u.watchlistAdds.toLocaleString()}</td>
          <td style="padding:5px 8px;text-align:right;">${u.savedViewsCreated.toLocaleString()}</td>
          <td style="padding:5px 0 5px 8px;text-align:right;">${u.customCategoriesCreated.toLocaleString()}</td>
        </tr>`,
          )
          .join('')}</tbody>
      </table>${droppedUsers > 0 ? `<p style="margin:6px 0 0 0;font-size:12px;color:#6b7280;">…and ${droppedUsers} more active users</p>` : ''}`
    : `<p style="margin:0;font-size:13px;color:#6b7280;">No user activity.</p>`;

  const html = `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;padding:24px 16px;color:#111;">
    <h1 style="margin:0 0 4px 0;font-size:18px;">KeywordQuarry daily digest</h1>
    <p style="margin:0 0 16px 0;font-size:13px;color:#6b7280;">${escapeHtml(stats.day)} (ET) · ${stats.totalUsers} total users</p>
    ${flagsHtml ? `<div style="margin:0 0 16px 0;">${flagsHtml}</div>` : ''}
    ${
      quiet
        ? `<p style="margin:0 0 16px 0;font-size:14px;color:#333;">All quiet — no signups and no user activity.</p>`
        : `
    <h2 style="margin:0 0 6px 0;font-size:14px;">Signups (${stats.signups.length})</h2>
    ${signupsHtml}
    <h2 style="margin:18px 0 6px 0;font-size:14px;">Active users (${stats.activeUsers.length})</h2>
    ${activityHtml}`
    }
    <p style="margin:18px 0 0 0;font-size:13px;color:#333;">
      Sign-ins: <strong>${stats.signIns.count}</strong>${stats.signIns.emails.length ? ` (${escapeHtml(stats.signIns.emails.join(', '))})` : ''}<br/>
      Contact form: <strong>${stats.contact.submissions}</strong> submissions, <strong>${stats.contact.honeypotTrips}</strong> honeypot trips
    </p>
    <p style="margin:20px 0 0 0;font-size:12px;color:#6b7280;">
      <a href="${appUrl}/admin/abuse-digest" style="color:#2563eb;">Open the admin digest page</a> · generated ${new Date().toISOString()}
    </p>
  </div>`;

  return { subject, text, html };
}

function plural(n: number): string {
  return n === 1 ? '' : 's';
}

/** '2026-07-12T15:30:00.000Z' → '15:30 UTC' (compact; the day is in the header). */
function fmtTime(iso: string): string {
  const m = iso.match(/T(\d{2}:\d{2})/);
  return m ? `${m[1]} UTC` : iso;
}

// Same escaping set as sendContactEmail.ts / buildImportEmail.ts.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
