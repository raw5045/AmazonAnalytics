import { cache } from 'react';
import { auth, currentUser } from '@clerk/nextjs/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { users, type User } from '@/db/schema';
import { provisionUser } from './provisionUser';

/**
 * Resolve the signed-in app user from the Clerk session.
 *
 * Wrapped in React `cache()` so the per-request `users` lookup is deduplicated:
 * the (app) layout (via requireAuthenticatedUser) and the page both call this,
 * and without memoization that's two identical round-trips to Neon per load.
 * `cache()` is request-scoped — each request gets a fresh memo, no cross-request
 * sharing.
 *
 * Self-healing: the users row is normally created by the Clerk user.created
 * webhook, but a member's browser can reach the app before that webhook
 * lands (or after it failed). Without a row, the (app) layout used to redirect
 * to /sign-in, whose Clerk widget bounced the still-signed-in member straight
 * back — an endless /sign-in ↔ /explorer loop (beta report, 2026-09-16). Now a
 * confirmed Clerk session with no row provisions the row on the spot from
 * Clerk's user record; the webhook's later upsert is a harmless update.
 */
export const getCurrentUser = cache(async (): Promise<User | null> => {
  const { userId: clerkUserId } = await auth();
  if (!clerkUserId) return null;

  const existing = await db.query.users.findFirst({
    where: eq(users.clerkUserId, clerkUserId),
  });
  if (existing) return existing;

  const clerkUser = await currentUser();
  if (!clerkUser) return null; // session for a user Clerk no longer has (deleted mid-flight)

  const email =
    clerkUser.primaryEmailAddress?.emailAddress ?? clerkUser.emailAddresses[0]?.emailAddress ?? null;
  if (!email) {
    console.warn(`[getCurrentUser] Clerk user ${clerkUserId} has no email address — cannot provision an app user`);
    return null;
  }
  const name = [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(' ') || null;

  console.warn(`[getCurrentUser] no users row for ${clerkUserId} — provisioning on demand (webhook not landed yet?)`);
  const { user } = await provisionUser({ clerkUserId, email, name });
  return user;
});
