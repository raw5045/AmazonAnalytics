/**
 * Pure function: produce the subject/text/html for the calibration-
 * upload completion email. Three outcomes mirror buildEnrichmentEmail:
 *
 *   completed (green ✓):  full pipeline succeeded — BA + POE ingested,
 *                          model fit, written to model_calibration_runs.
 *                          Body shows fit params + MAPE by rank band.
 *   failed    (red ✗):    a phase failed (BA, POE, or fit). Body shows
 *                          which phase + the error message + any partial
 *                          progress.
 *   orphaned  (amber ⚠):  orchestrator timed out waiting for worker
 *                          completion. Worker may still be running or
 *                          may have died — manual investigation.
 */

export type CalibrationEmailOutcome = 'completed' | 'failed' | 'orphaned';

export interface CalibrationEmailFit {
  beta: number;
  scaleFactor: number;
  nPairs: number;
  mapeOverall: number | null;
  mapeTop1k: number | null;
  mape1k10k: number | null;
  mape10k100k: number | null;
  mapeAbove100k: number | null;
}

export interface CalibrationEmailInput {
  outcome: CalibrationEmailOutcome;
  monthEndDate: string;
  baFilename: string;
  poeFilename: string;
  appUrl: string;
  errorPhase?: string | null;
  errorMessage?: string | null;
  baRowsUpserted?: number | null;
  poeRowsUpserted?: number | null;
  fit?: CalibrationEmailFit | null;
}

export interface BuiltCalibrationEmail {
  subject: string;
  text: string;
  html: string;
}

export function buildCalibrationEmail(i: CalibrationEmailInput): BuiltCalibrationEmail {
  switch (i.outcome) {
    case 'completed':
      return buildCompleted(i);
    case 'failed':
      return buildFailed(i);
    case 'orphaned':
      return buildOrphaned(i);
  }
}

function buildCompleted(i: CalibrationEmailInput): BuiltCalibrationEmail {
  const explorerUrl = `${i.appUrl}/explorer`;
  const subject = `✓ Volume calibration map ready — ${i.monthEndDate}`;
  const fit = i.fit;
  const lines = [
    `The volume calibration map for ${i.monthEndDate} is ready.`,
    '',
    `Files ingested:`,
    `  Monthly BA:  ${i.baFilename}  (${formatNumber(i.baRowsUpserted)} rows)`,
    `  POE sample:  ${i.poeFilename}  (${formatNumber(i.poeRowsUpserted)} rows)`,
    '',
    fit
      ? [
          `Fitted model:`,
          `  β (rank decay):     ${fit.beta.toFixed(4)}`,
          `  A (scale factor):   ${formatNumber(fit.scaleFactor)}`,
          `  Calibration pairs:  ${formatNumber(fit.nPairs)}`,
          ``,
          `Validation MAPE (lower is better):`,
          `  Overall:           ${formatPct(fit.mapeOverall)}`,
          `  Top 1k:            ${formatPct(fit.mapeTop1k)}`,
          `  1k-10k:            ${formatPct(fit.mape1k10k)}  ← most decision-relevant`,
          `  10k-100k:          ${formatPct(fit.mape10k100k)}`,
          `  100k+:             ${formatPct(fit.mapeAbove100k)}`,
        ].join('\n')
      : '(No fit produced — check logs.)',
    '',
    `Estimated search volumes for the ${monthLabel(i.monthEndDate)} weeks will`,
    `update on the next explorer + detail page render.`,
    '',
    `View latest data: ${explorerUrl}`,
  ];

  const html = htmlShell({
    headlineColor: '#15803d',
    headline: '✓ Volume calibration map ready',
    subhead: `Month of ${escapeHtml(i.monthEndDate)}`,
    rows: [
      ['Monthly BA', `${escapeHtml(i.baFilename)} <span style="color:#999;">(${formatNumber(i.baRowsUpserted)} rows)</span>`],
      ['POE sample', `${escapeHtml(i.poeFilename)} <span style="color:#999;">(${formatNumber(i.poeRowsUpserted)} rows)</span>`],
      ...(fit
        ? [
            ['β (rank decay)', fit.beta.toFixed(4)] as [string, string],
            ['A (scale factor)', formatNumber(fit.scaleFactor)] as [string, string],
            ['Calibration pairs', formatNumber(fit.nPairs)] as [string, string],
            ['Overall MAPE', formatPct(fit.mapeOverall)] as [string, string],
            ['1k-10k MAPE (key)', formatPct(fit.mape1k10k)] as [string, string],
          ]
        : []),
    ],
    afterRowsHtml:
      '<p style="margin:16px 0 0 0;color:#555;">Estimated volumes for the ' +
      `${escapeHtml(monthLabel(i.monthEndDate))} weeks will update on the next ` +
      'render.</p>',
    linkUrl: explorerUrl,
    linkText: 'Open the explorer',
  });
  return { subject, text: lines.join('\n'), html };
}

function buildFailed(i: CalibrationEmailInput): BuiltCalibrationEmail {
  const explorerUrl = `${i.appUrl}/explorer`;
  const subject = `✗ Volume calibration failed — ${i.monthEndDate}`;
  const lines = [
    `The volume calibration map for ${i.monthEndDate} did not complete.`,
    '',
    `Failed phase:  ${i.errorPhase ?? '(unknown)'}`,
    `Error:         ${i.errorMessage ?? '(no message captured)'}`,
    '',
    `Partial progress:`,
    `  BA rows upserted:   ${formatNumber(i.baRowsUpserted)}`,
    `  POE rows upserted:  ${formatNumber(i.poeRowsUpserted)}`,
    '',
    `Whatever was ingested before the failure is committed to the database.`,
    `Fix the underlying issue and re-upload — the ingests are idempotent`,
    `(ON CONFLICT DO UPDATE) and the fit will use the latest data.`,
    '',
    `View partial data: ${explorerUrl}`,
  ];
  const html = htmlShell({
    headlineColor: '#b91c1c',
    headline: '✗ Volume calibration failed',
    subhead: `Month of ${escapeHtml(i.monthEndDate)}`,
    rows: [
      ['Failed phase', escapeHtml(i.errorPhase ?? '(unknown)')],
      ['Error', `<code style="font-size:12px;">${escapeHtml(i.errorMessage ?? '(no message captured)')}</code>`],
      ['BA rows upserted', formatNumber(i.baRowsUpserted)],
      ['POE rows upserted', formatNumber(i.poeRowsUpserted)],
    ],
    afterRowsHtml:
      '<p style="margin:16px 0 0 0;color:#555;">Partial ingests are committed (idempotent). Fix the underlying issue and re-upload.</p>',
    linkUrl: explorerUrl,
    linkText: 'View partial data',
  });
  return { subject, text: lines.join('\n'), html };
}

function buildOrphaned(i: CalibrationEmailInput): BuiltCalibrationEmail {
  const explorerUrl = `${i.appUrl}/explorer`;
  const subject = `⚠ Volume calibration interrupted — ${i.monthEndDate}`;
  const lines = [
    `The volume calibration upload for ${i.monthEndDate} did not finish in`,
    `time. The orchestrator gave up waiting for the worker after 1h.`,
    '',
    `Likely cause:  ${i.errorMessage ?? 'Worker process stopped responding (Railway redeploy, OOM, or hung process).'}`,
    '',
    `What to do:`,
    `  - Check the Inngest dashboard for the run state`,
    `  - Check Railway worker logs for crashes around the upload time`,
    `  - The ingests + fit may still complete if the worker is alive;`,
    `    refresh the explorer in 30 min to see if the data shows up`,
    `  - If nothing landed, re-upload via /admin/upload-calibration`,
    '',
    `View data: ${explorerUrl}`,
  ];
  const html = htmlShell({
    headlineColor: '#b45309',
    headline: '⚠ Volume calibration interrupted',
    subhead: `Month of ${escapeHtml(i.monthEndDate)}`,
    rows: [
      ['Likely cause', `<span style="font-size:13px;">${escapeHtml(i.errorMessage ?? 'Worker stopped responding.')}</span>`],
    ],
    afterRowsHtml:
      '<p style="margin:16px 0 0 0;color:#555;">Check Inngest + Railway logs. The ingests + fit may still complete if the worker is alive.</p>',
    linkUrl: explorerUrl,
    linkText: 'View data',
  });
  return { subject, text: lines.join('\n'), html };
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
        `<tr><td style="padding:4px 12px 4px 0;color:#555;vertical-align:top;">${escapeHtml(label)}</td>` +
        `<td style="padding:4px 0;font-family:ui-monospace,Menlo,monospace;">${value}</td></tr>`,
    )
    .join('');
  return `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;padding:24px;">
  <h1 style="margin:0 0 8px 0;color:${headlineColor};font-size:18px;">${headline}</h1>
  <p style="margin:0 0 16px 0;color:#333;">${subhead}</p>
  <table style="border-collapse:collapse;font-size:14px;">${tableRows}</table>
  ${afterRowsHtml ?? ''}
  <p style="margin:24px 0 0 0;"><a href="${linkUrl}" style="color:#2563eb;">${linkText} →</a></p>
</div>`.trim();
}

function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return n.toLocaleString();
}

function formatPct(p: number | null | undefined): string {
  if (p === null || p === undefined || !Number.isFinite(p)) return '—';
  return `${(p * 100).toFixed(1)}%`;
}

function monthLabel(yyyyMmDd: string): string {
  const m = yyyyMmDd.match(/^(\d{4})-(\d{2})-\d{2}$/);
  if (!m) return yyyyMmDd;
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  const monthIdx = parseInt(m[2], 10) - 1;
  if (monthIdx < 0 || monthIdx > 11) return yyyyMmDd;
  return `${months[monthIdx]} ${m[1]}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
