/**
 * Pure function: produce the subject/text/html for the Keepa enrichment
 * completion email. Snapshot-tested via buildEnrichmentEmail.test.ts so
 * we can iterate on the template without hitting Resend.
 *
 * Phase 1 has a single 'completed' variant. If error-rate-based variants
 * become useful later (e.g. 'completed_with_high_error_rate' when error
 * % is > 2), add additional cases here following the buildImportEmail
 * three-variant pattern.
 *
 * Separate from the import-completion email because enrichment runs much
 * longer (~19h vs minutes) — users want each completion signal
 * independently rather than batched.
 */
import type { AsinEnrichmentStatus } from '@/lib/keepa/types';

export interface EnrichmentEmailInput {
  /** Week being reported on (ISO date YYYY-MM-DD). */
  weekEndDate: string;
  /** Status histogram from asin_weekly_data for this week. */
  counts: Record<AsinEnrichmentStatus, number>;
  /** Total wall-clock duration of the enrichment run. */
  durationMs: number;
  /** Approximate total Keepa tokens spent (2 per processed ASIN). */
  tokensSpent: number;
  /** App's public URL — used to build the explorer link. */
  appUrl: string;
}

export interface BuiltEnrichmentEmail {
  subject: string;
  text: string;
  html: string;
}

export function buildEnrichmentEmail(i: EnrichmentEmailInput): BuiltEnrichmentEmail {
  const total = i.counts.active + i.counts.no_price + i.counts.delisted + i.counts.error;
  const pct = (n: number) => (total > 0 ? (n / total) * 100 : 0);
  const explorerUrl = `${i.appUrl}/explorer`;

  const subject = `✓ Keepa enrichment completed — week of ${i.weekEndDate}`;

  const text = [
    `Enrichment of the ${i.weekEndDate} week's top-3 ASINs is complete.`,
    '',
    `Duration:           ${formatHours(i.durationMs)}`,
    `ASINs processed:    ${formatNumber(total)}`,
    `Status breakdown:`,
    `  Active            ${formatNumber(i.counts.active).padStart(8)}   (${pct(i.counts.active).toFixed(1)}%)`,
    `  No price          ${formatNumber(i.counts.no_price).padStart(8)}   (${pct(i.counts.no_price).toFixed(1)}%)`,
    `  Delisted          ${formatNumber(i.counts.delisted).padStart(8)}   (${pct(i.counts.delisted).toFixed(1)}%)`,
    `  Error             ${formatNumber(i.counts.error).padStart(8)}   (${pct(i.counts.error).toFixed(1)}%)`,
    `Tokens spent:       ~${formatNumber(i.tokensSpent)}`,
    '',
    `Detail-page product cards and review/rating columns for this week`,
    `are now showing fresh Keepa data.`,
    '',
    `View latest data: ${explorerUrl}`,
  ].join('\n');

  const html = htmlShell({
    headlineColor: '#15803d',
    headline: '✓ Keepa enrichment completed',
    subhead: `Week of ${escapeHtml(i.weekEndDate)}`,
    rows: [
      ['Duration', formatHours(i.durationMs)],
      ['ASINs processed', formatNumber(total)],
      [
        'Status breakdown',
        formatStatusBreakdownHtml(i.counts, total),
      ],
      ['Tokens spent', `~${formatNumber(i.tokensSpent)}`],
    ],
    afterRowsHtml:
      '<p style="margin: 16px 0 0 0; color: #555;">Detail-page product cards and review/rating columns for this week are now showing fresh Keepa data.</p>',
    linkUrl: explorerUrl,
    linkText: 'Open the explorer',
  });

  return { subject, text, html };
}

function formatStatusBreakdownHtml(
  counts: Record<AsinEnrichmentStatus, number>,
  total: number,
): string {
  const pct = (n: number) => (total > 0 ? ((n / total) * 100).toFixed(1) : '0.0');
  const rows = (
    [
      ['Active', counts.active],
      ['No price', counts.no_price],
      ['Delisted', counts.delisted],
      ['Error', counts.error],
    ] as Array<[string, number]>
  )
    .map(
      ([label, n]) =>
        `<tr><td style="padding: 2px 12px 2px 0; color: #555;">${escapeHtml(label)}</td>` +
        `<td style="padding: 2px 12px 2px 0; font-family: ui-monospace, Menlo, monospace; text-align: right;">${formatNumber(n)}</td>` +
        `<td style="padding: 2px 0; color: #999; font-family: ui-monospace, Menlo, monospace;">(${pct(n)}%)</td></tr>`,
    )
    .join('');
  return `<table style="border-collapse: collapse;">${rows}</table>`;
}

function htmlShell({
  headlineColor,
  headline,
  subhead,
  rows,
  linkUrl,
  linkText,
  afterRowsHtml,
}: {
  headlineColor: string;
  headline: string;
  subhead: string;
  rows: Array<[label: string, value: string]>;
  linkUrl: string;
  linkText: string;
  afterRowsHtml?: string;
}): string {
  const tableRows = rows
    .map(
      ([label, value]) =>
        `<tr><td style="padding: 4px 12px 4px 0; color: #555; vertical-align: top;">${escapeHtml(label)}</td>` +
        `<td style="padding: 4px 0; font-family: ui-monospace, Menlo, monospace;">${value}</td></tr>`,
    )
    .join('');
  return `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; padding: 24px;">
  <h1 style="margin: 0 0 8px 0; color: ${headlineColor}; font-size: 18px;">${headline}</h1>
  <p style="margin: 0 0 16px 0; color: #333;">${subhead}</p>
  <table style="border-collapse: collapse; font-size: 14px;">${tableRows}</table>
  ${afterRowsHtml ?? ''}
  <p style="margin: 24px 0 0 0;"><a href="${linkUrl}" style="color: #2563eb;">${linkText} →</a></p>
</div>`.trim();
}

/**
 * Format a millisecond duration as e.g. "18h 42min" or "47min". For very
 * short runs (under a minute), shows seconds.
 */
function formatHours(ms: number | undefined | null): string {
  if (ms === undefined || ms === null || !Number.isFinite(ms)) return '—';
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.round(totalSec / 60);
  if (totalMin < 60) return `${totalMin}min`;
  const hours = Math.floor(totalMin / 60);
  const remMin = totalMin % 60;
  return remMin === 0 ? `${hours}h` : `${hours}h ${remMin}min`;
}

function formatNumber(n: number | undefined | null): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return '—';
  return n.toLocaleString();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
