/**
 * Integration test for the custom-categories DB layer.
 *
 * Gated by RUN_INTEGRATION=1 (same as all integration tests). Requires a
 * test database with migration 0038 applied (custom_categories table).
 *
 * Tests the security-critical user-scoping and graceful-skip-of-unknown-IDs
 * behaviour of the two DB-layer functions, against real Postgres.
 *
 * Run: RUN_INTEGRATION=1 pnpm test:integration tests/integration/customCategories.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import 'dotenv/config';

import { listCustomCategoriesForUser } from '@/lib/customCategories/loadServer';
import { expandCustomCategories } from '@/lib/customCategories/expand';

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('custom-categories DB layer (integration)', () => {
  let pool: Pool;

  // User A and User B numeric DB ids (uuid strings)
  let userAId: string;
  let userBId: string;

  // Category IDs for user A
  let aSupplementsId: string;
  let aMineralsId: string;

  // Category ID for user B
  let bCatId: string;

  beforeAll(async () => {
    if (!process.env.RUN_INTEGRATION) return;

    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Create two dummy users with @test.invalid emails and
      // weekly_digest_subscribed = false (defense in depth — cannot become
      // digest recipients even if stranded by a killed test run).
      const { rows: userARows } = await client.query<{ id: string }>(
        `INSERT INTO users (clerk_user_id, email, weekly_digest_subscribed)
         VALUES ('cctest_userA_' || extract(epoch from now())::bigint,
                 'cctest_a_' || extract(epoch from now())::bigint || '@test.invalid',
                 false)
         RETURNING id`,
      );
      userAId = userARows[0].id;

      const { rows: userBRows } = await client.query<{ id: string }>(
        `INSERT INTO users (clerk_user_id, email, weekly_digest_subscribed)
         VALUES ('cctest_userB_' || extract(epoch from now())::bigint,
                 'cctest_b_' || extract(epoch from now())::bigint || '@test.invalid',
                 false)
         RETURNING id`,
      );
      userBId = userBRows[0].id;

      // Insert custom_categories for user A.
      const { rows: aSupplementsRows } = await client.query<{ id: string }>(
        `INSERT INTO custom_categories (user_id, name, leaf_names)
         VALUES ($1, 'A-Supplements', $2::jsonb)
         RETURNING id`,
        [userAId, JSON.stringify(['Collagen', 'Iron'])],
      );
      aSupplementsId = aSupplementsRows[0].id;

      const { rows: aMineralsRows } = await client.query<{ id: string }>(
        `INSERT INTO custom_categories (user_id, name, leaf_names)
         VALUES ($1, 'A-Minerals', $2::jsonb)
         RETURNING id`,
        [userAId, JSON.stringify(['Zinc', 'Iron'])],
      );
      aMineralsId = aMineralsRows[0].id;

      // Insert custom_categories for user B.
      const { rows: bCatRows } = await client.query<{ id: string }>(
        `INSERT INTO custom_categories (user_id, name, leaf_names)
         VALUES ($1, 'B-Cat', $2::jsonb)
         RETURNING id`,
        [userBId, JSON.stringify(['SecretLeaf'])],
      );
      bCatId = bCatRows[0].id;

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }, 300_000 /* 5-minute timeout */);

  afterAll(async () => {
    if (!pool) return;
    const client = await pool.connect();
    try {
      // custom_categories rows are ON DELETE CASCADE from users, but we delete
      // them explicitly first to be FK-safe and clear about intent. Best-effort:
      // errors are logged but not thrown so the user cleanup always runs.
      for (const [label, stmt, params] of [
        ['custom_categories userA', `DELETE FROM custom_categories WHERE user_id = $1`, [userAId]],
        ['custom_categories userB', `DELETE FROM custom_categories WHERE user_id = $1`, [userBId]],
      ] as Array<[string, string, string[]]>) {
        try {
          await client.query(stmt, params);
        } catch (e) {
          console.error(`[customCategories cleanup] ${label}`, e);
        }
      }

      // Delete the two dummy users. Best-effort per user so one failure
      // doesn't prevent the other from being swept.
      if (userAId) {
        try {
          await client.query(`DELETE FROM users WHERE id = $1`, [userAId]);
        } catch (e) {
          console.error('[customCategories cleanup] delete userA', e);
        }
      }
      if (userBId) {
        try {
          await client.query(`DELETE FROM users WHERE id = $1`, [userBId]);
        } catch (e) {
          console.error('[customCategories cleanup] delete userB', e);
        }
      }
    } finally {
      client.release();
      await pool.end();
    }
  });

  // -------------------------------------------------------------------------
  // (a) listCustomCategoriesForUser is user-scoped
  // -------------------------------------------------------------------------

  it('(a) listCustomCategoriesForUser returns only the calling user\'s categories', async () => {
    if (!process.env.RUN_INTEGRATION) {
      console.log('SKIPPED — no test DB (RUN_INTEGRATION not set)');
      return;
    }

    const [catA, catB] = await Promise.all([
      listCustomCategoriesForUser(userAId),
      listCustomCategoriesForUser(userBId),
    ]);

    // User A sees exactly their two categories (no more, no less).
    expect(catA.map((c) => c.name).sort()).toEqual(['A-Minerals', 'A-Supplements']);

    // User B sees exactly their one category.
    expect(catB.map((c) => c.name)).toEqual(['B-Cat']);

    // Neither leaks the other's rows.
    expect(catA.map((c) => c.name)).not.toContain('B-Cat');
    expect(catB.map((c) => c.name)).not.toContain('A-Supplements');
    expect(catB.map((c) => c.name)).not.toContain('A-Minerals');
  });

  // -------------------------------------------------------------------------
  // (b) expandCustomCategories unions + dedups + sorts
  // -------------------------------------------------------------------------

  it('(b) expandCustomCategories unions leaf names, deduplicates, and sorts', async () => {
    if (!process.env.RUN_INTEGRATION) {
      console.log('SKIPPED — no test DB (RUN_INTEGRATION not set)');
      return;
    }

    // A-Supplements: ['Collagen', 'Iron']
    // A-Minerals:    ['Zinc', 'Iron']
    // baseLeaves:    ['Magnesium']
    // union deduped: ['Collagen', 'Iron', 'Magnesium', 'Zinc'] (sorted)
    const result = await expandCustomCategories(
      userAId,
      [aSupplementsId, aMineralsId],
      ['Magnesium'],
    );

    expect(result).toEqual(['Collagen', 'Iron', 'Magnesium', 'Zinc']);
  });

  // -------------------------------------------------------------------------
  // (c) expandCustomCategories is user-scoped (security)
  // -------------------------------------------------------------------------

  it('(c) expandCustomCategories cannot expand another user\'s category by id', async () => {
    if (!process.env.RUN_INTEGRATION) {
      console.log('SKIPPED — no test DB (RUN_INTEGRATION not set)');
      return;
    }

    // User A passes user B's category id. The DB-layer WHERE clause
    // (userId = userAId AND id IN [...]) filters it out silently.
    const result = await expandCustomCategories(userAId, [bCatId], ['Base']);

    // Only the base leaf should be returned — 'SecretLeaf' must NOT appear.
    expect(result).toEqual(['Base']);
    expect(result).not.toContain('SecretLeaf');
  });

  // -------------------------------------------------------------------------
  // (d) expandCustomCategories skips unknown/deleted ids gracefully
  // -------------------------------------------------------------------------

  it('(d) expandCustomCategories silently ignores unknown/deleted ids', async () => {
    if (!process.env.RUN_INTEGRATION) {
      console.log('SKIPPED — no test DB (RUN_INTEGRATION not set)');
      return;
    }

    const bogusUuid = '00000000-0000-0000-0000-000000000000';

    // aSupplementsId is valid; bogusUuid doesn't exist → no throw, just skipped.
    const result = await expandCustomCategories(userAId, [aSupplementsId, bogusUuid], []);

    expect(result).toEqual(['Collagen', 'Iron']);
  });

  // -------------------------------------------------------------------------
  // (e) empty ids short-circuits and returns baseLeaves unchanged
  // -------------------------------------------------------------------------

  it('(e) expandCustomCategories with empty ids returns baseLeaves unchanged', async () => {
    if (!process.env.RUN_INTEGRATION) {
      console.log('SKIPPED — no test DB (RUN_INTEGRATION not set)');
      return;
    }

    const result = await expandCustomCategories(userAId, [], ['Base']);

    expect(result).toEqual(['Base']);
  });
});
