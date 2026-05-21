/**
 * Core ingest logic for POE calibration CSVs. Shared between
 * scripts/ingestPoeCalibration.ts (CLI path, reads from filesystem)
 * and the combined-calibration Inngest function (reads from R2).
 *
 * Expected CSV format (Amazon POE export saved as CSV):
 *   "Search Term","30-Day Search Volume"
 *   "mothers day gifts",3459791
 *   "car accessories",1813031
 *
 * Dedup on normalized-term collision: MAX-volume wins (different from
 * monthly_sfr's MIN-rank — for POE we want the highest-signal
 * representative when raw variants normalize to the same key).
 *
 * Idempotent: ON CONFLICT (search_term_normalized, month_end_date) DO
 * UPDATE — re-running the same month overwrites the existing snapshot.
 */
import type { Readable } from 'node:stream';
import { Pool, type PoolClient } from 'pg';
import { streamParseCsv } from '@/lib/csv/streamParse';
import { normalizeForMatch } from '@/lib/analytics/derivedFields';

interface ParsedRow {
  normalizedTerm: string;
  volume30d: number;
}

export interface IngestPoeResult {
  totalRows: number;
  skippedRows: number;
  uniqueTerms: number;
  collapses: number;
  upserted: number;
  parseMs: number;
  upsertMs: number;
}

export async function ingestPoeCalibrationFromStream(
  stream: Readable,
  monthEndDate: string,
  sourceFilename: string,
  pool?: Pool,
): Promise<IngestPoeResult> {
  // Phase 1: parse + MAX-volume dedup in memory
  const parseStart = Date.now();
  const byTerm = new Map<string, ParsedRow>();
  let totalRows = 0;
  let skippedRows = 0;
  let collapses = 0;

  // POE CSV has a real header row 1 (NOT Amazon's BA metadata format).
  for await (const row of streamParseCsv(stream, { skipMetadataRow: false })) {
    totalRows += 1;
    const rawTerm = row['Search Term'];
    const volStr = row['30-Day Search Volume'];
    if (!rawTerm || !volStr) {
      skippedRows += 1;
      continue;
    }
    const volume30d = Number(volStr.replace(/,/g, ''));
    if (!Number.isFinite(volume30d) || volume30d < 0) {
      skippedRows += 1;
      continue;
    }
    const normalizedTerm = normalizeForMatch(rawTerm);
    if (!normalizedTerm) {
      skippedRows += 1;
      continue;
    }
    const existing = byTerm.get(normalizedTerm);
    if (existing === undefined) {
      byTerm.set(normalizedTerm, { normalizedTerm, volume30d });
    } else {
      collapses += 1;
      if (volume30d > existing.volume30d) {
        byTerm.set(normalizedTerm, { normalizedTerm, volume30d });
      }
    }
  }
  const parseMs = Date.now() - parseStart;
  const uniqueTerms = byTerm.size;

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
    upserted = await bulkUpsert(
      client,
      Array.from(byTerm.values()),
      monthEndDate,
      sourceFilename,
    );
  } finally {
    client.release();
    if (ownPool) await usePool.end();
  }
  const upsertMs = Date.now() - upsertStart;

  return {
    totalRows,
    skippedRows,
    uniqueTerms,
    collapses,
    upserted,
    parseMs,
    upsertMs,
  };
}

async function bulkUpsert(
  client: PoolClient,
  rows: ParsedRow[],
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
      params.push(r.normalizedTerm, monthEndDate, r.volume30d, sourceFilename);
      p += 4;
    }
    const sql = `
      INSERT INTO poe_calibration_data
        (search_term_normalized, month_end_date, poe_30_day_volume, source_filename)
      VALUES ${valueRows.join(', ')}
      ON CONFLICT (search_term_normalized, month_end_date)
      DO UPDATE SET
        poe_30_day_volume = EXCLUDED.poe_30_day_volume,
        source_filename = EXCLUDED.source_filename,
        imported_at = NOW()
    `;
    const result = await client.query(sql, params);
    inserted += result.rowCount ?? 0;
  }
  return inserted;
}
