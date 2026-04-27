/**
 * Full audit of state after the parallel-import bug. Goals:
 *
 *  - For each file in the most recent batch, confirm:
 *    - file.validation_status
 *    - rows in kwm with source_file_id = file.id
 *    - rows in kwm with week_end_date = file.weekEndDate (regardless of source)
 *    - row counts vs file.row_count_loaded
 *  - Snapshot staging totals
 *  - Check pg_stat_activity for live import-related backends
 *  - Cross-reference reporting_weeks
 *  - Flag any file where status='imported' but kwm count = 0 (the worst case)
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';

async function main() {
  const sql = neon(process.env.DATABASE_URL!);

  console.log('\n====================================================');
  console.log('=== POST-PARALLEL-BUG AUDIT ===');
  console.log('====================================================');

  // Find the most recent batch (the one that exhibited the bug)
  const [batch] = (await sql`
    SELECT id, status, completed_at, created_at
    FROM upload_batches
    ORDER BY created_at DESC
    LIMIT 1
  `) as Array<{ id: string; status: string; completed_at: string | null; created_at: string }>;

  console.log(`\nBatch under audit: ${batch.id.slice(0, 8)}`);
  console.log(`  status: ${batch.status} | created: ${batch.created_at} | completed: ${batch.completed_at ?? 'null'}`);

  const files = (await sql`
    SELECT id, original_filename, validation_status, row_count_raw, row_count_loaded,
           week_end_date, import_phase, import_started_at, import_heartbeat_at, imported_at,
           validation_errors_json
    FROM uploaded_files
    WHERE batch_id = ${batch.id}
    ORDER BY week_end_date
  `) as Array<{
    id: string;
    original_filename: string;
    validation_status: string;
    row_count_raw: number | null;
    row_count_loaded: number | null;
    week_end_date: string;
    import_phase: string | null;
    import_started_at: string | null;
    import_heartbeat_at: string | null;
    imported_at: string | null;
    validation_errors_json: unknown;
  }>;

  console.log('\n=== FILE-BY-FILE AUDIT ===');
  const flags: Array<{ id: string; filename: string; problem: string }> = [];
  for (const f of files) {
    const [byId] = (await sql`
      SELECT COUNT(*)::int c FROM keyword_weekly_metrics WHERE source_file_id = ${f.id}
    `) as Array<{ c: number }>;
    const [byWeek] = (await sql`
      SELECT COUNT(*)::int c FROM keyword_weekly_metrics WHERE week_end_date = ${f.week_end_date}::date
    `) as Array<{ c: number }>;
    const sources = (await sql`
      SELECT source_file_id::text AS sid, COUNT(*)::int c
      FROM keyword_weekly_metrics
      WHERE week_end_date = ${f.week_end_date}::date
      GROUP BY source_file_id
    `) as Array<{ sid: string; c: number }>;

    const ws = f.week_end_date?.toString().slice(0, 10);
    console.log(`\n[${f.validation_status.padEnd(15)}] ${f.id.slice(0, 8)} | week=${ws} | ${f.original_filename}`);
    console.log(`    raw / loaded:  ${f.row_count_raw?.toLocaleString() ?? 'null'} / ${f.row_count_loaded?.toLocaleString() ?? 'null'}`);
    console.log(`    kwm by id:     ${byId.c.toLocaleString()}`);
    console.log(`    kwm by week:   ${byWeek.c.toLocaleString()}`);
    console.log(`    last phase:    ${f.import_phase ?? 'null'}`);
    if (sources.length > 1 || (sources.length === 1 && sources[0].sid !== f.id)) {
      console.log(`    ! sources for this week:`);
      for (const s of sources) console.log(`       ${s.sid.slice(0, 8)} -> ${s.c.toLocaleString()} rows`);
    }

    // Problem detection
    if (f.validation_status === 'imported' && byId.c === 0) {
      flags.push({ id: f.id, filename: f.original_filename, problem: 'STATUS=imported but 0 kwm rows' });
    }
    if (f.validation_status === 'import_failed' && byId.c > 0) {
      flags.push({ id: f.id, filename: f.original_filename, problem: `STATUS=import_failed but ${byId.c.toLocaleString()} kwm rows present` });
    }
    if (byId.c > 0 && f.row_count_loaded && Math.abs(byId.c - f.row_count_loaded) > f.row_count_loaded * 0.2) {
      flags.push({ id: f.id, filename: f.original_filename, problem: `kwm count (${byId.c.toLocaleString()}) differs from loaded (${f.row_count_loaded.toLocaleString()}) by > 20%` });
    }
  }

  console.log('\n=== FLAGGED ISSUES ===');
  if (flags.length === 0) console.log('(none)');
  for (const flag of flags) {
    console.log(` ⚠ ${flag.id.slice(0, 8)} | ${flag.filename}`);
    console.log(`    ${flag.problem}`);
  }

  console.log('\n=== STAGING TOTAL ===');
  const [stg] = (await sql`SELECT COUNT(*)::bigint c FROM staging_weekly_metrics`) as Array<{ c: string }>;
  console.log(' rows:', Number(stg.c).toLocaleString());

  console.log('\n=== ACTIVE BACKENDS (workers still connected?) ===');
  const activity = (await sql`
    SELECT pid, application_name, state, LEFT(query, 200) AS query, NOW() - query_start AS query_age
    FROM pg_stat_activity
    WHERE state = 'active'
      AND (query ILIKE '%keyword_weekly_metrics%' OR query ILIKE '%staging_weekly_metrics%' OR query ILIKE '%search_terms%')
      AND query NOT ILIKE '%pg_stat_activity%'
  `) as Array<Record<string, unknown>>;
  if (activity.length === 0) console.log(' (none)');
  for (const a of activity) console.log('  ', JSON.stringify(a));

  console.log('\n=== KWM BY WEEK (global) ===');
  const byWeekGlobal = (await sql`
    SELECT week_end_date, COUNT(*)::int c, COUNT(DISTINCT source_file_id)::int distinct_sources
    FROM keyword_weekly_metrics
    GROUP BY week_end_date ORDER BY week_end_date
  `) as Array<{ week_end_date: string; c: number; distinct_sources: number }>;
  for (const w of byWeekGlobal) {
    const flag = w.distinct_sources > 1 ? ' ⚠ MULTI-SOURCE' : '';
    console.log(` ${w.week_end_date?.toString().slice(0, 10)}: ${w.c.toLocaleString()} rows | ${w.distinct_sources} src${flag}`);
  }

  console.log('\n=== REPORTING_WEEKS for affected weeks ===');
  const fileIds = files.map((f) => f.id);
  const weekDates = files.map((f) => f.week_end_date);
  const rw = (await sql`
    SELECT week_end_date, source_file_id, is_complete
    FROM reporting_weeks
    WHERE week_end_date = ANY(${weekDates}::date[])
       OR source_file_id = ANY(${fileIds}::uuid[])
    ORDER BY week_end_date
  `) as Array<{ week_end_date: string; source_file_id: string; is_complete: boolean }>;
  for (const r of rw) {
    console.log(` ${r.week_end_date?.toString().slice(0, 10)} -> source=${r.source_file_id?.slice(0, 8) ?? 'null'} | complete=${r.is_complete}`);
  }

  console.log('\n====================================================');
  console.log('=== SUMMARY ===');
  console.log('====================================================');
  const totalRowsThisBatch = (
    await sql`
      SELECT COALESCE(SUM(c)::bigint, 0) AS total FROM (
        SELECT COUNT(*) c FROM keyword_weekly_metrics WHERE source_file_id = ANY(${fileIds}::uuid[])
      ) t
    `
  )[0] as unknown as { total: string };
  console.log(' kwm rows landed for this batch:', Number(totalRowsThisBatch.total).toLocaleString());
  console.log(' files flagged with issues:', flags.length);
  console.log(' staging rows:', Number(stg.c).toLocaleString(), '(should be 0 if worker stopped cleanly)');
  console.log(' active backends:', activity.length);
}

main().catch((e) => { console.error(e); process.exit(1); });
