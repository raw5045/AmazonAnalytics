/**
 * Test the hypothesis that anomaly weeks correlate with specific source
 * files (the ones whose CSVs apparently contain a phantom OBJ-prefixed
 * row for popular keywords).
 *
 * For each (week, file) pair, count how many rows in kwm have a rank
 * that's > 100x its neighbor's rank — i.e., looks like an outlier.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';

async function main() {
  const sql = neon(process.env.DATABASE_URL!);

  console.log('\n=== Files with the highest count of "rank jump" anomalies ===');
  console.log('A "jump" = current rank > 100x median of the 4 nearest weeks (avg of the term).');
  console.log('Bigger numbers = files where many keywords had bogus ranks.');
  console.log();

  // For each kwm row, we want: is current rank wildly different from this term's typical rank?
  // Using kcs.current_rank as the "typical" benchmark would be wrong (current is just one week).
  // Better: compare to median of the term's other ranks. But median is hard.
  //
  // Simplest proxy: count rows where actual_rank > 100,000 AND the term's MIN rank is < 1000.
  // That catches "this keyword is normally top-1k but got rank 100k+ this week" — exactly the
  // anomaly we saw with essential oils.
  const result = (await sql`
    WITH term_min_rank AS (
      SELECT search_term_id, MIN(actual_rank) AS min_rank
      FROM keyword_weekly_metrics
      GROUP BY search_term_id
      HAVING MIN(actual_rank) < 1000
    ),
    anomalies AS (
      SELECT k.week_end_date, k.source_file_id
      FROM keyword_weekly_metrics k
      JOIN term_min_rank tmr ON tmr.search_term_id = k.search_term_id
      WHERE k.actual_rank > 100000
    )
    SELECT
      uf.original_filename,
      a.week_end_date,
      COUNT(*)::int anomaly_count
    FROM anomalies a
    JOIN uploaded_files uf ON uf.id = a.source_file_id
    GROUP BY uf.original_filename, a.week_end_date
    ORDER BY COUNT(*) DESC
    LIMIT 20
  `) as Array<{ original_filename: string; week_end_date: string; anomaly_count: number }>;

  console.log('  filename                                                       | week        | anomalies');
  console.log('  ---------------------------------------------------------------|-------------|----------');
  for (const r of result) {
    console.log(
      `  ${r.original_filename.padEnd(60).slice(0, 60)} | ${String(r.week_end_date).slice(0, 10)} | ${r.anomaly_count.toLocaleString().padStart(8)}`,
    );
  }

  // Now show the OPPOSITE — files with very few anomalies (these are the "clean" CSVs)
  console.log('\n=== Files with the FEWEST rank anomalies (clean ones, for contrast) ===');
  const clean = (await sql`
    WITH term_min_rank AS (
      SELECT search_term_id, MIN(actual_rank) AS min_rank
      FROM keyword_weekly_metrics
      GROUP BY search_term_id
      HAVING MIN(actual_rank) < 1000
    ),
    anomalies AS (
      SELECT k.week_end_date, k.source_file_id
      FROM keyword_weekly_metrics k
      JOIN term_min_rank tmr ON tmr.search_term_id = k.search_term_id
      WHERE k.actual_rank > 100000
    )
    SELECT
      uf.original_filename,
      a.week_end_date,
      COUNT(*)::int anomaly_count
    FROM anomalies a
    JOIN uploaded_files uf ON uf.id = a.source_file_id
    GROUP BY uf.original_filename, a.week_end_date
    ORDER BY COUNT(*) ASC
    LIMIT 5
  `) as Array<{ original_filename: string; week_end_date: string; anomaly_count: number }>;
  for (const r of clean) {
    console.log(
      `  ${r.original_filename.padEnd(60).slice(0, 60)} | ${String(r.week_end_date).slice(0, 10)} | ${r.anomaly_count.toLocaleString().padStart(8)}`,
    );
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
