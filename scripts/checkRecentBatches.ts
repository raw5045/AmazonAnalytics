/**
 * Fast progress check for the most recent batch — just file statuses,
 * no kwm count (which is slow on a 60M+ row table). Uses cached
 * row_count_loaded to show import progress.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';

async function main() {
  const sql = neon(process.env.DATABASE_URL!);

  const [batch] = (await sql`
    SELECT id, status, completed_at, created_at FROM upload_batches
    ORDER BY created_at DESC LIMIT 1
  `) as Array<{ id: string; status: string; completed_at: string | null; created_at: string }>;
  console.log(`\n=== BATCH ${batch.id.slice(0, 8)} | ${batch.status} ===`);
  console.log(`  created: ${batch.created_at}`);
  console.log(`  completed: ${batch.completed_at ?? 'null'}`);

  const files = (await sql`
    SELECT id, original_filename, validation_status, week_end_date,
           row_count_raw, row_count_loaded, imported_at, import_phase,
           import_started_at, import_heartbeat_at
    FROM uploaded_files
    WHERE batch_id = ${batch.id}
    ORDER BY week_end_date
  `) as Array<{
    id: string;
    original_filename: string;
    validation_status: string;
    week_end_date: string;
    row_count_raw: number | null;
    row_count_loaded: number | null;
    imported_at: string | null;
    import_phase: string | null;
    import_started_at: string | null;
    import_heartbeat_at: string | null;
  }>;

  console.log('\n=== FILE STATUS ===');
  for (const f of files) {
    const ws = f.week_end_date?.toString().slice(0, 10);
    const live = f.import_started_at ? ' ⏳ ACTIVE' : '';
    console.log(`\n ${f.id.slice(0, 8)} | ${ws} | ${f.original_filename}${live}`);
    console.log(`   status=${f.validation_status} | phase=${f.import_phase ?? 'null'}`);
    console.log(`   raw=${f.row_count_raw?.toLocaleString() ?? 'null'} | loaded=${f.row_count_loaded?.toLocaleString() ?? 'null'}`);
    if (f.import_started_at) {
      const heartbeatAge = f.import_heartbeat_at ? Math.round((Date.now() - new Date(f.import_heartbeat_at).getTime()) / 1000) : null;
      console.log(`   started_at=${f.import_started_at} | heartbeat ${heartbeatAge !== null ? heartbeatAge + 's ago' : 'never'}`);
    }
    if (f.imported_at) console.log(`   imported_at=${f.imported_at}`);
  }

  console.log('\n=== STAGING ===');
  const [stg] = (await sql`SELECT COUNT(*)::bigint c FROM staging_weekly_metrics`) as Array<{ c: string }>;
  console.log(' rows:', Number(stg.c).toLocaleString());

  console.log('\n=== ACTIVE pg_stat_activity backends ===');
  const activity = (await sql`
    SELECT pid, state, NOW() - query_start AS query_age, LEFT(query, 100) AS query
    FROM pg_stat_activity
    WHERE state = 'active'
      AND (query ILIKE '%keyword_weekly_metrics%'
        OR query ILIKE '%staging_weekly_metrics%'
        OR query ILIKE '%search_terms%'
        OR query ILIKE '%COPY %')
      AND query NOT ILIKE '%pg_stat_activity%'
  `) as Array<Record<string, unknown>>;
  if (activity.length === 0) console.log(' (none active)');
  for (const a of activity) console.log('  ', JSON.stringify(a));
}

main().catch((e) => { console.error(e); process.exit(1); });
