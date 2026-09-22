// tests/integration/helpers.ts
//
// Shared helpers for integration tests, which run against the PRODUCTION
// database (tests/integration/setup.ts loads .env.local). The whole point of
// this module is that test users NEVER accumulate as orphaned rows in that
// table: every one created via createTestUser is (a) clearly synthetic so the
// orphan sweep can find it, (b) unsubscribed + undeliverable so a leaked row
// can never break the weekly digest, and (c) removed — with everything it owns —
// by deleteTestUser, keyed by ownership rather than by ids captured in
// beforeAll (which may be undefined if beforeAll threw partway).
//
// See lib/notifications/digest/recipients.ts (the digest break this guards
// against) and tests/integration/globalSetup.ts (the suite-wide backstop).
import { db } from '@/db/client';
import { eq, inArray, sql } from 'drizzle-orm';
import {
  users,
  uploadBatches,
  uploadedFiles,
  keywordWeeklyMetrics,
  reportingWeeks,
  stagingWeeklyMetrics,
  ingestionErrors,
  importDuplicateSearchTerms,
  auditLog,
  type User,
  type NewUser,
} from '@/db/schema';

/**
 * The closed set of email prefixes integration-test users are allowed to use.
 * The orphan-sweep regex is derived from this list, so a test that invents a
 * new prefix without adding it here would create an unsweepable row — hence
 * createTestUser tripwires on it. Matches the four historical patterns
 * (`integration_`, `itest_`, `rw_`, `csmtest_`) so existing/raw-SQL tests stay
 * covered.
 */
export const TEST_USER_PREFIXES = ['integration', 'itest', 'rw', 'csmtest'] as const;
export type TestUserPrefix = (typeof TEST_USER_PREFIXES)[number];

/**
 * Postgres regex (for the `~` operator) matching every synthetic test-user
 * email: `<prefix>_<epoch>@...`. Anchored at the start and requiring a numeric
 * epoch + `@` keeps it from ever matching a real Clerk-provisioned user.
 */
export const TEST_USER_EMAIL_SQL_PATTERN = `^(${TEST_USER_PREFIXES.join('|')})_[0-9]+@`;
const TEST_USER_EMAIL_REGEX = new RegExp(TEST_USER_EMAIL_SQL_PATTERN);

/**
 * Insert a synthetic user for an integration test.
 *
 * `weeklyDigestSubscribed` defaults to false: this is the load-bearing defense
 * in depth. Even if cleanup never runs (process killed before afterAll), a
 * leaked test user can never be selected as a digest recipient. The
 * example.com domain (RFC 2606 reserved, rejected by isUndeliverableEmail) is
 * a second layer; the global orphan sweep is a third.
 *
 * A single epoch is shared by the clerk id and email so they always agree
 * (the previous inline `Date.now()`-twice pattern could split across a ms).
 */
export async function createTestUser(
  prefix: TestUserPrefix,
  overrides: Partial<NewUser> = {},
): Promise<User> {
  const epoch = Date.now();
  const email = `${prefix}_${epoch}@example.com`;
  // Tripwire: fail loudly at creation if an edit ever produces an email the
  // sweep can't match, rather than silently leaking an unsweepable row.
  if (!TEST_USER_EMAIL_REGEX.test(email)) {
    throw new Error(
      `createTestUser produced "${email}", which does not match ` +
        `TEST_USER_EMAIL_SQL_PATTERN (${TEST_USER_EMAIL_SQL_PATTERN}).`,
    );
  }
  const [user] = await db
    .insert(users)
    .values({
      clerkUserId: `${prefix}_${epoch}`,
      email,
      weeklyDigestSubscribed: false,
      ...overrides,
    })
    .returning();
  return user;
}

/**
 * Remove a test user and everything it owns, tolerant of partial setup.
 *
 * The FKs into `users` fall into three groups:
 *   - cascade  (saved_views, watchlist_items, weekly_digest_sends) — removed
 *     automatically by the final `delete users`.
 *   - set null (weekly_digest_runs.triggered_by) — also handled by that delete.
 *   - restrict (upload_batches.created_by_user_id, audit_log.user_id, …) — the
 *     only group that can BLOCK the delete, so we clear it here first.
 *
 * The realistic restrict blocker a test populates is its upload batch and that
 * batch's whole derived chain. We resolve it by OWNERSHIP
 * (created_by_user_id → batch → files → rows) instead of trusting ids captured
 * in beforeAll, so a half-finished setup still cleans up to zero rows. Safe to
 * call with undefined / on a clean run (every step matches nothing).
 */
export async function deleteTestUser(userId: string | null | undefined): Promise<void> {
  if (!userId) return;

  const ownedBatches = await db
    .select({ id: uploadBatches.id })
    .from(uploadBatches)
    .where(eq(uploadBatches.createdByUserId, userId));
  const batchIds = ownedBatches.map((b) => b.id);

  if (batchIds.length > 0) {
    const ownedFiles = await db
      .select({ id: uploadedFiles.id })
      .from(uploadedFiles)
      .where(inArray(uploadedFiles.batchId, batchIds));
    const fileIds = ownedFiles.map((f) => f.id);

    if (fileIds.length > 0) {
      // FK-safe order: derived metrics → staging → errors/dupes → files.
      // import_phase_timings cascades when its uploaded_files row is deleted.
      await db.delete(keywordWeeklyMetrics).where(inArray(keywordWeeklyMetrics.sourceFileId, fileIds));
      await db.delete(reportingWeeks).where(inArray(reportingWeeks.sourceFileId, fileIds));
      await db.delete(stagingWeeklyMetrics).where(inArray(stagingWeeklyMetrics.uploadedFileId, fileIds));
      await db.delete(ingestionErrors).where(inArray(ingestionErrors.uploadedFileId, fileIds));
      await db
        .delete(importDuplicateSearchTerms)
        .where(inArray(importDuplicateSearchTerms.uploadedFileId, fileIds));
      await db.delete(uploadedFiles).where(inArray(uploadedFiles.id, fileIds));
    }
    // Staging rows linked to the batch but not to a (now-deleted) file — defensive.
    await db.delete(stagingWeeklyMetrics).where(inArray(stagingWeeklyMetrics.batchId, batchIds));
    await db.delete(uploadBatches).where(inArray(uploadBatches.id, batchIds));
  }

  // audit_log.user_id is a nullable restrict FK; clear this user's rows (if any).
  await db.delete(auditLog).where(eq(auditLog.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
}

// A regex bug here would mass-delete from prod, so refuse to act on an
// implausibly large match — warn instead. No legitimate run leaves this many.
const ORPHAN_SWEEP_SANITY_CAP = 5_000;

/**
 * Suite-wide backstop: delete every orphaned synthetic test user (and what it
 * owns), returning the emails removed. Per-test deleteTestUser is the primary
 * cleanup; this keeps the production users table at zero orphans even when a
 * run is killed mid-flight or a future test forgets to clean up.
 */
export async function sweepOrphanTestUsers(): Promise<string[]> {
  const rows = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(sql`${users.email} ~ ${TEST_USER_EMAIL_SQL_PATTERN}`);
  if (rows.length === 0) return [];
  if (rows.length > ORPHAN_SWEEP_SANITY_CAP) {
    throw new Error(
      `Orphan sweep matched ${rows.length} users (> ${ORPHAN_SWEEP_SANITY_CAP}); ` +
        `refusing to mass-delete. Check TEST_USER_EMAIL_SQL_PATTERN (${TEST_USER_EMAIL_SQL_PATTERN}).`,
    );
  }
  for (const r of rows) {
    await deleteTestUser(r.id);
  }
  return rows.map((r) => r.email);
}
