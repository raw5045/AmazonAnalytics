import { and, eq, getTableColumns, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { users, type User } from '@/db/schema';

export interface SyncUserInput {
  clerkUserId: string;
  /** Primary email, else the first one — both callers (webhook, on-demand) pick the same way. */
  email: string;
  name?: string | null;
}

export interface SyncUserResult {
  user: User;
  /**
   * True only when THIS call inserted the row — the user's genuine first
   * creation. Drives exactly-once side effects (the welcome email in
   * provisionUser) across webhook retries, user.updated events, and the
   * on-demand provisioning path racing the webhook.
   */
  created: boolean;
}

/** Injectable Clerk lookup so the conflict path is testable without Clerk. */
export interface SyncDeps {
  /**
   * The current primary (else first) email of a Clerk user, or null when Clerk
   * has no such user (404). Any other failure throws.
   */
  lookupClerkUser: (clerkUserId: string) => Promise<{ email: string | null } | null>;
}

export const defaultSyncDeps: SyncDeps = {
  async lookupClerkUser(clerkUserId) {
    // Dynamic imports keep Clerk's server bundle out of module graphs that
    // never reach this path (the Railway worker, unit tests).
    const [{ clerkClient }, { isClerkAPIResponseError }] = await Promise.all([
      import('@clerk/nextjs/server'),
      import('@clerk/nextjs/errors'),
    ]);
    try {
      const u = await (await clerkClient()).users.getUser(clerkUserId);
      return { email: u.primaryEmailAddress?.emailAddress ?? u.emailAddresses[0]?.emailAddress ?? null };
    } catch (e) {
      if (isClerkAPIResponseError(e) && e.status === 404) return null;
      throw e;
    }
  },
};

/**
 * Upsert the app user row for a Clerk user, atomically, and report whether
 * this call inserted it.
 *
 * Two callers can race for the same row: the Clerk `user.created` webhook
 * and getCurrentUser's on-demand path (a member whose browser reached the
 * app before the webhook landed). INSERT … ON CONFLICT (clerk_user_id) DO
 * UPDATE lets both run concurrently: exactly one inserts (`created` = true),
 * the other updates. `xmax = 0` in RETURNING is the standard Postgres tell
 * for "this row was inserted, not updated".
 *
 * A fresh row is stamped last_login_at = now(): a user who just signed up is
 * signed in, and the session.created webhook that would otherwise stamp it
 * can arrive before the row exists (it silently no-ops on unknown ids).
 */
export async function syncUserFromClerk(
  input: SyncUserInput,
  deps: SyncDeps = defaultSyncDeps,
): Promise<SyncUserResult> {
  if (!input.email) throw new Error('syncUserFromClerk: email is required');
  try {
    return await upsert(input);
  } catch (e) {
    if (!isEmailUniqueViolation(e)) throw e;
    return await resolveEmailConflict(input, deps, e);
  }
}

async function upsert(input: SyncUserInput): Promise<SyncUserResult> {
  const [row] = await db
    .insert(users)
    .values({
      clerkUserId: input.clerkUserId,
      email: input.email,
      name: input.name ?? null,
      lastLoginAt: new Date(),
    })
    .onConflictDoUpdate({
      target: users.clerkUserId,
      set: { email: sql`excluded.email`, name: sql`coalesce(excluded.name, ${users.name})` },
    })
    .returning({ ...getTableColumns(users), created: sql<boolean>`(xmax = 0)`.as('created') });
  const { created, ...user } = row;
  return { user, created };
}

/**
 * Another row holds this email under a different clerk_user_id. Two honest
 * explanations, told apart by asking Clerk about the OLD id:
 *
 *   - Clerk has no such user (404): the old account was deleted and our
 *     user.deleted webhook never cleaned up → the row is orphaned. Re-link it
 *     to the live Clerk id — the member keeps their watchlist, saved views and
 *     custom categories — but never their role: privilege must not travel.
 *   - Clerk still has the user, now under a different address: they changed
 *     email and we missed user.updated. Refresh our copy of THEIR email so the
 *     address frees up, then retry the insert once for the newcomer.
 *   - Anything else (Clerk says the old user still holds this address, the
 *     lookup fails, no row found): rethrow the original error — the caller
 *     retries later (Svix for the webhook, the next page load on demand).
 *
 * Without the Clerk check, "the address is free in Clerk" would be misread
 * as "the old id is dead", and a newcomer signing up with someone's OLD
 * address could inherit that person's account.
 */
async function resolveEmailConflict(
  input: SyncUserInput,
  deps: SyncDeps,
  original: unknown,
): Promise<SyncUserResult> {
  const stale = await db.query.users.findFirst({ where: eq(users.email, input.email) });
  if (!stale || stale.clerkUserId === input.clerkUserId) throw original;

  let clerkView: { email: string | null } | null;
  try {
    clerkView = await deps.lookupClerkUser(stale.clerkUserId);
  } catch (e) {
    console.error(`[syncUser] Clerk lookup failed for ${stale.clerkUserId} while resolving an email conflict:`, e);
    throw original;
  }

  if (clerkView === null) {
    const [relinked] = await db
      .update(users)
      .set({
        clerkUserId: input.clerkUserId,
        role: 'standard_user',
        lastLoginAt: new Date(),
        ...(input.name ? { name: input.name } : {}),
      })
      .where(and(eq(users.id, stale.id), eq(users.clerkUserId, stale.clerkUserId)))
      .returning();
    if (!relinked) throw original;
    console.warn(
      `[syncUser] re-linked orphaned users row ${stale.id} from dead Clerk id ${stale.clerkUserId} to ${input.clerkUserId}`,
    );
    return { user: relinked, created: false };
  }

  if (clerkView.email && clerkView.email !== input.email) {
    await db.update(users).set({ email: clerkView.email }).where(eq(users.id, stale.id)).returning();
    console.warn(
      `[syncUser] refreshed stale email on users row ${stale.id} (Clerk id ${stale.clerkUserId}); retrying insert for ${input.clerkUserId}`,
    );
    return await upsert(input);
  }

  throw original;
}

/**
 * Postgres unique_violation (23505) on the email index — inspected on the
 * error itself and on `cause`, since Drizzle wraps driver errors.
 */
function isEmailUniqueViolation(e: unknown): boolean {
  for (const err of [e, (e as { cause?: unknown } | null)?.cause]) {
    if (!err || typeof err !== 'object') continue;
    const { code, constraint, detail, message } = err as {
      code?: unknown;
      constraint?: unknown;
      detail?: unknown;
      message?: unknown;
    };
    if (code !== '23505') continue;
    const text = `${constraint ?? ''} ${detail ?? ''} ${message ?? ''}`;
    if (text.includes('users_email_idx') || text.includes('(email)')) return true;
  }
  return false;
}
