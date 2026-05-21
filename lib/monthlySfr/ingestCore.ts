/**
 * Core ingest logic for monthly BA SFR CSVs. Shared between
 * scripts/ingestMonthlySfr.ts (CLI path, reads from filesystem) and
 * inngest/functions/processMonthlySfr.ts (in-app upload path, reads
 * from R2). Both call ingestMonthlySfrFromStream with a Readable.
 *
 * The CSV is the standard Amazon Brand Analytics export format:
 *   - Row 1: metadata (Reporting Range, year, month) — dropped by streamParseCsv
 *   - Row 2: column headers (we use "Search Term" and "Search Frequency Rank")
 *   - Row 3+: data rows
 *
 * Dedup: MIN-rank wins on normalized-term collisions (mirrors the
 * weekly path's dedup semantics).
 *
 * Idempotent: ON CONFLICT (search_term_normalized, month_end_date)
 * DO UPDATE — re-running overwrites existing rows for the same month.
 */
import type { Readable } from 'node:stream';
import { Pool, type PoolClient } from 'pg';
import { streamParseCsv } from '@/lib/csv/streamParse';
import { normalizeForMatch } from '@/lib/analytics/derivedFields';

interface ParsedRow {
  normalizedTerm: string;
  rank: number;
}

export interface IngestMonthlySfrResult {
  totalRows: number;
  skippedRows: number;
  uniqueTerms: number;
  collapses: number;
  upserted: number;
  parseMs: number;
  upsertMs: number;
}

/**
 * Stream-parse a monthly BA CSV, in-memory dedup with MIN-rank, bulk
 * UPSERT into monthly_sfr. Returns counts for caller-side reporting
 * (CLI script logs them; Inngest function sends them in the email).
 */
export async function ingestMonthlySfrFromStream(
  stream: Readable,
  monthEndDate: string,
  sourceFilename: string,
  pool?: Pool,
): Promise<IngestMonthlySfrResult> {
  // Phase 1: parse + dedup in memory
  const parseStart = Date.now();
  const byTerm = new Map<string, ParsedRow>();
  let totalRows = 0;
  let skippedRows = 0;

  for await (const row of streamParseCsv(stream)) {
    totalRows += 1;
    const rawTerm = row['Search Term'];
    const rankStr = row['Search Frequency Rank'];
    if (!rawTerm || !rankStr) {
      skippedRows += 1;
      continue;
    }
    const rank = Number(rankStr.replace(/,/g, ''));
    if (!Number.isFinite(rank) || rank < 1) {
      skippedRows += 1;
      continue;
    }
    const normalizedTerm = normalizeForMatch(rawTerm);
    if (!normalizedTerm) {
      skippedRows += 1;
      continue;
    }
    const existing = byTerm.get(normalizedTerm);
    if (existing === undefined || rank < existing.rank) {
      byTerm.set(normalizedTerm, { normalizedTerm, rank });
    }
  }
  const parseMs = Date.now() - parseStart;

  const uniqueTerms = byTerm.size;
  const collapses = totalRows - skippedRows - uniqueTerms;

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
      params.push(r.normalizedTerm, r.rank, monthEndDate, sourceFilename);
      p += 4;
    }
    const sql = `
      INSERT INTO monthly_sfr (search_term_normalized, actual_rank, month_end_date, source_filename)
      VALUES ${valueRows.join(', ')}
      ON CONFLICT (search_term_normalized, month_end_date)
      DO UPDATE SET
        actual_rank = EXCLUDED.actual_rank,
        source_filename = EXCLUDED.source_filename,
        imported_at = NOW()
    `;
    const result = await client.query(sql, params);
    inserted += result.rowCount ?? 0;
  }
  return inserted;
}
