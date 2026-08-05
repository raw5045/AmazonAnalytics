// lib/notifications/digest/buildDigestEmail.ts
/**
 * Pure builder for the weekly digest email. Mirrors buildImportEmail.ts:
 * no network, returns { subject, text, html } so it can be snapshot/unit
 * tested. The caller passes a fully-signed unsubscribeUrl and (for the
 * watchlist variant) rows already sorted gains-first (signed movement,
 * biggest declines last — see groupAndSortWatchlistRows).
 *
 * See docs/superpowers/specs/2026-05-31-weekly-digest-email-design.md §7.
 */
import type { BuiltEmail, DigestKeywordRow } from './types';

interface CommonInput {
  weekEndDate: string;
  appUrl: string;
  unsubscribeUrl: string;   // already token-signed by the caller
}
interface BroadcastInput extends CommonInput { variant: 'broadcast'; }
interface WatchlistInput extends CommonInput {
  variant: 'watchlist';
  rows: DigestKeywordRow[];   // already sorted gains-first (declines last)
}

const GREEN = '#15803d';
const RED = '#b91c1c';
const GRAY = '#6b7280';

export function buildDigestEmail(input: BroadcastInput | WatchlistInput): BuiltEmail {
  return input.variant === 'broadcast' ? buildBroadcast(input) : buildWatchlist(input);
}

function buildBroadcast(i: BroadcastInput): BuiltEmail {
  const subject = 'Amazon Keywords Updated! Explore new week of keyword changes';
  const exploreUrl = `${i.appUrl}/explorer`;
  const text = [
    'Amazon Keywords Updated',
    '',
    `The week of ${i.weekEndDate} is now live. Fresh ranks, deltas, and volume estimates are ready to explore.`,
    '',
    `Explore the keyword data: ${exploreUrl}`,
    '',
    '—',
    `You're receiving this weekly digest because you have an account.`,
    `Unsubscribe: ${i.unsubscribeUrl}`,
  ].join('\n');

  const html = shell(
    `
    <h1 style="margin:0 0 12px 0;font-size:20px;color:#111;">Amazon Keywords Updated</h1>
    <p style="margin:0 0 20px 0;color:#333;font-size:14px;">
      The week of <strong>${escapeHtml(i.weekEndDate)}</strong> is now live. Fresh ranks,
      deltas, and volume estimates are ready to explore.
    </p>
    ${ctaButton(exploreUrl, 'Explore the keyword data →')}
    `,
    i.unsubscribeUrl,
    `You're receiving this weekly digest because you have an account.`,
  );

  return { subject, text, html };
}

function buildWatchlist(i: WatchlistInput): BuiltEmail {
  const subject = 'Amazon Keywords Updated! See what changed in your Watchlist and explore today!';
  const watchlistUrl = `${i.appUrl}/watchlist`;

  const textRows = i.rows.map((r) => {
    if (r.currentRank === null) {
      return `${r.searchTermRaw} — not ranked this week (prior ${fmtNum(r.priorWeekRank)})`;
    }
    return `${r.searchTermRaw} — rank ${fmtNum(r.currentRank)} (prior ${fmtNum(r.priorWeekRank)}, 4w ${fmtNum(r.rank4wAgo)}, Δ ${fmtDeltaText(r.improvement1w)}), est vol ${fmtVol(r.estMonthlyVolume)}`;
  });
  const text = [
    'Amazon Keywords Updated',
    '',
    `The week of ${i.weekEndDate} is live. Here's how your ${i.rows.length} watched keywords moved this week — biggest gains first:`,
    '',
    ...textRows,
    '',
    `Open your watchlist: ${watchlistUrl}`,
    '',
    '—',
    `You're receiving this because you watch keywords on Amazon Analytics.`,
    `Unsubscribe: ${i.unsubscribeUrl}`,
  ].join('\n');

  const tableRows = i.rows.map((r) => rowHtml(r, i.appUrl)).join('');
  const html = shell(
    `
    <h1 style="margin:0 0 12px 0;font-size:20px;color:#111;">Amazon Keywords Updated</h1>
    <p style="margin:0 0 16px 0;color:#333;font-size:14px;">
      The week of <strong>${escapeHtml(i.weekEndDate)}</strong> is live. Here's how your
      <strong>${i.rows.length}</strong> watched keywords moved this week — biggest gains first:
    </p>
    <table style="border-collapse:collapse;width:100%;font-size:13px;">
      <thead>
        <tr style="text-align:left;color:#555;border-bottom:1px solid #e5e7eb;">
          <th style="padding:6px 8px 6px 0;">Keyword</th>
          <th style="padding:6px 8px;text-align:right;">Rank</th>
          <th style="padding:6px 8px;text-align:right;">Prior</th>
          <th style="padding:6px 8px;text-align:right;">4w</th>
          <th style="padding:6px 8px;text-align:right;">Δ 1w</th>
          <th style="padding:6px 0 6px 8px;text-align:right;">Est. vol</th>
        </tr>
      </thead>
      <tbody>${tableRows}</tbody>
    </table>
    <div style="margin-top:20px;">${ctaButton(watchlistUrl, 'Open your watchlist →')}</div>
    `,
    i.unsubscribeUrl,
    `You're receiving this because you watch keywords on Amazon Analytics.`,
  );

  return { subject, text, html };
}

function rowHtml(r: DigestKeywordRow, appUrl: string): string {
  const link = `${appUrl}/explorer/keyword/${encodeURIComponent(r.searchTermId)}`;
  const name = `<a href="${link}" style="color:#2563eb;text-decoration:none;">${escapeHtml(r.searchTermRaw)}</a>`;
  if (r.currentRank === null) {
    return `
      <tr style="border-bottom:1px solid #f3f4f6;color:#9ca3af;">
        <td style="padding:6px 8px 6px 0;">${name}<br><span style="font-size:11px;">not ranked this week</span></td>
        <td style="padding:6px 8px;text-align:right;">—</td>
        <td style="padding:6px 8px;text-align:right;">${fmtNum(r.priorWeekRank)}</td>
        <td style="padding:6px 8px;text-align:right;">${fmtNum(r.rank4wAgo)}</td>
        <td style="padding:6px 8px;text-align:right;">—</td>
        <td style="padding:6px 0 6px 8px;text-align:right;">—</td>
      </tr>`;
  }
  return `
    <tr style="border-bottom:1px solid #f3f4f6;color:#111;">
      <td style="padding:6px 8px 6px 0;">${name}</td>
      <td style="padding:6px 8px;text-align:right;font-variant-numeric:tabular-nums;">${fmtNum(r.currentRank)}</td>
      <td style="padding:6px 8px;text-align:right;font-variant-numeric:tabular-nums;color:#6b7280;">${fmtNum(r.priorWeekRank)}</td>
      <td style="padding:6px 8px;text-align:right;font-variant-numeric:tabular-nums;color:#6b7280;">${fmtNum(r.rank4wAgo)}</td>
      <td style="padding:6px 8px;text-align:right;font-variant-numeric:tabular-nums;">${deltaHtml(r.improvement1w)}</td>
      <td style="padding:6px 0 6px 8px;text-align:right;font-variant-numeric:tabular-nums;">${fmtVol(r.estMonthlyVolume)}</td>
    </tr>`;
}

function deltaHtml(improvement: number | null): string {
  if (improvement === null) return `<span style="color:${GRAY};">—</span>`;
  if (improvement === 0) return `<span style="color:${GRAY};">0</span>`;
  const color = improvement > 0 ? GREEN : RED;
  const sign = improvement > 0 ? '+' : '−';
  return `<span style="color:${color};">${sign}${fmtNum(Math.abs(improvement))}</span>`;
}

function fmtDeltaText(improvement: number | null): string {
  if (improvement === null) return '—';
  if (improvement === 0) return '0';
  return `${improvement > 0 ? '+' : '−'}${fmtNum(Math.abs(improvement))}`;
}

function fmtNum(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US');
}

/** Exact volume with thousands separators — matches the explorer table. */
function fmtVol(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US');
}

function ctaButton(url: string, label: string): string {
  return `<a href="${url}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px;font-size:14px;">${escapeHtml(label)}</a>`;
}

function shell(bodyHtml: string, unsubscribeUrl: string, footerReason: string): string {
  return `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:640px;margin:0 auto;padding:24px;">
  ${bodyHtml}
  <hr style="margin:28px 0 12px 0;border:none;border-top:1px solid #e5e7eb;">
  <p style="margin:0;color:#9ca3af;font-size:12px;">
    ${escapeHtml(footerReason)}<br>
    <a href="${unsubscribeUrl}" style="color:#9ca3af;text-decoration:underline;">Unsubscribe</a>
  </p>
</div>`.trim();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
