/**
 * Integration test for the search_term_normalized GIN swap mechanics used by
 * refreshSummary (Task v2-D).
 *
 * Gated by RUN_INTEGRATION=1. Requires a Postgres with the pg_trgm extension
 * (migration 0002). It does NOT touch the real keyword_current_summary tables —
 * it spins up its own throwaway scratch pair (kcs_gintest_live / _stage) with
 * test-unique index names, so it's collision-proof against prod indexes and
 * safe to run against any environment.
 *
 * What it proves end-to-end on a real engine:
 *   - dropNormalizedGin (the production helper) does a NAME-AGNOSTIC sweep:
 *     it finds and drops whatever trigram GIN sits on the column, even one left
 *     under a stale rotated name by a prior cycle.
 *   - The 3-way RENAME swap rotates index objects with their heap, so the
 *     swapped-in live table ends with EXACTLY ONE GIN on the column (never two,
 *     never zero) — the invariant the rotating A/B naming exists to guarantee.
 *
 * Run: RUN_INTEGRATION=1 pnpm test:integration tests/integration/kcsNormalizedGin.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import 'dotenv/config';

import { dropNormalizedGin } from '@/inngest/functions/refreshSummary';

const LIVE = 'kcs_gintest_live';
const STAGE = 'kcs_gintest_stage';

/** Names of the trigram GINs currently on <table>.search_term_normalized. */
async function ginNamesOn(client: PoolClient, table: string): Promise<string[]> {
  const { rows } = await client.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = $1
       AND indexdef ILIKE '%using gin%search_term_normalized%'
     ORDER BY indexname`,
    [table],
  );
  return rows.map((r) => r.indexname);
}

describe('kcs search_term_normalized GIN swap mechanics (integration)', () => {
  let pool: Pool;

  beforeAll(async () => {
    if (!process.env.RUN_INTEGRATION) return;
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const client = await pool.connect();
    try {
      // Clean slate (in case a prior run died mid-way).
      await client.query(`DROP TABLE IF EXISTS ${LIVE} CASCADE`);
      await client.query(`DROP TABLE IF EXISTS ${STAGE} CASCADE`);

      // Scratch live + stage, each with the column under test.
      await client.query(
        `CREATE TABLE ${LIVE} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), search_term_normalized varchar(512))`,
      );
      await client.query(
        `CREATE TABLE ${STAGE} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), search_term_normalized varchar(512))`,
      );
      await client.query(`INSERT INTO ${LIVE} (search_term_normalized) VALUES ('hair loss'), ('best hair oil')`);

      // Live carries its GIN (the "currently live" index).
      await client.query(
        `CREATE INDEX kcs_gintest_live_idx ON ${LIVE} USING gin (search_term_normalized gin_trgm_ops)`,
      );
      // Stage carries a STALE GIN under a DIFFERENT name (as if rotated in from a
      // prior cycle) — dropNormalizedGin must catch it despite the name.
      await client.query(
        `CREATE INDEX kcs_gintest_stage_stale_idx ON ${STAGE} USING gin (search_term_normalized gin_trgm_ops)`,
      );
    } finally {
      client.release();
    }
  }, 120_000);

  afterAll(async () => {
    if (!pool) return;
    const client = await pool.connect();
    try {
      await client.query(`DROP TABLE IF EXISTS ${LIVE} CASCADE`);
      await client.query(`DROP TABLE IF EXISTS ${STAGE} CASCADE`);
    } finally {
      client.release();
      await pool.end();
    }
  });

  it('dropNormalizedGin sweeps the stale stage GIN regardless of its name', async () => {
    if (!process.env.RUN_INTEGRATION) {
      console.log('SKIPPED — no test DB (RUN_INTEGRATION not set)');
      return;
    }
    const client = await pool.connect();
    try {
      expect(await ginNamesOn(client, STAGE)).toEqual(['kcs_gintest_stage_stale_idx']);
      await dropNormalizedGin(client, STAGE);
      expect(await ginNamesOn(client, STAGE)).toEqual([]);
      // Live untouched.
      expect(await ginNamesOn(client, LIVE)).toEqual(['kcs_gintest_live_idx']);
    } finally {
      client.release();
    }
  });

  it('after build + 3-way RENAME swap, the swapped-in live has exactly one GIN', async () => {
    if (!process.env.RUN_INTEGRATION) {
      console.log('SKIPPED — no test DB (RUN_INTEGRATION not set)');
      return;
    }
    const client = await pool.connect();
    try {
      // Build a fresh GIN on stage under a name NOT on live (the rotation rule).
      await client.query(
        `CREATE INDEX kcs_gintest_stage_fresh_idx ON ${STAGE} USING gin (search_term_normalized gin_trgm_ops)`,
      );

      // 3-way RENAME swap (mirrors refreshSummary): live→tmp, stage→live, tmp→stage.
      await client.query('BEGIN');
      await client.query(`ALTER TABLE ${LIVE} RENAME TO kcs_gintest_swap_tmp`);
      await client.query(`ALTER TABLE ${STAGE} RENAME TO ${LIVE}`);
      await client.query(`ALTER TABLE kcs_gintest_swap_tmp RENAME TO ${STAGE}`);
      await client.query('COMMIT');

      // Swapped-in live (formerly stage) carries exactly the fresh GIN — one, not two.
      expect(await ginNamesOn(client, LIVE)).toEqual(['kcs_gintest_stage_fresh_idx']);
      // Swapped-out stage (formerly live) carries the old live GIN.
      expect(await ginNamesOn(client, STAGE)).toEqual(['kcs_gintest_live_idx']);
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  });
});
