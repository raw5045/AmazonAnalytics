/**
 * Pure function: produce the subject/text/html for the calibration-
 * upload completion email. Three outcomes mirror buildEnrichmentEmail:
 *
 *   completed (green ✓):  full pipeline succeeded — BA + POE/SQP
 *                          ingested; when the upload included an SQP
 *                          file, a DRY-RUN fit report (nothing
 *                          persisted — go-live is the owner-gated
 *                          `scripts/fitVolumeModel.ts --persist`).
 *                          Body shows fit params, MAPE bands, POE
 *                          cross-validation, and level vs production.
 *   failed    (red ✗):    a phase failed (BA, POE, SQP, or fit). Body
 *                          shows which phase + the error message + any
 *                          partial progress.
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
  // SQP-era report fields (spec 2026-07-16). Optional so an in-flight
  // event from a pre-SQP worker still renders instead of crashing —
  // treat a missing `persisted` as the legacy always-persisted behavior.
  /** False = dry-run (nothing written); go-live needs --persist. */
  persisted?: boolean;
  /** The anchor pair used (always an SQP pair). */
  anchor?: { rank: number; volume: number };
  /** POE head-supplement pairs admitted above the SQP anchor. */
  nPoeHeadPairs?: number;
  /** Pairs dropped by the iterative under-trim. */
  nDroppedAsOutliers?: number;
  /** predictVolumeFromFit(1, fit) — the owner's monthly gut-check. */
  impliedRank1Volume?: number;
  /** New fit scored against the month's POE pairs (validation only). */
  poeValidation?: {
    overall: number | null;
    top1k: number | null;
    rank1kTo10k: number | null;
    rank10kTo100k: number | null;
    above100k: number | null;
  } | null;
  /** Median new÷production predicted-volume ratio per band. */
  levelDeltaVsProduction?: {
    top1k: number;
    rank1kTo10k: number;
    rank10kTo100k: number;
    above100k: number;
  } | null;
}

export interface CalibrationEmailInput {
  outcome: CalibrationEmailOutcome;
  monthEndDate: string;
  baFilename: string;
  poeFilename?: string | null;
  sqpFilename?: string | null;
  appUrl: string;
  errorPhase?: string | null;
  errorMessage?: string | null;
  baRowsUpserted?: number | null;
  poeRowsUpserted?: number | null;
  sqpRowsUpserted?: number | null;
  /** Non-blocking SQP warning (e.g. file's own month ≠ the form month). */
  sqpWarning?: string | null;
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
  const fit = i.fit;
  const dryRun = !!fit && fit.persisted === false;
  const subject = fit
    ? dryRun
      ? `✓ Calibration dry-run fit report — ${i.monthEndDate}`
      : `✓ Volume calibration map ready — ${i.monthEndDate}`
    : `✓ Calibration data ingested — ${i.monthEndDate}`;
  const lines = [
    fit
      ? dryRun
        ? `The dry-run calibration fit report for ${i.monthEndDate} is ready.`
        : `The volume calibration map for ${i.monthEndDate} is ready.`
      : `The calibration data for ${i.monthEndDate} is ingested.`,
    '',
    `Files ingested:`,
    `  Monthly BA:  ${i.baFilename}  (${formatNumber(i.baRowsUpserted)} rows)`,
    ...(i.poeFilename
      ? [`  POE sample:  ${i.poeFilename}  (${formatNumber(i.poeRowsUpserted)} rows)`]
      : []),
    ...(i.sqpFilename
      ? [`  SQP monthly: ${i.sqpFilename}  (${formatNumber(i.sqpRowsUpserted)} rows)`]
      : []),
    ...(i.sqpWarning ? ['', `⚠ ${i.sqpWarning}`] : []),
    '',
    fit
      ? fitReportText(fit)
      : i.sqpFilename
        ? '(No fit produced — check logs.)'
        : 'No fit run — POE-only uploads store validation data; upload an SQP\nmonthly export to produce a fit report (SQP trains the model).',
    '',
    ...(dryRun
      ? [
          `DRY RUN — not persisted. To go live: scripts/fitVolumeModel.ts --persist (owner-gated).`,
          '',
          `Nothing changed in production — detail pages and kcs estimates still`,
          `use the current persisted fit.`,
        ]
      : fit
        ? [
            `Estimated search volumes for the ${monthLabel(i.monthEndDate)} weeks will`,
            `update on the next explorer + detail page render.`,
          ]
        : []),
    '',
    `View latest data: ${explorerUrl}`,
  ];

  const html = htmlShell({
    headlineColor: '#15803d',
    headline: fit
      ? dryRun
        ? '✓ Calibration dry-run fit report'
        : '✓ Volume calibration map ready'
      : '✓ Calibration data ingested',
    subhead: `Month of ${escapeHtml(i.monthEndDate)}`,
    rows: [
      ['Monthly BA', `${escapeHtml(i.baFilename)} <span style="color:#999;">(${formatNumber(i.baRowsUpserted)} rows)</span>`],
      ...(i.poeFilename
        ? [
            ['POE sample', `${escapeHtml(i.poeFilename)} <span style="color:#999;">(${formatNumber(i.poeRowsUpserted)} rows)</span>`] as [string, string],
          ]
        : []),
      ...(i.sqpFilename
        ? [
            ['SQP monthly', `${escapeHtml(i.sqpFilename)} <span style="color:#999;">(${formatNumber(i.sqpRowsUpserted)} rows)</span>`] as [string, string],
          ]
        : []),
      ...(i.sqpWarning
        ? [
            ['⚠ SQP month', `<span style="color:#b45309;">${escapeHtml(i.sqpWarning)}</span>`] as [string, string],
          ]
        : []),
      ...(fit
        ? [
            ['β (rank decay)', fit.beta.toFixed(4)] as [string, string],
            ['A (scale factor)', formatNumber(fit.scaleFactor)] as [string, string],
            ['Anchor (SQP)', fit.anchor ? `rank ${formatNumber(fit.anchor.rank)} → ${formatNumber(fit.anchor.volume)}/mo` : '—'] as [string, string],
            ['Implied rank-1 vol', formatNumber(fit.impliedRank1Volume)] as [string, string],
            ['Calibration pairs', `${formatNumber(fit.nPairs)} <span style="color:#999;">(${formatNumber(fit.nPoeHeadPairs)} POE head)</span>`] as [string, string],
            ['Outliers trimmed', formatNumber(fit.nDroppedAsOutliers)] as [string, string],
            ['Overall MAPE', formatPct(fit.mapeOverall)] as [string, string],
            ['1k-10k MAPE (key)', formatPct(fit.mape1k10k)] as [string, string],
            ['POE val. MAPE', formatPct(fit.poeValidation?.overall)] as [string, string],
            ['Level Δ 1k-10k', formatRatio(fit.levelDeltaVsProduction?.rank1kTo10k)] as [string, string],
          ]
        : []),
    ],
    afterRowsHtml: dryRun
      ? '<p style="margin:16px 0 0 0;padding:8px 12px;background:#fef3c7;border:1px solid #f59e0b;color:#92400e;font-weight:600;">' +
        'DRY RUN — not persisted. To go live: <code>scripts/fitVolumeModel.ts --persist</code> (owner-gated).</p>' +
        '<p style="margin:12px 0 0 0;color:#555;">Nothing changed in production — detail pages and kcs estimates still use the current persisted fit.</p>'
      : fit
        ? '<p style="margin:16px 0 0 0;color:#555;">Estimated volumes for the ' +
          `${escapeHtml(monthLabel(i.monthEndDate))} weeks will update on the next ` +
          'render.</p>'
        : '<p style="margin:16px 0 0 0;color:#555;">POE-only uploads store validation data; upload an SQP monthly export to produce a fit report.</p>',
    linkUrl: explorerUrl,
    linkText: 'Open the explorer',
  });
  return { subject, text: lines.join('\n'), html };
}

/** Plain-text fit report — the full dry-run/persist run summary. */
function fitReportText(fit: CalibrationEmailFit): string {
  return [
    `Fitted model${fit.persisted === false ? ' (DRY RUN)' : ''}:`,
    `  β (rank decay):     ${fit.beta.toFixed(4)}`,
    `  A (scale factor):   ${formatNumber(fit.scaleFactor)}`,
    `  Anchor (SQP):       ${fit.anchor ? `rank ${formatNumber(fit.anchor.rank)} → ${formatNumber(fit.anchor.volume)}/mo` : '—'}`,
    `  Implied rank-1 vol: ${formatNumber(fit.impliedRank1Volume)}`,
    `  Calibration pairs:  ${formatNumber(fit.nPairs)} (${formatNumber(fit.nPoeHeadPairs)} POE head supplements)`,
    `  Outliers trimmed:   ${formatNumber(fit.nDroppedAsOutliers)}`,
    ``,
    `Holdout MAPE (lower is better):`,
    `  Overall:           ${formatPct(fit.mapeOverall)}`,
    `  Top 1k:            ${formatPct(fit.mapeTop1k)}`,
    `  1k-10k:            ${formatPct(fit.mape1k10k)}  ← most decision-relevant`,
    `  10k-100k:          ${formatPct(fit.mape10k100k)}`,
    `  100k+:             ${formatPct(fit.mapeAbove100k)}`,
    ``,
    `POE cross-validation MAPE (different source units — watch drift, not level):`,
    ...(fit.poeValidation
      ? [
          `  Overall:           ${formatPct(fit.poeValidation.overall)}`,
          `  Top 1k:            ${formatPct(fit.poeValidation.top1k)}`,
          `  1k-10k:            ${formatPct(fit.poeValidation.rank1kTo10k)}`,
          `  10k-100k:          ${formatPct(fit.poeValidation.rank10kTo100k)}`,
          `  100k+:             ${formatPct(fit.poeValidation.above100k)}`,
        ]
      : [`  (no POE pairs for this month)`]),
    ``,
    `Level vs production fit (new ÷ current, by band):`,
    ...(fit.levelDeltaVsProduction
      ? [
          `  Top 1k:            ${formatRatio(fit.levelDeltaVsProduction.top1k)}`,
          `  1k-10k:            ${formatRatio(fit.levelDeltaVsProduction.rank1kTo10k)}`,
          `  10k-100k:          ${formatRatio(fit.levelDeltaVsProduction.rank10kTo100k)}`,
          `  100k+:             ${formatRatio(fit.levelDeltaVsProduction.above100k)}`,
        ]
      : [`  (no production fit to compare against)`]),
  ].join('\n');
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
    `  SQP rows upserted:  ${formatNumber(i.sqpRowsUpserted)}`,
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
      ['SQP rows upserted', formatNumber(i.sqpRowsUpserted)],
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

/** New÷production level ratio, e.g. `×0.55 (−45%)`. */
function formatRatio(r: number | null | undefined): string {
  if (r === null || r === undefined || !Number.isFinite(r)) return '—';
  const pct = (r - 1) * 100;
  return `×${r.toFixed(2)} (${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(0)}%)`;
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
