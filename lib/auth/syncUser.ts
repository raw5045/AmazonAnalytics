import { eq, getTableColumns, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { users, type User } from '@/db/schema';

export interface SyncUserInput {
  clerkUserId: string;
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
export async function syncUserFromClerk(input: SyncUserInput): Promise<SyncUserResult> {
  try {
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
  } catch (e) {
    if (!isEmailUniqueViolation(e)) throw e;
    // A row already holds this email under a different clerk_user_id. Clerk
    // enforces unique emails across its users, so that Clerk id is dead (the
    // Clerk user was deleted before our user.deleted webhook could clean up)
    // and the row is orphaned. Re-link it to the live Clerk id instead of
    // failing every insert forever — which, from the member's side, was an
    // endless /sign-in ↔ /explorer loop. They keep their watchlist, saved
    // views, and custom categories.
    const [relinked] = await db
      .update(users)
      .set(
        input.name
          ? { clerkUserId: input.clerkUserId, name: input.name, lastLoginAt: new Date() }
          : { clerkUserId: input.clerkUserId, lastLoginAt: new Date() },
      )
      .where(eq(users.email, input.email))
      .returning();
    if (!relinked) throw e;
    console.warn(`[syncUser] re-linked orphaned users row for ${input.email} to ${input.clerkUserId}`);
    return { user: relinked, created: false };
  }
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
