/**
 * Core ingest logic for SQP calibration CSVs (Brand Analytics → Search
 * Query Performance → Monthly export). Sibling of
 * lib/poeCalibration/ingestCore.ts — same bulk-upsert shape, targeting
 * the structural-mirror table sqp_calibration_data.
 *
 * Parsing is delegated to parseSqpCsv (metadata line, quoted header,
 * MAX-volume dedup on normalized-term collision). The stream is
 * buffered to text first — SQP exports are brand-scoped and small
 * (thousands of rows, not the 100k+-row BA files), and the parser
 * needs the whole file to read the metadata line.
 *
 * The form's monthEndDate is authoritative for the stored rows; when
 * the file's own `Select month` metadata disagrees we import anyway
 * and surface a warning for the completion report (spec 2026-07-16
 * Part 2 — the month field pre-fill stays a suggestion, never a gate).
 *
 * Idempotent: ON CONFLICT (search_term_normalized, month_end_date) DO
 * UPDATE — re-running the same month overwrites the existing snapshot.
 */
import type { Readable } from 'node:stream';
import { Pool, type PoolClient } from 'pg';
import { parseSqpCsv, type ParsedSqpRow } from '@/lib/volumeModel/parseSqpCsv';

export interface IngestSqpResult {
  /** Unique normalized terms after the parser's MAX-volume dedup. */
  uniqueTerms: number;
  upserted: number;
  parseMs: number;
  upsertMs: number;
  /** Month suggested by the file's `Select month` metadata (null for weekly files). */
  suggestedMonthEndDate: string | null;
  /**
   * Non-blocking warning(s) for the completion report: set when the file
   * looks like a WEEKLY export uploaded to the monthly slot, and/or when
   * the file's suggested month ≠ the month it was imported under. Both
   * are concatenated when both apply.
   */
  monthMismatchWarning: string | null;
}

export async function ingestSqpCalibrationFromStream(
  stream: Readable,
  monthEndDate: string,
  sourceFilename: string,
  pool?: Pool,
): Promise<IngestSqpResult> {
  // Phase 1: buffer + parse. parseSqpCsv throws SqpParseError on a
  // malformed file — callers report it like any other phase failure.
  const parseStart = Date.now();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  // Strip a leading UTF-8 BOM so the metadata line's provenance stays clean.
  const text = Buffer.concat(chunks).toString('utf8').replace(/^﻿/, '');
  const parsed = parseSqpCsv(text);
  const parseMs = Date.now() - parseStart;

  const warnings: string[] = [];
  if (parsed.reportingRange === 'weekly') {
    warnings.push(
      `This looks like a WEEKLY SQP export (Reporting Range=Weekly) — weekly volumes are ` +
        `~7× lower than monthly. Upload the MONTHLY export instead; these rows were ` +
        `ingested as monthly and will distort any fit.`,
    );
  }
  if (parsed.suggestedMonthEndDate !== null && parsed.suggestedMonthEndDate !== monthEndDate) {
    warnings.push(
      `SQP file metadata says the export covers the month ending ${parsed.suggestedMonthEndDate}, ` +
        `but it was imported under ${monthEndDate}. Rows are stored under ${monthEndDate} — ` +
        `re-upload with the matching month end date if that was unintended.`,
    );
  }
  const monthMismatchWarning = warnings.length > 0 ? warnings.join(' ') : null;

  // Phase 2: bulk UPSERT
  const upsertStart = Date.now();
  const ownPool = !pool;
  const usePool =
    pool ??
    new Pool({
      connectionString: process.env.DATABASE_URL!,
      statement_timeout: 600_000,
    });
  const client = await usePool.connect();
  let upserted = 0;
  try {
    upserted = await bulkUpsert(client, parsed.rows, monthEndDate, sourceFilename);
  } finally {
    client.release();
    if (ownPool) await usePool.end();
  }
  const upsertMs = Date.now() - upsertStart;

  return {
    uniqueTerms: parsed.rows.length,
    upserted,
    parseMs,
    upsertMs,
    suggestedMonthEndDate: parsed.suggestedMonthEndDate,
    monthMismatchWarning,
  };
}

async function bulkUpsert(
  client: PoolClient,
  rows: ParsedSqpRow[],
  monthEndDate: string,
  sourceFilename: string,
): Promise<number> {
  if (rows.length === 0) return 0;
  const CHUNK = 1000;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const valueRows: string[] = [];
    const params: unknown[] = [];
    let p = 1;
    for (const r of slice) {
      valueRows.push(`($${p}, $${p + 1}, $${p + 2}, $${p + 3})`);
      params.push(r.searchTermNormalized, monthEndDate, r.monthlyVolume, sourceFilename);
      p += 4;
    }
    const sql = `
      INSERT INTO sqp_calibration_data
        (search_term_normalized, month_end_date, sqp_monthly_volume, source_filename)
      VALUES ${valueRows.join(', ')}
      ON CONFLICT (search_term_normalized, month_end_date)
      DO UPDATE SET
        sqp_monthly_volume = EXCLUDED.sqp_monthly_volume,
        source_filename = EXCLUDED.source_filename,
        imported_at = NOW()
    `;
    const result = await client.query(sql, params);
    inserted += result.rowCount ?? 0;
  }
  return inserted;
}
