import { cache } from 'react';
import { auth } from '@clerk/nextjs/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { users, type User } from '@/db/schema';

/**
 * Resolve the signed-in app user from the Clerk session.
 *
 * Wrapped in React `cache()` so the per-request `users` lookup is deduplicated:
 * the (app) layout (via requireAuthenticatedUser) and the page both call this,
 * and without memoization that's two identical round-trips to Neon per load.
 * `cache()` is request-scoped — each request gets a fresh memo, no cross-request
 * sharing.
 */
export const getCurrentUser = cache(async (): Promise<User | null> => {
  const { userId: clerkUserId } = await auth();
  if (!clerkUserId) return null;
  const user = await db.query.users.findFirst({
    where: eq(users.clerkUserId, clerkUserId),
  });
  return user ?? null;
});
