/**
 * Show per-phase timing for the most recent imports — find where time
 * actually went during the slow replay so we can target the fix at
 * the real bottleneck (per GPT review).
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';

async function main() {
  const sql = neon(process.env.DATABASE_URL!);

  console.log('\n=== Last 8 successful imports — phase breakdown ===');
  const phases = (await sql`
    SELECT
      uf.original_filename,
      uf.imported_at,
      ipt.phase,
      EXTRACT(epoch FROM (ipt.ended_at - ipt.started_at))::int AS sec
    FROM import_phase_timings ipt
    JOIN uploaded_files uf ON uf.id = ipt.uploaded_file_id
    WHERE ipt.started_at > NOW() - INTERVAL '12 hours'
    ORDER BY ipt.started_at DESC
    LIMIT 100
  `) as Array<{ original_filename: string; imported_at: string; phase: string; sec: number }>;

  // Group by file
  const byFile = new Map<string, Array<{ phase: string; sec: number }>>();
  for (const p of phases) {
    const key = p.original_filename;
    if (!byFile.has(key)) byFile.set(key, []);
    byFile.get(key)!.push({ phase: p.phase, sec: p.sec });
  }

  for (const [file, ph] of byFile) {
    const total = ph.reduce((s, x) => s + x.sec, 0);
    console.log(`\n  ${file}  total ${(total / 60).toFixed(1)} min`);
    for (const p of ph) {
      console.log(`    ${p.phase.padEnd(28)} ${(p.sec / 60).toFixed(2).padStart(7)} min`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
