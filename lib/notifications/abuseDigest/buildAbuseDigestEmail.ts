// lib/notifications/abuseDigest/buildAbuseDigestEmail.ts
// Pure builder for the daily admin abuse-digest email. Mirrors
// buildDigestEmail.ts: no network, returns { subject, text, html }.
// The subject line IS the quiet-day pulse — flags, signups, active users,
// and total reads are readable without opening the email.
import type { AbuseDigestStats, ActiveUsersWindow, Flag, PerUserActivity, SlowSearchesSummary } from './types';

export const ACTIVE_USER_ROW_CAP = 25;
// Render caps guard the body against pathological days (Gmail clips bodies
// around ~102KB). The subject and section headings always carry the TRUE
// counts; only the rendered lists truncate — the DB has the rest.
export const SIGNUP_ROW_CAP = 50;
export const FLAG_ROW_CAP = 50;
/** Slow product searches listed (spec 2026-10-23 §5b); the loader's LIMIT, so it reads at most this many. */
export const SLOW_SEARCH_ROW_CAP = 10;
/**
 * A recorded query string longer than this shows cut, with a "… (+N chars)" marker (the row keeps it as recorded: whole up
 * to QUERY_STRING_MAX_CHARS in lib/products/slowQueries.ts, cut there with its own marker beyond).
 */
export const SLOW_SEARCH_DISPLAY_CHARS = 400;

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
  // In-app reads: both tabs' searches and detail pages (spec 2026-10-23 §4); MCP calls stay out of the pulse.
  const totalReads = stats.activeUsers.reduce((s, u) => s + u.explorerQueries + u.detailViews + u.productsQueries + u.productViews, 0);

  // Subject stays a daily pulse by owner decision — the weekly/monthly
  // sections are body-only (2026-09-15 spec).
  const pulse = `${stats.signups.length} signup${plural(stats.signups.length)} · ${stats.activeUsers.length} active · ${totalReads.toLocaleString()} reads`;
  const subject = flags.length
    ? `⚠️ ${flags.length} flag${plural(flags.length)} — KeywordQuarry daily — ${pulse}`
    : `KeywordQuarry daily — ${pulse}`;

  const quiet = stats.signups.length === 0 && stats.activeUsers.length === 0;
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
    textLines.push(`Daily active users (${stats.activeUsers.length}):`);
    textLines.push(...activityTextLines(stats.activeUsers));
  }
  // Slow product searches render every day (a timeout is flagged; the rows show what ran long).
  textLines.push('');
  textLines.push(`${slowSearchesHeading(stats.slowSearches)}:`);
  const shownSlow = stats.slowSearches.top.slice(0, SLOW_SEARCH_ROW_CAP);
  textLines.push(...(shownSlow.length ? shownSlow.map((r) => `  ${slowSearchRow(r)}`) : ['  none']));
  // The trailing windows render on quiet days too — that is when they matter.
  for (const [label, w] of windowsOf(stats)) {
    textLines.push('');
    textLines.push(`${windowHeading(label, w)}:`);
    textLines.push(...(w.users.length ? activityTextLines(w.users) : ['  No user activity in this window.']));
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

  const activityHtml = activityTableHtml(stats.activeUsers, 'No user activity.');
  const slowSearchesHtml = `<h2 style="margin:18px 0 6px 0;font-size:14px;">${escapeHtml(slowSearchesHeading(stats.slowSearches))}</h2>${
    shownSlow.length
      ? `<ul style="margin:0;padding-left:18px;font-size:12px;color:#333;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;word-break:break-all;">${shownSlow
          .map((r) => `<li>${escapeHtml(slowSearchRow(r))}</li>`)
          .join('')}</ul>`
      : `<p style="margin:0;font-size:13px;color:#6b7280;">none</p>`
  }`;
  const windowsHtml = windowsOf(stats)
    .map(
      ([label, w]) =>
        `<h2 style="margin:18px 0 6px 0;font-size:14px;">${escapeHtml(windowHeading(label, w))}</h2>${activityTableHtml(w.users, 'No user activity in this window.')}`,
    )
    .join('');

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
    <h2 style="margin:18px 0 6px 0;font-size:14px;">Daily active users (${stats.activeUsers.length})</h2>
    ${activityHtml}`
    }
    ${slowSearchesHtml}
    ${windowsHtml}
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

/** The two trailing-window sections, in render order. */
function windowsOf(stats: AbuseDigestStats): Array<[string, ActiveUsersWindow]> {
  return [
    ['Weekly', stats.weeklyActiveUsers],
    ['Monthly', stats.monthlyActiveUsers],
  ];
}

/** e.g. "Weekly active users (12) · Sep 9 – Sep 15" */
function windowHeading(label: string, w: ActiveUsersWindow): string {
  return `${label} active users (${w.users.length}) · ${fmtDay(w.startDay)} – ${fmtDay(w.endDay)}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** '2026-07-06' → 'Jul 6'. String-based so no timezone can shift the day. */
function fmtDay(day: string): string {
  const [, m, d] = day.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}`;
}

/** Text rows for one per-user table, capped like the HTML table. */
function activityTextLines(users: PerUserActivity[]): string[] {
  const shown = users.slice(0, ACTIVE_USER_ROW_CAP);
  const dropped = users.length - shown.length;
  const lines = shown.map(
    (u) =>
      `  ${u.email}: ${u.explorerQueries} queries, ${u.detailViews} detail views, ` +
      `${u.productsQueries} product searches, ${u.productViews} product views, ` +
      `${u.watchlistAdds} watchlist adds, ${u.savedViewsCreated} views, ${u.customCategoriesCreated} categories, ${u.exports} exports` +
      `, ${u.mcpRequests} MCP calls (${u.mcpRows} rows), ${u.mcpWrites} MCP writes`,
  );
  if (dropped > 0) lines.push(`  ...and ${dropped} more active users`);
  return lines;
}

/** One per-user table (daily, weekly, monthly all share it), capped at ACTIVE_USER_ROW_CAP rows. */
function activityTableHtml(users: PerUserActivity[], emptyText: string): string {
  if (users.length === 0) return `<p style="margin:0;font-size:13px;color:#6b7280;">${emptyText}</p>`;
  const shown = users.slice(0, ACTIVE_USER_ROW_CAP);
  const dropped = users.length - shown.length;
  return `<table style="border-collapse:collapse;width:100%;font-size:12px;">
        <thead><tr style="text-align:left;color:#555;border-bottom:1px solid #e5e7eb;">
          <th style="padding:5px 8px 5px 0;">User</th>
          <th style="padding:5px 8px;text-align:right;">Queries</th>
          <th style="padding:5px 8px;text-align:right;">Detail views</th>
          <th style="padding:5px 8px;text-align:right;">Products</th>
          <th style="padding:5px 8px;text-align:right;">Product views</th>
          <th style="padding:5px 8px;text-align:right;">Watchlist adds</th>
          <th style="padding:5px 8px;text-align:right;">Saved views</th>
          <th style="padding:5px 8px;text-align:right;">Categories</th>
          <th style="padding:5px 0 5px 8px;text-align:right;">Exports</th>
          <th style="padding:5px 0 5px 8px;text-align:right;">MCP calls</th>
          <th style="padding:5px 0 5px 8px;text-align:right;">MCP rows</th>
          <th style="padding:5px 0 5px 8px;text-align:right;">MCP writes</th>
        </tr></thead>
        <tbody>${shown
          .map(
            (u) => `<tr style="border-bottom:1px solid #f3f4f6;">
          <td style="padding:5px 8px 5px 0;">${escapeHtml(u.email)}</td>
          <td style="padding:5px 8px;text-align:right;">${u.explorerQueries.toLocaleString()}</td>
          <td style="padding:5px 8px;text-align:right;">${u.detailViews.toLocaleString()}</td>
          <td style="padding:5px 8px;text-align:right;">${u.productsQueries.toLocaleString()}</td>
          <td style="padding:5px 8px;text-align:right;">${u.productViews.toLocaleString()}</td>
          <td style="padding:5px 8px;text-align:right;">${u.watchlistAdds.toLocaleString()}</td>
          <td style="padding:5px 8px;text-align:right;">${u.savedViewsCreated.toLocaleString()}</td>
          <td style="padding:5px 8px;text-align:right;">${u.customCategoriesCreated.toLocaleString()}</td>
          <td style="padding:5px 0 5px 8px;text-align:right;">${u.exports.toLocaleString()}</td>
          <td style="padding:5px 0 5px 8px;text-align:right;">${u.mcpRequests.toLocaleString()}</td>
          <td style="padding:5px 0 5px 8px;text-align:right;">${u.mcpRows.toLocaleString()}</td>
          <td style="padding:5px 0 5px 8px;text-align:right;">${u.mcpWrites.toLocaleString()}</td>
        </tr>`,
          )
          .join('')}</tbody>
      </table>${dropped > 0 ? `<p style="margin:6px 0 0 0;font-size:12px;color:#6b7280;">…and ${dropped} more active users</p>` : ''}`;
}

/** e.g. "Slow product searches (timeouts 2, slow 5)": the day's true counts, whatever the list shows. */
function slowSearchesHeading(s: SlowSearchesSummary): string {
  return `Slow product searches (timeouts ${s.timeouts}, slow ${s.slow})`;
}

/**
 * e.g. "3× by 2 account(s): broad=Home&sort=keywords", or "3× by 2 account(s), 1 via AI tools: …" when some of the
 * occurrences came from the search_products tool (unescaped; the html escapes the whole row).
 */
function slowSearchRow(r: SlowSearchesSummary['top'][number]): string {
  // An empty string is the default list (no filter, sort or page in the URL).
  const query = r.queryString === '' ? '(no filters)' : truncateForDisplay(r.queryString, SLOW_SEARCH_DISPLAY_CHARS);
  const viaTool = r.viaTool > 0 ? `, ${r.viaTool} via AI tools` : '';
  return `${r.occurrences}× by ${r.accounts} account(s)${viaTool}: ${query}`;
}

/**
 * `s` cut to `max` characters plus "… (+N chars)" when longer, else `s` itself. Cut before any escaping, so N counts
 * stored characters and no entity is split. (The recorded strings are URL query strings, so ASCII: no surrogate
 * pair to split either.)
 */
function truncateForDisplay(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}… (+${s.length - max} chars)`;
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
