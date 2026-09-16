import { cache } from 'react';
import { auth, currentUser } from '@clerk/nextjs/server';
import { isClerkAPIResponseError } from '@clerk/nextjs/errors';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { users, type User } from '@/db/schema';
import { AuthError } from './AuthError';
import { provisionUser } from './provisionUser';

/**
 * Resolve the signed-in app user from the Clerk session.
 *
 * Wrapped in React `cache()` so the per-request `users` lookup is deduplicated:
 * the (app) layout (via requireAuthenticatedUser) and the page both call this,
 * and without memoization that's two identical round-trips to Neon per load.
 * `cache()` is request-scoped — each request gets a fresh memo, no cross-request
 * sharing (and a passthrough outside a React render, e.g. route handlers).
 *
 * Self-healing: the users row is normally created by the Clerk user.created
 * webhook, but a member's browser can reach the app before that webhook lands
 * (or after it failed). Without a row, the (app) layout used to redirect to
 * /sign-in, whose Clerk widget bounced the still-signed-in member straight
 * back — an endless /sign-in ↔ /explorer loop (beta report, 2026-09-16). Now a
 * confirmed Clerk session with no row provisions the row on the spot from
 * Clerk's user record (welcome email deferred past the response); the
 * webhook's later upsert is a harmless update.
 *
 * Returns null only when there is no session. A session whose user cannot be
 * resolved or created throws AuthError('UNPROVISIONABLE'), which the layouts
 * render as a terminal sign-out screen rather than another bounce.
 */
export const getCurrentUser = cache(async (): Promise<User | null> => {
  const { userId: clerkUserId } = await auth();
  if (!clerkUserId) return null;

  const existing = await db.query.users.findFirst({
    where: eq(users.clerkUserId, clerkUserId),
  });
  if (existing) return existing;

  const clerkUser = await fetchClerkUser(clerkUserId);
  if (!clerkUser) {
    // A session JWT stays valid for up to ~60s after the Clerk user is deleted.
    throw new AuthError('UNPROVISIONABLE', 'This account no longer exists.');
  }

  // Same selection rule as the webhook's extractEmail (primary, else first) —
  // the upsert overwrites email on every sync, so the two callers must agree.
  const email =
    clerkUser.primaryEmailAddress?.emailAddress ?? clerkUser.emailAddresses[0]?.emailAddress ?? null;
  if (!email) {
    console.warn(`[getCurrentUser] Clerk user ${clerkUserId} has no email address — cannot provision an app user`);
    throw new AuthError('UNPROVISIONABLE', 'This account has no email address.');
  }
  const name = [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(' ') || null;

  console.warn(`[getCurrentUser] no users row for ${clerkUserId} — provisioning on demand (webhook not landed yet?)`);
  const { user } = await provisionUser({ clerkUserId, email, name }, { welcome: 'after' });
  return user;
});

/**
 * Clerk's currentUser() throws a 404 (it does not return null) when the
 * session's user no longer exists; map that to null and surface everything
 * else (429/5xx/network) as an error rather than a silent sign-out.
 */
async function fetchClerkUser(clerkUserId: string) {
  try {
    return await currentUser();
  } catch (e) {
    if (isClerkAPIResponseError(e) && e.status === 404) return null;
    console.error(`[getCurrentUser] Clerk lookup failed for ${clerkUserId}:`, e);
    throw e;
  }
}
