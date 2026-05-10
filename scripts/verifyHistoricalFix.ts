/**
 * Spot-check the historical fix on the keywords the user reported as
 * showing wild rank swings. Compare each one's full kwm history — anomaly
 * weeks should now show legit ranks, not the 700k+ phantom values.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';

async function main() {
  const sql = neon(process.env.DATABASE_URL!);

  const keywords = ['essential oils', 'magic eraser', 'batteries', 'shorts for women'];
  for (const kw of keywords) {
    console.log(`\n=== "${kw}" ===`);

    const ids = (await sql`
      SELECT id FROM search_terms WHERE search_term_normalized = ${kw}
    `) as Array<{ id: string }>;
    if (ids.length === 0) { console.log('  not found'); continue; }
    const id = ids[0].id;

    const stats = (await sql`
      SELECT
        COUNT(*)::int weeks,
        MIN(actual_rank)::int min_rank,
        MAX(actual_rank)::int max_rank,
        ROUND(AVG(actual_rank)::numeric, 0) avg_rank
      FROM keyword_weekly_metrics
      WHERE search_term_id = ${id}
    `) as Array<Record<string, unknown>>;
    const s = stats[0];
    console.log(`  ${s.weeks} weeks: rank range ${(s.min_rank as number).toLocaleString()} → ${(s.max_rank as number).toLocaleString()}, avg ${(s.avg_rank as string)?.toLocaleString?.() ?? s.avg_rank}`);

    // Pre-replay we had wild swings (ranks 1M-2.7M for popular keywords).
    // After dedup, the max rank should be much closer to the avg.
    const minRank = s.min_rank as number;
    const maxRank = s.max_rank as number;
    const ratio = maxRank / Math.max(minRank, 1);
    if (ratio > 100 && minRank < 1000) {
      console.log(`  ⚠ Max is ${ratio.toFixed(0)}× min — anomaly likely still present`);
      const high = (await sql`
        SELECT week_end_date::text, actual_rank
        FROM keyword_weekly_metrics
        WHERE search_term_id = ${id}
          AND actual_rank > ${minRank * 100}
        ORDER BY week_end_date
      `) as Array<Record<string, unknown>>;
      for (const r of high) console.log(`    [${r.week_end_date}] rank ${(r.actual_rank as number).toLocaleString()}`);
    } else {
      console.log(`  ✓ rank range looks healthy (max/min ratio: ${ratio.toFixed(1)})`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
