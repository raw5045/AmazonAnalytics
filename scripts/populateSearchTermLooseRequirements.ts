/**
 * One-shot population of search_term_loose_requirements from the
 * existing loose_search_tokens + loose_token_forms_bidirectional
 * Postgres functions. Computes one row per search_term — needles
 * are stored already-padded as " form " for direct POSITION matching.
 *
 * 8 token slots × 4 form slots per token (matches migration 0018).
 * Overflow (>8 tokens) flagged; those rows fall through to the slow
 * function path during backfill / import.
 *
 * Idempotent via ON CONFLICT DO UPDATE keyed on search_term_id.
 *
 * Runtime: ~5-10 min for ~9.5M search_terms on Neon.
 *
 * Usage: pnpm tsx scripts/populateSearchTermLooseRequirements.ts
 *
 * Optional env: SEARCH_TERMS_LIMIT=10000 (smaller run for testing)
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { Pool } from 'pg';

const TOKEN_SLOTS = 8;
const FORM_SLOTS = 4;
const LOGIC_VERSION = 1;

function buildInsertSql(): string {
  const cols: string[] = [];
  const aggs: string[] = [];
  for (let t = 1; t <= TOKEN_SLOTS; t++) {
    for (let f = 1; f <= FORM_SLOTS; f++) {
      cols.push(`t${t}_f${f}`);
      aggs.push(
        `MAX(needle) FILTER (WHERE ord = ${t} AND form_ord = ${f}) AS t${t}_f${f}`,
      );
    }
  }

  const updateSet = cols.map((c) => `${c} = EXCLUDED.${c}`).join(',\n        ');

  return `
    WITH token_rows AS (
      SELECT
        st.id AS search_term_id,
        tok.token,
        tok.ord
      FROM search_terms st
      CROSS JOIN LATERAL unnest(loose_search_tokens(st.search_term_normalized))
        WITH ORDINALITY AS tok(token, ord)
      WHERE 1=1 ${process.env.SEARCH_TERMS_LIMIT ? `AND st.id IN (SELECT id FROM search_terms LIMIT ${Number(process.env.SEARCH_TERMS_LIMIT)})` : ''}
    ),
    form_rows AS (
      SELECT DISTINCT
        tr.search_term_id,
        tr.ord,
        ' ' || f.form || ' ' AS needle
      FROM token_rows tr
      CROSS JOIN LATERAL unnest(loose_token_forms_bidirectional(tr.token)) AS f(form)
      WHERE tr.ord <= ${TOKEN_SLOTS}
    ),
    numbered_forms AS (
      SELECT
        search_term_id, ord, needle,
        row_number() OVER (PARTITION BY search_term_id, ord ORDER BY needle) AS form_ord
      FROM form_rows
    ),
    token_counts AS (
      SELECT
        search_term_id,
        COUNT(*)::smallint AS token_count,
        bool_or(ord > ${TOKEN_SLOTS}) AS overflow
      FROM token_rows
      GROUP BY search_term_id
    )
    INSERT INTO search_term_loose_requirements (
      search_term_id, token_count, overflow, logic_version,
      ${cols.join(', ')}
    )
    SELECT
      tc.search_term_id,
      COALESCE(tc.token_count, 0)::smallint,
      COALESCE(tc.overflow, false),
      ${LOGIC_VERSION},
      ${aggs.join(',\n      ')}
    FROM token_counts tc
    LEFT JOIN numbered_forms nf USING (search_term_id)
    GROUP BY tc.search_term_id, tc.token_count, tc.overflow
    ON CONFLICT (search_term_id) DO UPDATE SET
      token_count = EXCLUDED.token_count,
      overflow = EXCLUDED.overflow,
      logic_version = EXCLUDED.logic_version,
      updated_at = now(),
      ${updateSet}
  `;
}

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL!,
    statement_timeout: 1_800_000,
  });
  const client = await pool.connect();
  try {
    console.log('Building search_term_loose_requirements...');
    const t0 = Date.now();
    const result = await client.query(buildInsertSql());
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`Inserted/updated ${(result.rowCount ?? 0).toLocaleString()} rows in ${elapsed}s.`);

    // Summary
    const { rows } = await client.query<{
      total: number;
      overflow: number;
      avg_tokens: number;
    }>(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE overflow)::int AS overflow,
         AVG(token_count)::numeric(10,2) AS avg_tokens
       FROM search_term_loose_requirements`,
    );
    const r = rows[0];
    console.log(`\nTable populated: ${r.total.toLocaleString()} rows`);
    console.log(`  overflow (>${TOKEN_SLOTS} tokens, slow-path fallback): ${r.overflow.toLocaleString()} (${(r.overflow / r.total * 100).toFixed(2)}%)`);
    console.log(`  avg tokens per term: ${r.avg_tokens}`);
  } finally {
    client.release();
    await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
