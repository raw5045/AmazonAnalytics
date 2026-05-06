/**
 * Pure function: produce the email subject/text/html for one of the
 * three import-outcome variants. Kept separate from the Resend send
 * so we can snapshot-test the templates without hitting the network.
 *
 * Outcomes:
 *   - 'completed'                       full success
 *   - 'completed_with_refresh_failure'  kwm rows landed; kcs refresh failed
 *   - 'failed'                          import did not complete; data not in kwm
 */

export type ImportOutcome =
  | 'completed'
  | 'completed_with_refresh_failure'
  | 'failed';

export interface ImportEmailInput {
  outcome: ImportOutcome;
  filename: string;
  /** UUID — embedded in the link to the batch detail page. */
  batchId: string;
  /** Optional duration; rendered as e.g. "32 min". */
  durationMs?: number;
  /** Rows imported into kwm (success path). */
  rowsImported?: number;
  /** Rows in keyword_current_summary after refresh (success path). */
  rowsInSummary?: number;
  /** Latest week_end_date (e.g., '2026-04-25') — success path. */
  latestWeek?: string;
  /** Worker phase at time of failure — failure paths. */
  lastPhase?: string;
  /** Error message — failure paths. */
  errorMessage?: string;
  /** App's public URL — used to build the batch detail link. */
  appUrl: string;
}

export interface BuiltEmail {
  subject: string;
  text: string;
  html: string;
}

export function buildImportEmail(input: ImportEmailInput): BuiltEmail {
  switch (input.outcome) {
    case 'completed':
      return buildSuccess(input);
    case 'completed_with_refresh_failure':
      return buildRefreshFailure(input);
    case 'failed':
      return buildHardFailure(input);
  }
}

function buildSuccess(i: ImportEmailInput): BuiltEmail {
  const subject = `✓ Import succeeded: ${i.filename}`;
  const linkUrl = `${i.appUrl}/admin/batches/${i.batchId}`;
  const lines = [
    `The weekly import of ${i.filename} completed successfully.`,
    '',
    `Duration:           ${formatDuration(i.durationMs)}`,
    `Rows imported:      ${formatNumber(i.rowsImported)}`,
    `Rows in summary:    ${formatNumber(i.rowsInSummary)}`,
    `Latest week:        ${i.latestWeek ?? '—'}`,
    '',
    `View details: ${linkUrl}`,
  ];
  const html = htmlShell({
    headlineColor: '#15803d',
    headline: '✓ Import succeeded',
    filename: i.filename,
    rows: [
      ['Duration', formatDuration(i.durationMs)],
      ['Rows imported', formatNumber(i.rowsImported)],
      ['Rows in summary', formatNumber(i.rowsInSummary)],
      ['Latest week', i.latestWeek ?? '—'],
    ],
    linkUrl,
    linkText: 'View details',
  });
  return { subject, text: lines.join('\n'), html };
}

function buildRefreshFailure(i: ImportEmailInput): BuiltEmail {
  const subject = `⚠ Import OK but summary stale: ${i.filename}`;
  const linkUrl = `${i.appUrl}/admin/batches/${i.batchId}`;
  const lines = [
    `The weekly import of ${i.filename} landed cleanly into kwm but the keyword_current_summary refresh failed.`,
    '',
    `The explorer will continue to show the prior week's snapshot until you run:`,
    `  pnpm tsx scripts/refreshSummaryOnce.ts`,
    '',
    `Refresh error: ${i.errorMessage ?? '(none captured)'}`,
    '',
    `View details: ${linkUrl}`,
  ];
  const html = htmlShell({
    headlineColor: '#b45309',
    headline: '⚠ Import OK, summary stale',
    filename: i.filename,
    rows: [
      ['Recover with', '<code>pnpm tsx scripts/refreshSummaryOnce.ts</code>'],
      ['Refresh error', escapeHtml(i.errorMessage ?? '(none captured)')],
    ],
    linkUrl,
    linkText: 'View details',
  });
  return { subject, text: lines.join('\n'), html };
}

function buildHardFailure(i: ImportEmailInput): BuiltEmail {
  const subject = `✗ Import failed: ${i.filename}`;
  const linkUrl = `${i.appUrl}/admin/batches/${i.batchId}`;
  const lines = [
    `The weekly import of ${i.filename} did not complete.`,
    '',
    `Last phase: ${i.lastPhase ?? 'unknown'}`,
    `Error:      ${i.errorMessage ?? '(none captured)'}`,
    '',
    `The data did NOT make it into kwm. Re-upload the file once the issue is fixed.`,
    '',
    `View details: ${linkUrl}`,
  ];
  const html = htmlShell({
    headlineColor: '#b91c1c',
    headline: '✗ Import failed',
    filename: i.filename,
    rows: [
      ['Last phase', i.lastPhase ?? 'unknown'],
      ['Error', escapeHtml(i.errorMessage ?? '(none captured)')],
    ],
    linkUrl,
    linkText: 'View details',
    afterRowsHtml: '<p style="margin: 16px 0 0 0; color: #555;">The data did <strong>NOT</strong> make it into kwm. Re-upload the file once the issue is fixed.</p>',
  });
  return { subject, text: lines.join('\n'), html };
}

function htmlShell({
  headlineColor,
  headline,
  filename,
  rows,
  linkUrl,
  linkText,
  afterRowsHtml,
}: {
  headlineColor: string;
  headline: string;
  filename: string;
  rows: Array<[label: string, value: string]>;
  linkUrl: string;
  linkText: string;
  afterRowsHtml?: string;
}): string {
  const tableRows = rows
    .map(
      ([label, value]) =>
        `<tr><td style="padding: 4px 12px 4px 0; color: #555;">${escapeHtml(label)}</td><td style="padding: 4px 0; font-family: ui-monospace, Menlo, monospace;">${value}</td></tr>`,
    )
    .join('');
  return `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; padding: 24px;">
  <h1 style="margin: 0 0 8px 0; color: ${headlineColor}; font-size: 18px;">${headline}</h1>
  <p style="margin: 0 0 16px 0; color: #333;"><strong>${escapeHtml(filename)}</strong></p>
  <table style="border-collapse: collapse; font-size: 14px;">${tableRows}</table>
  ${afterRowsHtml ?? ''}
  <p style="margin: 24px 0 0 0;"><a href="${linkUrl}" style="color: #2563eb;">${linkText} →</a></p>
</div>`.trim();
}

function formatDuration(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms)) return '—';
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec} s`;
  const min = Math.round(totalSec / 60);
  return `${min} min`;
}

function formatNumber(n?: number): string {
  if (n === undefined || !Number.isFinite(n)) return '—';
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
