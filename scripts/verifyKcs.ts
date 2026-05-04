/**
 * Sanity check the keyword_current_summary table contents.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';

async function main() {
  const sql = neon(process.env.DATABASE_URL!);

  console.log('\n=== Total rows ===');
  const [t] = (await sql`SELECT COUNT(*)::int c FROM keyword_current_summary`) as Array<{ c: number }>;
  console.log(' rows:', t.c.toLocaleString());

  console.log('\n=== Distribution by current_week_end_date (should all be the latest week) ===');
  const dates = (await sql`
    SELECT current_week_end_date, COUNT(*)::int c
    FROM keyword_current_summary
    GROUP BY current_week_end_date
    ORDER BY current_week_end_date
  `) as Array<{ current_week_end_date: string; c: number }>;
  for (const d of dates) console.log(` ${d.current_week_end_date.toString().slice(0, 10)} | ${d.c.toLocaleString()}`);

  console.log('\n=== Severity distribution ===');
  const sev = (await sql`
    SELECT fake_volume_severity_current AS sev, COUNT(*)::int c
    FROM keyword_current_summary
    GROUP BY fake_volume_severity_current
    ORDER BY fake_volume_severity_current NULLS FIRST
  `) as Array<{ sev: string | null; c: number }>;
  for (const s of sev) console.log(` ${(s.sev ?? '<NULL>').padEnd(10)} | ${s.c.toLocaleString()}`);

  console.log('\n=== Improvement coverage (non-null counts) ===');
  const cov = (await sql`
    SELECT
      COUNT(prior_week_rank)::int as has_1w,
      COUNT(rank_4w_ago)::int as has_4w,
      COUNT(rank_13w_ago)::int as has_13w,
      COUNT(rank_26w_ago)::int as has_26w,
      COUNT(rank_52w_ago)::int as has_52w
    FROM keyword_current_summary
  `) as Array<{ has_1w: number; has_4w: number; has_13w: number; has_26w: number; has_52w: number }>;
  console.log(' ', JSON.stringify(cov[0]));

  console.log('\n=== Top 5 movers by improvement_1w ===');
  const movers = (await sql`
    SELECT kcs.improvement_1w, kcs.current_rank, kcs.prior_week_rank, st.search_term_raw
    FROM keyword_current_summary kcs
    JOIN search_terms st ON st.id = kcs.search_term_id
    WHERE kcs.improvement_1w IS NOT NULL
    ORDER BY kcs.improvement_1w DESC
    LIMIT 5
  `) as Array<{
    improvement_1w: number;
    current_rank: number;
    prior_week_rank: number;
    search_term_raw: string;
  }>;
  for (const m of movers) {
    console.log(` ${m.search_term_raw.padEnd(40).slice(0, 40)} | rank ${m.prior_week_rank.toLocaleString().padStart(10)} → ${m.current_rank.toLocaleString().padStart(10)} (+${m.improvement_1w.toLocaleString()})`);
  }

  console.log('\n=== Sample row ===');
  const [sample] = (await sql`
    SELECT kcs.*, st.search_term_raw
    FROM keyword_current_summary kcs
    JOIN search_terms st ON st.id = kcs.search_term_id
    WHERE kcs.current_rank < 100 AND kcs.improvement_4w IS NOT NULL
    LIMIT 1
  `) as Array<Record<string, unknown>>;
  console.log(JSON.stringify(sample, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
