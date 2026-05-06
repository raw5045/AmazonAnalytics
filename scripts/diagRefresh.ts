import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';

async function main() {
  const sql = neon(process.env.DATABASE_URL!);

  console.log('\n=== Now ===');
  const [now] = (await sql`SELECT NOW() as t`) as Array<{ t: string }>;
  console.log(' ', now.t);

  console.log('\n=== Latest file state ===');
  const [f] = (await sql`
    SELECT id, original_filename, validation_status, import_phase,
           import_started_at,
           import_heartbeat_at,
           EXTRACT(epoch FROM (NOW() - import_heartbeat_at))::int AS heartbeat_age_sec,
           validation_errors_json
    FROM uploaded_files
    ORDER BY created_at DESC
    LIMIT 1
  `) as Array<Record<string, unknown>>;
  console.log(JSON.stringify(f, null, 2));

  console.log('\n=== Live keyword_current_summary state ===');
  const [live] = (await sql`
    SELECT COUNT(*)::int n,
           MAX(updated_at) AS last_updated,
           MAX(current_week_end_date) AS latest_week
    FROM keyword_current_summary
  `) as Array<Record<string, unknown>>;
  console.log(JSON.stringify(live, null, 2));

  console.log('\n=== Stage table ===');
  const [stage] = (await sql`
    SELECT COUNT(*)::int n, MAX(updated_at) AS last_updated
    FROM keyword_current_summary_stage
  `) as Array<Record<string, unknown>>;
  console.log(JSON.stringify(stage, null, 2));

  console.log('\n=== Recent Inngest activity (any active or recently completed runs) ===');
  // Long-shot — see if there's a phase_timing record for this file
  const phases = (await sql`
    SELECT phase, started_at, completed_at, EXTRACT(epoch FROM (completed_at - started_at))::int AS dur_sec
    FROM import_phase_timings
    WHERE uploaded_file_id = ${f.id}
    ORDER BY started_at
  `) as Array<Record<string, unknown>>;
  console.log(`  ${phases.length} phase timings recorded`);
  for (const p of phases) console.log(`    ${p.phase}: ${p.dur_sec ?? '?'}s, started ${p.started_at}, completed ${p.completed_at}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
