/**
 * Explorer perf diagnostic. Measures where time goes in the keyword
 * explorer page's data layer.
 *
 * Runs each query variant 3 times (warm cache) plus once with EXPLAIN
 * (ANALYZE, BUFFERS) so we can see plan choice + buffer hits.
 *
 * Variants covered:
 *   1. Default landing (no filters except severity=['none','warning'], sort by rank, page 1)
 *   2. Default landing + category filter
 *   3. Default landing + title-gap filter (a known cardinality-heavy case)
 *   4. Search by 'q' (LIKE on normalized term)
 *   5. The bail-out COUNT(*) for the default landing
 *   6. listCategories DISTINCT scan
 *
 * Run: pnpm tsx scripts/diagExplorerPerf.ts
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { Pool } from 'pg';
import { buildExplorerQuery } from '@/lib/explorer/buildQuery';
import { EXPLORER_DEFAULTS } from '@/lib/explorer/parseFilters';
import type { ExplorerFilters } from '@/lib/explorer/types';

interface Variant {
  name: string;
  filters: ExplorerFilters;
  /** Override the test target: 'sql' = main paged SELECT; 'count' = COUNT(*). Default 'sql'. */
  target?: 'sql' | 'count';
}

const VARIANTS: Variant[] = [
  {
    name: 'Default landing (severity=none,warning; sort=rank; page 1)',
    filters: { ...EXPLORER_DEFAULTS },
  },
  {
    name: 'Default landing — COUNT query',
    filters: { ...EXPLORER_DEFAULTS },
    target: 'count',
  },
  {
    name: 'With category filter ("Health & Personal Care")',
    filters: { ...EXPLORER_DEFAULTS, category: 'Health & Personal Care' },
  },
  {
    name: 'With title-gap (loose, missing all 3) — high-cardinality WHERE',
    filters: { ...EXPLORER_DEFAULTS, titleMatchMode: 'all', titleSlots: [1, 2, 3] },
  },
  {
    name: 'With search query ("creatine")',
    filters: { ...EXPLORER_DEFAULTS, q: 'creatine' },
  },
  {
    name: 'Threshold jump (preset 100k_to_50k, sort by 1w improvement)',
    filters: { ...EXPLORER_DEFAULTS, jump: '100k_to_50k', sort: 'imp' },
  },
  {
    name: 'Deep page (page 50 of default — OFFSET 4900 LIMIT 100)',
    filters: { ...EXPLORER_DEFAULTS, page: 50 },
  },
];

async function timeQuery(c: import('pg').PoolClient, sql: string, args: unknown[]): Promise<number> {
  const t0 = Date.now();
  await c.query(sql, args);
  return Date.now() - t0;
}

async function median(times: number[]): Promise<number> {
  const s = [...times].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL!, statement_timeout: 60_000 });
  const c = await pool.connect();
  try {
    // Cold-cache warm-up — first query always costs more on Neon
    console.log('Warming up connection + page cache...\n');
    const { sql: warm } = buildExplorerQuery(EXPLORER_DEFAULTS);
    await c.query(warm, [...buildExplorerQuery(EXPLORER_DEFAULTS).args]);

    for (const v of VARIANTS) {
      const built = buildExplorerQuery(v.filters);
      const sql = v.target === 'count' ? built.countSql : built.sql;
      const args = v.target === 'count' ? built.countArgs : built.args;

      // 3 warm-cache runs
      const times: number[] = [];
      for (let i = 0; i < 3; i++) {
        times.push(await timeQuery(c, sql, args));
      }
      const med = await median(times);
      console.log(`▶ ${v.name}`);
      console.log(`   times (ms): ${times.join(' / ')}  → median ${med}ms`);
    }

    // listCategories (the explorer page's parallel sidebar fetch)
    {
      const times: number[] = [];
      for (let i = 0; i < 3; i++) {
        times.push(
          await timeQuery(
            c,
            `SELECT DISTINCT top_clicked_category_1_current AS category
             FROM keyword_current_summary
             WHERE top_clicked_category_1_current IS NOT NULL
             ORDER BY top_clicked_category_1_current`,
            [],
          ),
        );
      }
      const med = await median(times);
      console.log(`▶ listCategories (cached in prod, but cold is the bad case)`);
      console.log(`   times (ms): ${times.join(' / ')}  → median ${med}ms`);
    }

    // EXPLAIN ANALYZE on the default landing query — shows plan + buffers
    console.log(`\n=== EXPLAIN (ANALYZE, BUFFERS) for the default landing ===\n`);
    const def = buildExplorerQuery(EXPLORER_DEFAULTS);
    const explain = (await c.query(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${def.sql}`,
      def.args,
    )).rows as Array<{ 'QUERY PLAN': string }>;
    for (const r of explain) console.log(r['QUERY PLAN']);

    console.log(`\n=== EXPLAIN (ANALYZE, BUFFERS) for the COUNT query ===\n`);
    const explainCount = (await c.query(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${def.countSql}`,
      def.countArgs,
    )).rows as Array<{ 'QUERY PLAN': string }>;
    for (const r of explainCount) console.log(r['QUERY PLAN']);
  } finally {
    c.release();
    await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
