/**
 * Fast verification of the 52-week backfill — relies on the small
 * tables (reporting_weeks, uploaded_files, upload_batches) for
 * source-of-truth checks. Skips per-week kwm COUNT(*) which is slow
 * over Neon's HTTP driver. The integrity guarantees we get from
 * reporting_weeks alone:
 *  - Each week has a row -> processFileImport's reporting_weeks_upsert
 *    ran (which only happens AFTER kwm_insert)
 *  - source_file_id matches a real uploaded_files row marked imported
 *  - is_complete=true for every week
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';

async function main() {
  const sql = neon(process.env.DATABASE_URL!);

  console.log('\n=== reporting_weeks (source of truth) ===');
  const rw = (await sql`
    SELECT rw.week_end_date, rw.source_file_id, rw.is_complete,
           uf.validation_status AS file_status, uf.original_filename
    FROM reporting_weeks rw
    LEFT JOIN uploaded_files uf ON uf.id = rw.source_file_id
    ORDER BY rw.week_end_date
  `) as Array<{
    week_end_date: string;
    source_file_id: string | null;
    is_complete: boolean;
    file_status: string | null;
    original_filename: string | null;
  }>;
  console.log(` rows: ${rw.length}`);

  let issues = 0;
  for (const r of rw) {
    const ws = r.week_end_date?.toString().slice(0, 10);
    const flag =
      !r.is_complete ? ' ❌ NOT COMPLETE' :
      !r.source_file_id ? ' ❌ NO SOURCE FILE' :
      r.file_status !== 'imported' ? ` ❌ FILE STATUS=${r.file_status}` :
      '';
    if (flag) issues++;
    console.log(` ${ws} | source=${r.source_file_id?.slice(0, 8) ?? 'null'} | file=${r.file_status ?? 'missing'}${flag}`);
  }

  console.log('\n=== files in non-terminal status ===');
  const stuck = (await sql`
    SELECT id, original_filename, validation_status, batch_id
    FROM uploaded_files
    WHERE validation_status NOT IN ('imported', 'fail', 'import_failed', 'pending')
    ORDER BY created_at DESC
  `) as Array<{ id: string; original_filename: string; validation_status: string; batch_id: string }>;
  if (stuck.length === 0) console.log(' (none) ✓');
  else for (const f of stuck) console.log(` ⚠ ${f.id.slice(0, 8)} | ${f.validation_status} | ${f.original_filename}`);

  console.log('\n=== batches in non-terminal status ===');
  const batchesActive = (await sql`
    SELECT id, status, created_at FROM upload_batches
    WHERE status NOT IN ('imported', 'imported_partial', 'failed')
    ORDER BY created_at DESC
  `) as Array<{ id: string; status: string; created_at: string }>;
  if (batchesActive.length === 0) console.log(' (none) ✓');
  else for (const b of batchesActive) console.log(` ⚠ ${b.id.slice(0, 8)} | ${b.status} | ${b.created_at}`);

  console.log('\n=== staging ===');
  const [stg] = (await sql`SELECT COUNT(*)::bigint c FROM staging_weekly_metrics`) as Array<{ c: string }>;
  console.log(' rows:', Number(stg.c).toLocaleString(), '(should be 0)');

  console.log('\n=== search_terms ===');
  const [st] = (await sql`SELECT COUNT(*)::bigint c FROM search_terms`) as Array<{ c: string }>;
  console.log(' rows:', Number(st.c).toLocaleString());

  // Date range coverage check — what's the span?
  if (rw.length > 0) {
    const first = rw[0].week_end_date?.toString().slice(0, 10);
    const last = rw[rw.length - 1].week_end_date?.toString().slice(0, 10);
    console.log(`\n=== Date range ===\n ${first} → ${last} (${rw.length} weeks)`);
  }

  console.log('\n====================================================');
  if (rw.length >= 52 && issues === 0 && stuck.length === 0 && batchesActive.length === 0 && Number(stg.c) === 0) {
    console.log(`✅ BACKFILL VERIFIED CLEAN: ${rw.length} weeks complete, no stuck files/batches`);
  } else {
    console.log(`⚠ ${rw.length} weeks reported, ${issues} integrity issues, ${stuck.length} stuck files, ${batchesActive.length} non-terminal batches, ${stg.c} staging rows`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
