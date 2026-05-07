/**
 * Spot-check the OBJ-anomaly pattern on 4-5 popular keywords other
 * than essential oils.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';

async function main() {
  const sql = neon(process.env.DATABASE_URL!);

  const kw = ['magic eraser', 'batteries', 'shorts for women', 'tinnitus relief'];
  for (const k of kw) {
    console.log(`\n=== "${k}" ===`);
    const ids = (await sql`
      SELECT id, search_term_raw,
             length(search_term_raw) as raw_len
      FROM search_terms
      WHERE search_term_normalized = ${k}
    `) as Array<{ id: string; search_term_raw: string; raw_len: number }>;
    if (ids.length === 0) { console.log('  not found'); continue; }
    console.log(`  search_term row: id=${ids[0].id} raw_len=${ids[0].raw_len} raw="${ids[0].search_term_raw}"`);

    const id = ids[0].id;
    const stats = (await sql`
      SELECT
        MIN(actual_rank)::int min_rank,
        MAX(actual_rank)::int max_rank,
        COUNT(*)::int weeks
      FROM keyword_weekly_metrics
      WHERE search_term_id = ${id}
    `) as Array<{ min_rank: number; max_rank: number; weeks: number }>;
    const { min_rank, max_rank, weeks } = stats[0];
    console.log(`  ${weeks} weeks of data; rank range ${min_rank.toLocaleString()} → ${max_rank.toLocaleString()}`);

    // If max is much bigger than min, there are anomalies
    if (max_rank > min_rank * 100) {
      const ratio = (max_rank / min_rank).toFixed(0);
      console.log(`  ⚠ MAX is ${ratio}x MIN — anomaly likely. Listing high-rank weeks:`);
      const anomalies = (await sql`
        SELECT k.week_end_date, k.actual_rank, uf.original_filename
        FROM keyword_weekly_metrics k
        JOIN uploaded_files uf ON uf.id = k.source_file_id
        WHERE k.search_term_id = ${id}
          AND k.actual_rank > ${min_rank * 100}
        ORDER BY k.week_end_date
      `) as Array<Record<string, unknown>>;
      for (const a of anomalies) {
        console.log(`    ${String(a.week_end_date).slice(0, 10)}  rank=${(a.actual_rank as number).toLocaleString().padStart(12)}  file=${a.original_filename}`);
      }
    } else {
      console.log(`  ✓ no anomalies detected`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
