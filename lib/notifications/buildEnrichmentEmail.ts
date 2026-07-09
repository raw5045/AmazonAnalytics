/**
 * Pure function: produce the subject/text/html for the Keepa enrichment
 * outcome email. Snapshot-tested via buildEnrichmentEmail.test.ts so we
 * can iterate on the template without hitting Resend.
 *
 * Three outcomes, each with its own subject line + headline color:
 *
 *   'completed' — green ✓ — run finished successfully. The dataset is fresh.
 *   'failed'    — red ✗  — run aborted due to an error in the worker code
 *                          or DB layer. Some rows may have landed but the
 *                          dataset is incomplete and the user should
 *                          investigate before relying on it.
 *   'orphaned'  — amber ⚠ — orchestrator gave up waiting (worker died
 *                          silently, or 24h poll budget exhausted). The
 *                          worker may still be running or may be gone;
 *                          re-firing the event will resume cleanly.
 *
 * Mirrors the three-variant pattern in lib/notifications/buildImportEmail.ts.
 */
import type { AsinEnrichmentStatus } from '@/lib/keepa/types';

export type EnrichmentEmailOutcome = 'completed' | 'failed' | 'orphaned';

export interface EnrichmentEmailInput {
  outcome: EnrichmentEmailOutcome;
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
  /**
   * Required for 'failed' and 'orphaned' variants when known. Surfaced in
   * the email body so the operator has an immediate diagnostic without
   * needing to open Inngest / Railway logs.
   */
  errorMessage?: string;
  /**
   * True when a 'completed' run fetched ZERO ASINs (the week was already
   * covered — e.g. a full refresh fired within 24h of the last fetch pass).
   * Renders a distinct "nothing to fetch" variant so a no-op can never
   * masquerade as a fresh enrichment.
   */
  noop?: boolean;
}

export interface BuiltEnrichmentEmail {
  subject: string;
  text: string;
  html: string;
}

export function buildEnrichmentEmail(i: EnrichmentEmailInput): BuiltEnrichmentEmail {
  switch (i.outcome) {
    case 'completed':
      return buildCompleted(i);
    case 'failed':
      return buildFailed(i);
    case 'orphaned':
      return buildOrphaned(i);
  }
}

function buildCompleted(i: EnrichmentEmailInput): BuiltEnrichmentEmail {
  if (i.noop) return buildCompletedNoop(i);
  const total = countTotal(i.counts);
  const explorerUrl = `${i.appUrl}/explorer`;
  const subject = `✓ Keepa enrichment completed — week of ${i.weekEndDate}`;
  const lines = [
    `Enrichment of the ${i.weekEndDate} week's top-3 ASINs is complete.`,
    '',
    `Duration:           ${formatHours(i.durationMs)}`,
    `ASINs processed:    ${formatNumber(total)}`,
    `Status breakdown:`,
    ...formatStatusLines(i.counts, total),
    `Tokens spent:       ~${formatNumber(i.tokensSpent)}`,
    '',
    `Detail-page product cards and review/rating columns for this week`,
    `are now showing fresh Keepa data.`,
    '',
    `View latest data: ${explorerUrl}`,
  ];
  const html = htmlShell({
    headlineColor: '#15803d',
    headline: '✓ Keepa enrichment completed',
    subhead: `Week of ${escapeHtml(i.weekEndDate)}`,
    rows: standardRows(i, total),
    afterRowsHtml:
      '<p style="margin: 16px 0 0 0; color: #555;">Detail-page product cards and review/rating columns for this week are now showing fresh Keepa data.</p>',
    linkUrl: explorerUrl,
    linkText: 'Open the explorer',
  });
  return { subject, text: lines.join('\n'), html };
}

/**
 * 'completed' run that fetched nothing. Amber, not green — the operator
 * probably expected a re-fetch (this is what a full refresh fired within
 * 24h of the last fetch pass produces).
 */
function buildCompletedNoop(i: EnrichmentEmailInput): BuiltEnrichmentEmail {
  const total = countTotal(i.counts);
  const explorerUrl = `${i.appUrl}/explorer`;
  const subject = `⚠ Keepa enrichment: nothing to fetch — week of ${i.weekEndDate}`;
  const lines = [
    `The enrichment run for week ${i.weekEndDate} completed WITHOUT calling`,
    `the Keepa API: zero ASINs needed fetching.`,
    '',
    `Every in-scope product already has a row for this week fetched within`,
    `the last 24 hours. If you meant to force a full re-fetch, wait until`,
    `the last pass is >24h old and fire it again.`,
    '',
    `The week's existing dataset (unchanged by this run):`,
    ...formatStatusLines(i.counts, total),
    '',
    `View data: ${explorerUrl}`,
  ];
  const html = htmlShell({
    headlineColor: '#b45309',
    headline: '⚠ Keepa enrichment: nothing to fetch',
    subhead: `Week of ${escapeHtml(i.weekEndDate)} — zero Keepa API calls made`,
    rows: [['Existing dataset (unchanged)', formatStatusBreakdownHtml(i.counts, total)]],
    afterRowsHtml:
      '<p style="margin: 16px 0 0 0; color: #555;">Every in-scope product already has a row fetched within the last 24 hours. If you meant to force a full re-fetch, wait until the last pass is &gt;24h old and fire it again.</p>',
    linkUrl: explorerUrl,
    linkText: 'Open the explorer',
  });
  return { subject, text: lines.join('\n'), html };
}

function buildFailed(i: EnrichmentEmailInput): BuiltEnrichmentEmail {
  const total = countTotal(i.counts);
  const explorerUrl = `${i.appUrl}/explorer`;
  const subject = `✗ Keepa enrichment failed — week of ${i.weekEndDate}`;
  const lines = [
    `The Keepa enrichment run for week ${i.weekEndDate} did not complete.`,
    '',
    `Duration before failure:  ${formatHours(i.durationMs)}`,
    `ASINs processed so far:   ${formatNumber(total)}`,
    `Status breakdown:`,
    ...formatStatusLines(i.counts, total),
    `Tokens spent:             ~${formatNumber(i.tokensSpent)}`,
    '',
    `Error:`,
    `  ${i.errorMessage ?? '(no error message captured)'}`,
    '',
    `Some rows may have landed in asin_weekly_data, but the dataset for`,
    `this week is incomplete. Re-fire the keepa.enrich-week-requested`,
    `event once the underlying issue is fixed; the candidate query`,
    `excludes already-enriched ASINs, so the retry will only fetch what's`,
    `missing.`,
    '',
    `View partial data: ${explorerUrl}`,
  ];
  const html = htmlShell({
    headlineColor: '#b91c1c',
    headline: '✗ Keepa enrichment failed',
    subhead: `Week of ${escapeHtml(i.weekEndDate)}`,
    rows: [
      ...standardRows(i, total),
      ['Error', `<code style="font-size: 12px;">${escapeHtml(i.errorMessage ?? '(no error message captured)')}</code>`],
    ],
    afterRowsHtml:
      '<p style="margin: 16px 0 0 0; color: #555;">Some rows may have landed; the dataset for this week is incomplete. Re-fire <code>keepa.enrich-week-requested</code> after fixing the underlying issue — the candidate query excludes already-enriched ASINs.</p>',
    linkUrl: explorerUrl,
    linkText: 'View partial data',
  });
  return { subject, text: lines.join('\n'), html };
}

function buildOrphaned(i: EnrichmentEmailInput): BuiltEnrichmentEmail {
  const total = countTotal(i.counts);
  const explorerUrl = `${i.appUrl}/explorer`;
  const subject = `⚠ Keepa enrichment interrupted — week of ${i.weekEndDate}`;
  const lines = [
    `The Keepa enrichment run for week ${i.weekEndDate} was interrupted.`,
    '',
    `Duration before interrupt:  ${formatHours(i.durationMs)}`,
    `ASINs processed so far:     ${formatNumber(total)}`,
    `Status breakdown:`,
    ...formatStatusLines(i.counts, total),
    `Tokens spent:               ~${formatNumber(i.tokensSpent)}`,
    '',
    `Likely cause:`,
    `  ${i.errorMessage ?? 'Worker process stopped responding (Railway redeploy, platform outage, or hung process). The orchestrator gave up waiting for the completion event.'}`,
    '',
    `The data already in asin_weekly_data is correct and complete for the`,
    `ASINs that were processed. Re-firing the keepa.enrich-week-requested`,
    `event will resume from where we left off — the candidate query`,
    `excludes already-enriched ASINs.`,
    '',
    `View partial data: ${explorerUrl}`,
  ];
  const html = htmlShell({
    headlineColor: '#b45309',
    headline: '⚠ Keepa enrichment interrupted',
    subhead: `Week of ${escapeHtml(i.weekEndDate)}`,
    rows: [
      ...standardRows(i, total),
      ['Likely cause', `<span style="font-size: 13px;">${escapeHtml(i.errorMessage ?? 'Worker stopped responding before sending completion signal.')}</span>`],
    ],
    afterRowsHtml:
      '<p style="margin: 16px 0 0 0; color: #555;">The data already in <code>asin_weekly_data</code> is correct. Re-fire <code>keepa.enrich-week-requested</code> to resume — the candidate query excludes already-enriched ASINs.</p>',
    linkUrl: explorerUrl,
    linkText: 'View partial data',
  });
  return { subject, text: lines.join('\n'), html };
}

/** Shared row set for the HTML rendering of all three variants. */
function standardRows(
  i: EnrichmentEmailInput,
  total: number,
): Array<[string, string]> {
  return [
    ['Duration', formatHours(i.durationMs)],
    ['ASINs processed', formatNumber(total)],
    ['Status breakdown', formatStatusBreakdownHtml(i.counts, total)],
    ['Tokens spent', `~${formatNumber(i.tokensSpent)}`],
  ];
}

function countTotal(counts: Record<AsinEnrichmentStatus, number>): number {
  return counts.active + counts.no_price + counts.delisted + counts.error;
}

function formatStatusLines(
  counts: Record<AsinEnrichmentStatus, number>,
  total: number,
): string[] {
  const pct = (n: number) => (total > 0 ? (n / total) * 100 : 0);
  return [
    `  Active            ${formatNumber(counts.active).padStart(8)}   (${pct(counts.active).toFixed(1)}%)`,
    `  No price          ${formatNumber(counts.no_price).padStart(8)}   (${pct(counts.no_price).toFixed(1)}%)`,
    `  Delisted          ${formatNumber(counts.delisted).padStart(8)}   (${pct(counts.delisted).toFixed(1)}%)`,
    `  Error             ${formatNumber(counts.error).padStart(8)}   (${pct(counts.error).toFixed(1)}%)`,
  ];
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
