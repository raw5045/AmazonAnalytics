/**
 * Integration test for syncUserFromClerk against real Postgres — the SQL the
 * unit tests mock: the atomic upsert, the `created` marker (xmax = 0), the
 * concurrent race, the orphan re-link, and the stale-email refresh.
 *
 * Gated by RUN_INTEGRATION=1 like every integration test (runs against the
 * PRODUCTION database — see tests/integration/helpers.ts). Synthetic users
 * follow the harness conventions so the orphan sweep can always find them:
 * `itest_<epoch>@example.com` (example.com is rejected by isUndeliverableEmail,
 * so a leaked row can never receive a digest) and explicit afterAll cleanup.
 * Clerk is never called: every test passes a stub lookup.
 *
 * Run: RUN_INTEGRATION=1 pnpm vitest run tests/integration/syncUser.test.ts
 */
import { describe, it, expect, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { users } from '@/db/schema';
import { syncUserFromClerk, type SyncDeps } from '@/lib/auth/syncUser';
import { deleteTestUser } from './helpers';

const epoch = Date.now();
const id = (n: number) => `itest_${epoch + n}`;
const email = (n: number) => `itest_${epoch + n}@example.com`;

/** Every synthetic Clerk id is "gone" as far as Clerk is concerned. */
const clerkHasNobody: SyncDeps = { lookupClerkUser: async () => null };

describe('syncUserFromClerk (integration, real Postgres)', () => {
  const createdIds = new Set<string>();
  const track = <T extends { id: string }>(u: T): T => {
    createdIds.add(u.id);
    return u;
  };

  afterAll(async () => {
    for (const userId of createdIds) await deleteTestUser(userId);
  });

  it('inserts with created=true and a sign-in stamp; a repeat is an update with created=false that keeps the name', async () => {
    const first = await syncUserFromClerk({ clerkUserId: id(0), email: email(0), name: 'Itest One' }, clerkHasNobody);
    track(first.user);
    expect(first.created).toBe(true);
    expect(first.user.lastLoginAt).not.toBeNull();

    const again = await syncUserFromClerk({ clerkUserId: id(0), email: email(0), name: null }, clerkHasNobody);
    expect(again.created).toBe(false);
    expect(again.user.id).toBe(first.user.id);
    expect(again.user.name).toBe('Itest One'); // coalesce(excluded.name, users.name)
  });

  it('exactly one of two concurrent upserts for a new user reports created=true', async () => {
    const input = { clerkUserId: id(1), email: email(1), name: null };
    const [a, b] = await Promise.all([
      syncUserFromClerk(input, clerkHasNobody),
      syncUserFromClerk(input, clerkHasNobody),
    ]);
    track(a.user);
    track(b.user);
    expect(a.user.id).toBe(b.user.id);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
  });

  it('re-links an orphaned row (same email, Clerk id gone) to the new Clerk id, keeping its data', async () => {
    const orphan = await syncUserFromClerk({ clerkUserId: id(2), email: email(2), name: 'Orphan' }, clerkHasNobody);
    track(orphan.user);

    const relinked = await syncUserFromClerk({ clerkUserId: id(3), email: email(2), name: null }, clerkHasNobody);
    expect(relinked.created).toBe(false);
    expect(relinked.user.id).toBe(orphan.user.id);
    expect(relinked.user.clerkUserId).toBe(id(3));
    expect(relinked.user.role).toBe('standard_user');
    expect(relinked.user.name).toBe('Orphan');
  });

  it("refreshes the old row's email and inserts a fresh row when Clerk says the old user moved to a new address", async () => {
    const mover = await syncUserFromClerk({ clerkUserId: id(4), email: email(4), name: 'Mover' }, clerkHasNobody);
    track(mover.user);

    const clerkSaysMoved: SyncDeps = { lookupClerkUser: async () => ({ email: email(5) }) };
    const newcomer = await syncUserFromClerk({ clerkUserId: id(6), email: email(4), name: null }, clerkSaysMoved);
    track(newcomer.user);
    expect(newcomer.created).toBe(true);
    expect(newcomer.user.id).not.toBe(mover.user.id);
    expect(newcomer.user.email).toBe(email(4));

    const moved = await db.query.users.findFirst({ where: eq(users.id, mover.user.id) });
    expect(moved?.email).toBe(email(5));
    expect(moved?.clerkUserId).toBe(id(4)); // the mover keeps their identity and data
  });
});
