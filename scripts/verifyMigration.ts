import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';

async function main() {
  const sql = neon(process.env.DATABASE_URL!);

  console.log('\n=== fake_volume_severity enum ===');
  const enums = (await sql`
    SELECT unnest(enum_range(NULL::fake_volume_severity)) AS value
  `) as Array<{ value: string }>;
  for (const e of enums) console.log(' ', e.value);

  console.log('\n=== fake_volume_severity column on kwm ===');
  const kwmCol = (await sql`
    SELECT column_name, data_type, udt_name
    FROM information_schema.columns
    WHERE table_name = 'keyword_weekly_metrics' AND column_name = 'fake_volume_severity'
  `) as Array<Record<string, unknown>>;
  console.log(' ', JSON.stringify(kwmCol[0]));

  console.log('\n=== fake_volume_rules seed ===');
  const rules = (await sql`SELECT version_name, is_active, warning_rules_json, critical_rules_json FROM fake_volume_rules`) as Array<{
    version_name: string;
    is_active: boolean;
    warning_rules_json: unknown;
    critical_rules_json: unknown;
  }>;
  for (const r of rules) {
    console.log(` version=${r.version_name} active=${r.is_active}`);
    console.log(`  warning: ${JSON.stringify(r.warning_rules_json)}`);
    console.log(`  critical: ${JSON.stringify(r.critical_rules_json)}`);
  }

  console.log('\n=== keyword_current_summary table ===');
  const [kcs] = (await sql`SELECT COUNT(*)::int c FROM keyword_current_summary`) as Array<{ c: number }>;
  console.log(` rows: ${kcs.c} (should be 0 — refresh job will populate)`);

  console.log('\n=== keyword_current_summary indexes ===');
  const idx = (await sql`
    SELECT indexname FROM pg_indexes
    WHERE tablename = 'keyword_current_summary'
    ORDER BY indexname
  `) as Array<{ indexname: string }>;
  for (const i of idx) console.log(' ', i.indexname);
}

main().catch((e) => { console.error(e); process.exit(1); });
