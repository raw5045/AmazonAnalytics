import { eq, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { from as copyFrom } from 'pg-copy-streams';
import { inngest } from '../client';
import { downloadStreamFromR2 } from '@/lib/storage/r2';
import { streamParseCsv } from '@/lib/csv/streamParse';
import { normalizeForMatch } from '@/lib/analytics/derivedFields';
import { env } from '@/lib/env';
import { db } from '@/db/client';
import { uploadedFiles, stagingWeeklyMetrics, reportingWeeks } from '@/db/schema';

export interface ImportFileInput {
  uploadedFileId: string;
}

export interface ImportFileOutput {
  rowsImported: number;
}

function toNumeric(v: string | undefined | null): string | null {
  if (!v || v.trim() === '') return null;
  const n = Number(v);
  if (Number.isNaN(n)) return null;
  return n.toFixed(2);
}

function titleContainsKeyword(normalizedKeyword: string, title: string | null | undefined): boolean {
  if (!title || !normalizedKeyword) return false;
  const nTitle = normalizeForMatch(title);
  return !!nTitle && nTitle.includes(normalizedKeyword);
}

export async function processFileImport(input: ImportFileInput): Promise<ImportFileOutput> {
  const file = await db.query.uploadedFiles.findFirst({
    where: eq(uploadedFiles.id, input.uploadedFileId),
  });
  if (!file) throw new Error(`uploaded file ${input.uploadedFileId} not found`);
  if (!file.weekEndDate) throw new Error(`file ${input.uploadedFileId} has no weekEndDate`);

  const weekEndDate = file.weekEndDate;
  const weekStartDate = new Date(Date.parse(weekEndDate));
  weekStartDate.setUTCDate(weekStartDate.getUTCDate() - 6);
  const weekStartIso = weekStartDate.toISOString().slice(0, 10);

  // Idempotency: clear any partial staging rows from a previous timeout/retry of this file
  await db.delete(stagingWeeklyMetrics).where(eq(stagingWeeklyMetrics.uploadedFileId, file.id));

  // Stage 1: stream CSV into staging_weekly_metrics via COPY FROM STDIN.
  // Uses node-postgres TCP Pool (with keepalives) for the COPY connection.
  // For a 2.87M-row file, COPY is 50x+ faster than parameterized INSERTs.
  const stream = await downloadStreamFromR2(file.storageKey);
  let rowsStaged = 0;

  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    connectionTimeoutMillis: 20_000,
  });
  pool.on('error', (err) => {
    console.warn('[copy pool] idle client error:', err.message);
  });
  const client = await pool.connect();

  try {
    const copySql = `
      COPY staging_weekly_metrics (
        batch_id, uploaded_file_id, week_end_date,
        search_term_raw, search_term_normalized,
        actual_rank,
        top_clicked_brand_1, top_clicked_brand_2, top_clicked_brand_3,
        top_clicked_category_1, top_clicked_category_2, top_clicked_category_3,
        top_clicked_product_1_asin, top_clicked_product_2_asin, top_clicked_product_3_asin,
        top_clicked_product_1_title, top_clicked_product_2_title, top_clicked_product_3_title,
        top_clicked_product_1_click_share, top_clicked_product_2_click_share, top_clicked_product_3_click_share,
        top_clicked_product_1_conversion_share, top_clicked_product_2_conversion_share, top_clicked_product_3_conversion_share,
        keyword_in_title_1, keyword_in_title_2, keyword_in_title_3, keyword_title_match_count
      ) FROM STDIN WITH (FORMAT text, NULL '\\N')
    `;

    const copyStream = client.query(copyFrom(copySql));

    const encodeField = (v: string | number | boolean | null | undefined): string => {
      if (v === null || v === undefined || v === '') return '\\N';
      const s = String(v);
      return s
        .replace(/\\/g, '\\\\')
        .replace(/\t/g, '\\t')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r');
    };

    for await (const row of streamParseCsv(stream)) {
      const searchTerm = row['Search Term'];
      // Fallback: if normalization produces an empty string (e.g. search term is
      // purely non-alphanumeric Unicode like the object-replacement character U+FFFC),
      // use the raw term lowercased/trimmed. The schema requires NOT NULL so we
      // must never emit an empty string here.
      const normalizedTerm = normalizeForMatch(searchTerm) || searchTerm.toLowerCase().trim() || '__unparseable__';
      const t1 = row['Top Clicked Product #1: Product Title'] ?? null;
      const t2 = row['Top Clicked Product #2: Product Title'] ?? null;
      const t3 = row['Top Clicked Product #3: Product Title'] ?? null;

      // Cache: normalize keyword ONCE per row (was being redone 3x via computeTitleMatchCount)
      const kwNormalized = normalizedTerm;

      const inT1 = titleContainsKeyword(kwNormalized, t1);
      const inT2 = titleContainsKeyword(kwNormalized, t2);
      const inT3 = titleContainsKeyword(kwNormalized, t3);
      const matchCount = (inT1 ? 1 : 0) + (inT2 ? 1 : 0) + (inT3 ? 1 : 0);

      const fields = [
        file.batchId,
        file.id,
        weekEndDate,
        searchTerm,
        normalizedTerm,
        Number(row['Search Frequency Rank']),
        row['Top Clicked Brand #1'] || null,
        row['Top Clicked Brands #2'] || null,
        row['Top Clicked Brands #3'] || null,
        row['Top Clicked Category #1'] || null,
        row['Top Clicked Category #2'] || null,
        row['Top Clicked Category #3'] || null,
        row['Top Clicked Product #1: ASIN'] || null,
        row['Top Clicked Product #2: ASIN'] || null,
        row['Top Clicked Product #3: ASIN'] || null,
        t1,
        t2,
        t3,
        toNumeric(row['Top Clicked Product #1: Click Share']),
        toNumeric(row['Top Clicked Product #2: Click Share']),
        toNumeric(row['Top Clicked Product #3: Click Share']),
        toNumeric(row['Top Clicked Product #1: Conversion Share']),
        toNumeric(row['Top Clicked Product #2: Conversion Share']),
        toNumeric(row['Top Clicked Product #3: Conversion Share']),
        inT1 ? 't' : 'f',
        inT2 ? 't' : 'f',
        inT3 ? 't' : 'f',
        matchCount,
      ];

      const line = fields.map(encodeField).join('\t') + '\n';

      // Write + respect backpressure
      if (!copyStream.write(line)) {
        await new Promise<void>((resolve) => copyStream.once('drain', () => resolve()));
      }
      rowsStaged++;
    }

    copyStream.end();
    await new Promise<void>((resolve, reject) => {
      copyStream.on('finish', () => resolve());
      copyStream.on('error', reject);
    });
  } finally {
    client.release();
    await pool.end();
  }

  // Stage 2: upsert search_terms
  await db.execute(sql`
    INSERT INTO search_terms (search_term_raw, search_term_normalized, first_seen_week, last_seen_week)
    SELECT DISTINCT ON (search_term_normalized)
      search_term_raw, search_term_normalized, ${weekEndDate}::date, ${weekEndDate}::date
    FROM staging_weekly_metrics
    WHERE uploaded_file_id = ${file.id}
    ON CONFLICT (search_term_normalized) DO UPDATE
      SET last_seen_week = GREATEST(search_terms.last_seen_week, EXCLUDED.last_seen_week),
          first_seen_week = LEAST(search_terms.first_seen_week, EXCLUDED.first_seen_week)
  `);

  // Stage 3: link staging rows to search_term ids
  await db.execute(sql`
    UPDATE staging_weekly_metrics s
    SET search_term_id = st.id
    FROM search_terms st
    WHERE s.uploaded_file_id = ${file.id}
      AND s.search_term_normalized = st.search_term_normalized
  `);

  // Stage 4: promote to keyword_weekly_metrics
  if (file.isReplacement) {
    // neon-http does not support transactions; run DELETE + INSERT sequentially.
    // Safe because the pipeline serializes per-week (concurrency limit=1 on importFileFn).
    await db.execute(
      sql`DELETE FROM keyword_weekly_metrics WHERE week_end_date = ${weekEndDate}::date`,
    );
    await db.execute(sql`
      INSERT INTO keyword_weekly_metrics (
        week_end_date, search_term_id, actual_rank,
        top_clicked_brand_1, top_clicked_brand_2, top_clicked_brand_3,
        top_clicked_category_1, top_clicked_category_2, top_clicked_category_3,
        top_clicked_product_1_asin, top_clicked_product_2_asin, top_clicked_product_3_asin,
        top_clicked_product_1_title, top_clicked_product_2_title, top_clicked_product_3_title,
        top_clicked_product_1_click_share, top_clicked_product_2_click_share, top_clicked_product_3_click_share,
        top_clicked_product_1_conversion_share, top_clicked_product_2_conversion_share, top_clicked_product_3_conversion_share,
        keyword_in_title_1, keyword_in_title_2, keyword_in_title_3, keyword_title_match_count,
        source_file_id
      )
      SELECT
        week_end_date, search_term_id, actual_rank,
        top_clicked_brand_1, top_clicked_brand_2, top_clicked_brand_3,
        top_clicked_category_1, top_clicked_category_2, top_clicked_category_3,
        top_clicked_product_1_asin, top_clicked_product_2_asin, top_clicked_product_3_asin,
        top_clicked_product_1_title, top_clicked_product_2_title, top_clicked_product_3_title,
        top_clicked_product_1_click_share, top_clicked_product_2_click_share, top_clicked_product_3_click_share,
        top_clicked_product_1_conversion_share, top_clicked_product_2_conversion_share, top_clicked_product_3_conversion_share,
        keyword_in_title_1, keyword_in_title_2, keyword_in_title_3, keyword_title_match_count,
        ${file.id}
      FROM staging_weekly_metrics
      WHERE uploaded_file_id = ${file.id}
    `);
  } else {
    await db.execute(sql`
      INSERT INTO keyword_weekly_metrics (
        week_end_date, search_term_id, actual_rank,
        top_clicked_brand_1, top_clicked_brand_2, top_clicked_brand_3,
        top_clicked_category_1, top_clicked_category_2, top_clicked_category_3,
        top_clicked_product_1_asin, top_clicked_product_2_asin, top_clicked_product_3_asin,
        top_clicked_product_1_title, top_clicked_product_2_title, top_clicked_product_3_title,
        top_clicked_product_1_click_share, top_clicked_product_2_click_share, top_clicked_product_3_click_share,
        top_clicked_product_1_conversion_share, top_clicked_product_2_conversion_share, top_clicked_product_3_conversion_share,
        keyword_in_title_1, keyword_in_title_2, keyword_in_title_3, keyword_title_match_count,
        source_file_id
      )
      SELECT
        week_end_date, search_term_id, actual_rank,
        top_clicked_brand_1, top_clicked_brand_2, top_clicked_brand_3,
        top_clicked_category_1, top_clicked_category_2, top_clicked_category_3,
        top_clicked_product_1_asin, top_clicked_product_2_asin, top_clicked_product_3_asin,
        top_clicked_product_1_title, top_clicked_product_2_title, top_clicked_product_3_title,
        top_clicked_product_1_click_share, top_clicked_product_2_click_share, top_clicked_product_3_click_share,
        top_clicked_product_1_conversion_share, top_clicked_product_2_conversion_share, top_clicked_product_3_conversion_share,
        keyword_in_title_1, keyword_in_title_2, keyword_in_title_3, keyword_title_match_count,
        ${file.id}
      FROM staging_weekly_metrics
      WHERE uploaded_file_id = ${file.id}
      ON CONFLICT (week_end_date, search_term_id) DO NOTHING
    `);
  }

  // Stage 5: reporting_weeks + cleanup
  await db
    .insert(reportingWeeks)
    .values({
      weekEndDate,
      weekStartDate: weekStartIso,
      sourceFileId: file.id,
      isComplete: true,
    })
    .onConflictDoUpdate({
      target: reportingWeeks.weekEndDate,
      set: { sourceFileId: file.id, isComplete: true },
    });

  await db.delete(stagingWeeklyMetrics).where(eq(stagingWeeklyMetrics.uploadedFileId, file.id));
  await db
    .update(uploadedFiles)
    .set({
      validationStatus: 'imported',
      importedAt: new Date(),
      rowCountLoaded: rowsStaged,
    })
    .where(eq(uploadedFiles.id, file.id));

  return { rowsImported: rowsStaged };
}

export const importFileFn = inngest.createFunction(
  {
    id: 'import-file',
    name: 'Import file to keyword_weekly_metrics',
    concurrency: { limit: 1 },
    triggers: [{ event: 'csv/file.import' }],
  },
  async ({ event, step }) => {
    const data = event.data as { uploadedFileId: string };
    return step.run('import', () =>
      processFileImport({
        uploadedFileId: data.uploadedFileId,
      }),
    );
  },
);
