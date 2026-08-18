import { eq } from 'drizzle-orm';
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
   * True only when this call inserted the row — i.e. the user's genuine
   * first creation. Lets the webhook fire exactly-once side effects
   * (welcome email) that must not repeat on user.updated events or
   * Clerk webhook retries.
   */
  created: boolean;
}

export async function syncUserFromClerk(input: SyncUserInput): Promise<SyncUserResult> {
  const existing = await db.query.users.findFirst({
    where: eq(users.clerkUserId, input.clerkUserId),
  });

  if (existing) {
    const [updated] = await db
      .update(users)
      .set({
        email: input.email,
        name: input.name ?? existing.name,
      })
      .where(eq(users.clerkUserId, input.clerkUserId))
      .returning();
    return { user: updated, created: false };
  }

  const [inserted] = await db
    .insert(users)
    .values({
      clerkUserId: input.clerkUserId,
      email: input.email,
      name: input.name ?? null,
    })
    .returning();
  return { user: inserted, created: true };
}
