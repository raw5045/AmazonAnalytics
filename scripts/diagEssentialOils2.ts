import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';

async function main() {
  const sql = neon(process.env.DATABASE_URL!);

  // Are there OTHER search_terms whose raw is byte-equal to "essential oils" without the OBJ?
  console.log('\n=== ALL rows whose normalized = "essential oils" ===');
  const rows = (await sql`
    SELECT id, search_term_raw, length(search_term_raw) AS raw_len, first_seen_week, last_seen_week, created_at
    FROM search_terms
    WHERE search_term_normalized = 'essential oils'
  `) as Array<Record<string, unknown>>;
  for (const r of rows) {
    const raw = r.search_term_raw as string;
    const hex = Array.from(raw).map((c) => c.codePointAt(0)?.toString(16)).join(' ');
    console.log(`  id=${r.id}`);
    console.log(`    raw="${raw}"  raw_hex="${hex}"  raw_len=${r.raw_len}`);
    console.log(`    first_seen=${r.first_seen_week}  last_seen=${r.last_seen_week}  created=${r.created_at}`);
  }

  // Look at the kwm rows for the bad weeks specifically — Apr 04, Jan 17, etc.
  // What is the raw search_term in those cases? Did the CSV have OBJ that week?
  console.log('\n=== kwm + uploaded_files for the anomaly weeks ===');
  const anomalies = (await sql`
    SELECT k.week_end_date, k.actual_rank, k.source_file_id,
           uf.original_filename
    FROM keyword_weekly_metrics k
    JOIN uploaded_files uf ON uf.id = k.source_file_id
    WHERE k.search_term_id = (
      SELECT id FROM search_terms WHERE search_term_normalized = 'essential oils' LIMIT 1
    )
      AND k.week_end_date IN ('2025-11-15', '2025-12-27', '2026-01-17', '2026-04-04')
    ORDER BY k.week_end_date
  `) as Array<Record<string, unknown>>;
  for (const r of anomalies) {
    console.log(`  ${String(r.week_end_date).slice(0,10)}  rank=${(r.actual_rank as number).toLocaleString().padStart(12)}  file=${r.original_filename}`);
  }

  // Look at ALL kwm rows that have a high rank for "essential oils"-normalized terms in the bad weeks
  // Maybe there are TWO kwm rows for these weeks (one good, one bad) — that'd reveal the issue
  console.log('\n=== ALL search_term variations + their kwm row in anomaly weeks ===');
  const anomalyDetails = (await sql`
    SELECT
      st.id AS term_id,
      st.search_term_raw,
      st.search_term_normalized,
      k.week_end_date,
      k.actual_rank
    FROM keyword_weekly_metrics k
    JOIN search_terms st ON st.id = k.search_term_id
    WHERE k.week_end_date IN ('2026-04-04', '2026-01-17')
      AND st.search_term_normalized LIKE 'essential oils%'
      AND st.search_term_normalized NOT LIKE 'essential oils %'
    ORDER BY k.week_end_date, k.actual_rank
    LIMIT 30
  `) as Array<Record<string, unknown>>;
  for (const r of anomalyDetails) {
    console.log(`  ${String(r.week_end_date).slice(0,10)}  norm="${r.search_term_normalized}"  raw="${r.search_term_raw}"  rank=${(r.actual_rank as number).toLocaleString()}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
